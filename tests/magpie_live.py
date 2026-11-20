"""Opt-in read-only MCP tool discovery against an isolated Magpie CLI on Linux."""
import argparse
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = r"""
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = process.cwd();
const discovery = {};
for (const name of ["memory_context", "memory_search", "memory_save", "memory_forget"]) {
  const result = execFileSync("magpie", ["tools", name], {cwd:root, encoding:"utf8"});
  assert.ok(result.startsWith(name));
  discovery[name] = result.split("\n").map(line => /^  --([a-z_]+)/.exec(line)?.[1]).filter(Boolean);
}
assert.ok(discovery.memory_search.includes("limit"));
assert.ok(discovery.memory_save.includes("id"));
assert.ok(discovery.memory_forget.includes("id"));
assert.ok(!discovery.memory_save.includes("if_version"));
assert.ok(!discovery.memory_forget.includes("if_version"));
console.log(JSON.stringify({discovery}));
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
            subprocess.run([node, "--input-type=module", "-e", SCRIPT], cwd=project, timeout=70, check=True)
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
