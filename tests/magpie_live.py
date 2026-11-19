"""Opt-in Linux integration test against an installed Magpie CLI. Uses only synthetic memory."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = """
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { applyApprovedMemory, readProjectMemory } from PROJECT_MEMORY;
import { syncMagpieMemory, recallMagpieMemory } from MAGPIE_MEMORY;

const root = process.cwd();
const firstText = "Fixture testers prefer independent evidence.";
const corrected = "Fixture testers prefer two independent observations.";
const apply = (action, expected, text) => {
  const digest = "fixture-" + (expected + 1);
  applyApprovedMemory(root, readProjectMemory(root), {id:"fixture", repository:"isolated/example", digest}, "base",
    [{action, key:"evidence", expected, kind:"fact", scope:"cross-project:preference", text, authorization:"explicit synthetic request"}],
    [{claim:"Fixture scope", observed:"yes", origin:"fixture", source:{kind:"git", path:"fixture", line:1}}],
    {role:"fact-review", verdict:"pass", sessionId:"fixture-review", items:[{id:"P1",status:"pass",memoryUse:"change-evidence"},{id:"M1",status:"pass"}]});
  return digest;
};
function userChanges(name, args) {
  const response = execFileSync("magpie", ["tool", name, "--json", ...args], {cwd:root, encoding:"utf8"});
  const result = JSON.parse(response);
  assert.ok(!result.isError);
  return result.content[0].text;
}
const created = apply("create",0,firstText);
const first = await syncMagpieMemory(root,created);
const replay = await syncMagpieMemory(root,created);
assert.deepEqual(first,{published:1,confirmed:0});
assert.deepEqual(replay,{published:0,confirmed:1});
const recall = await recallMagpieMemory(root,"evidence");
assert.equal(recall.status,"available");
const row = recall.results.flatMap(text => text.split("\\n")).find(line => line.includes(firstText));
assert.ok(row);
const id = /^\\[([^\\]]+)\\]/.exec(row)[1];
const tag = /#(pi-[a-f0-9]{24})/.exec(row)[1];
const updated = apply("update",1,corrected);
await assert.rejects(syncMagpieMemory(root, updated), err => err.message.includes("远端 ID " + id));
const manualEdit = userChanges("memory_save", ["--id=" + id, "--text=" + corrected + " [" + tag + "]"]);
assert.ok(manualEdit.startsWith("Changed: [" + id + "]"));
assert.equal((await syncMagpieMemory(root, updated)).confirmed, 1);
const retired = apply("delete",2,"The fixture user retired this statement.");
await assert.rejects(syncMagpieMemory(root, retired), err => err.message.includes("远端 ID " + id));
assert.ok(userChanges("memory_forget",["--id=" + id]).startsWith("Forgotten: [" + id + "]"));
assert.equal((await syncMagpieMemory(root, retired)).confirmed, 1);
console.log(JSON.stringify({created:1,replayed:1,recalled:1,editBlocked:1,userEditConfirmed:1,
  withdrawalBlocked:1,archiveConfirmedAbsent:1}));
"""


def isolated(cli, node):
    directory = Path(tempfile.mkdtemp())
    (directory / "magpie").symlink_to(cli)
    os.environ["PATH"] = str(directory) + os.pathsep + "/usr/bin:/bin"
    # Both the listener and the CLI use this one address. Personal gateway configuration is absent.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        address = probe.getsockname()
    hostport = "%s:%d" % address
    os.environ.update(MAGPIE_ADDR=hostport, MAGPIE_GATEWAY="http://" + hostport,
                      HTTPS_PROXY="http://127.0.0.1:1", HTTP_PROXY="http://127.0.0.1:1", NO_PROXY="127.0.0.1")
    project = directory / "repo"
    project.mkdir()
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    with tempfile.TemporaryFile() as log:
        service = subprocess.Popen([cli, "serve"], cwd=project, stderr=log, stdout=log)
        try:
            for _ in range(60):
                if service.poll() is not None:
                    raise RuntimeError("The isolated Magpie server stopped before the test.")
                try:
                    with socket.create_connection(address, timeout=0.3):
                        break
                except OSError:
                    time.sleep(0.15)
            else:
                raise RuntimeError("The isolated Magpie server did not listen on its test port.")
            script = SCRIPT.replace("PROJECT_MEMORY", json.dumps((ROOT / "project-memory.ts").as_uri()))
            script = script.replace("MAGPIE_MEMORY", json.dumps((ROOT / "magpie-memory.ts").as_uri()))
            subprocess.run([node, "--input-type=module", "-e", script], cwd=project, timeout=70, check=True)
        finally:
            service.terminate()
            try:
                service.wait(timeout=8)
            except subprocess.TimeoutExpired:
                service.kill()
                service.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--isolated-cli", required=True, type=Path, help="Path to a Linux magpie or magpie-cli binary.")
    args = parser.parse_args()
    cli = str(args.isolated_cli.resolve(strict=True))
    node = shutil.which("node")
    if sys.platform != "linux" or not shutil.which("bwrap") or not node:
        parser.error("This opt-in test requires Linux, bwrap, git and Node 22.19+.")
    home = str(Path.home())
    # Cover real home and /tmp. Project, binary and interpreter are separately
    # mounted read-only, including when one lives under the user's home.
    launch = "import runpy; runpy.run_path('/tmp/pi-src/tests/magpie_live.py')['isolated']('/tmp/pi-magpie', '/tmp/pi-node')"
    command = ["bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--tmpfs", home, "--tmpfs", "/tmp",
               "--ro-bind", str(ROOT), "/tmp/pi-src", "--ro-bind", cli, "/tmp/pi-magpie",
               "--ro-bind", os.path.realpath(node), "/tmp/pi-node", "--dev", "/dev", "--proc", "/proc", "--clearenv",
               "--setenv", "HOME", home, "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "MAGPIE_NO_ACCOUNTS", "1",
               "--", "/usr/bin/python3", "-c", launch]
    subprocess.run(command, timeout=95, check=True)


if __name__ == "__main__":
    main()
