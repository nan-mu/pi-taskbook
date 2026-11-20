"""Exercise /taskbook-setup with Pi 1.5.2 and isolated model and MCP fixtures."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time


MODEL_ID = "diagnostic"
CONFIG_SENTINEL = "PRIVATE_BROKEN_CONFIG_VALUE"
SETUP_REPORT_PROMPT = "这是 /taskbook-setup 的普通对话"


def run_mcp_fixture(path, profile):
    tools = {
        "magpie": ["memory_context", "memory_search", "memory_save", "memory_forget"],
        "forge": ["get_file_contents", "search_issues", "pull_request_read", "issue_write", "add_issue_comment"],
        "reduced-memory": ["memory_context", "memory_search", "memory_save"],
        "reduced-forge": ["get_pr_diff", "get_pull_request", "create_issue"],
    }[profile]
    operations = {
        "pull_request_read": ["get", "get_files"],
        "issue_write": ["create", "update"],
    }
    for line in sys.stdin:
        request = json.loads(line)
        method = request["method"]
        with Path(path).open("a") as log:
            log.write(f"{profile} {method}\n")
        if "id" not in request:
            continue
        if method == "initialize":
            result = {
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": profile, "version": "1.0.0"},
            }
        elif method == "tools/list":
            result = {"tools": [{
                "name": "github__" + name if profile == "forge" else name,
                "description": name,
                "inputSchema": {"type": "object", "properties": {
                    "method": {"type": "string", "enum": operations[name]},
                } if name in operations else {}},
            } for name in tools]}
        else:
            raise AssertionError(f"Setup issued an MCP call: {method}")
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


class SetupModel(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.put(request)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        finish = [
            {"delta": {"role": "assistant", "content": "Setup report generated"}, "finish_reason": None},
            {"delta": {}, "finish_reason": "stop"},
        ]
        for event in finish:
            chunk = {"id": "setup-fixture", "object": "chat.completion.chunk",
                     "created": 1, "model": MODEL_ID, "choices": [{"index": 0, **event}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")


def read_repository(root):
    paths = [path for path in root.rglob("*") if path.is_file() and ".git" not in path.relative_to(root).parts]
    files = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    refs = subprocess.check_output(["git", "-C", str(root), "for-each-ref", "--format=%(refname) %(objectname)"])
    return files, refs


def setup_report(repo, root, config, model, mcp_log, profiles):
    before = read_repository(root)
    env = {"PATH": os.environ["PATH"], "HOME": str(config.parent), "PI_CODING_AGENT_DIR": str(config)}
    pi = os.getenv("PI_BIN") or shutil.which("pi")
    if not pi:
        raise SystemExit("Set PI_BIN to Pi 1.5.2.")
    process = subprocess.Popen(
        [pi, "--mode", "rpc", "--offline", "--no-approve", "--no-skills",
         "--no-context-files", "--no-session", "--provider", "setup-fixture", "--model", MODEL_ID,
         "-e", str(repo / "index.ts")],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        # The ready catalog is registered asynchronously at Pi session start.
        deadline = time.monotonic() + 5
        marks = {f"{profile} tools/list" for profile in profiles}
        while marks and time.monotonic() < deadline:
            if mcp_log.exists() and marks <= set(mcp_log.read_text().splitlines()):
                time.sleep(.1)
                break
            time.sleep(.02)
        process.stdin.write(json.dumps({"type": "prompt", "message": "/taskbook-setup"}) + "\n")
        process.stdin.flush()
        request = model.requests.get(timeout=10)
        response, errors = process.communicate(timeout=5)
        assert SETUP_REPORT_PROMPT in json.dumps(request["messages"], ensure_ascii=False)
        available = [tool["function"]["name"] for tool in request.get("tools", [])]
        assert "read" in available, available
        assert CONFIG_SENTINEL not in response and CONFIG_SENTINEL not in json.dumps(request)
        reports = [event["message"]["content"] for line in response.splitlines() if line.startswith("{")
                   for event in [json.loads(line)] if event.get("type") == "message_end" and
                   event.get("message", {}).get("customType") == "pi-taskbook-setup"]
        if not reports:
            reports = [message["content"] for line in response.splitlines() if line.startswith("{")
                       for event in [json.loads(line)] if event.get("type") == "agent_end"
                       for message in event.get("messages", []) if message.get("customType") == "pi-taskbook-setup"]
        assert reports, (response[-2000:], errors[-2000:])
        assert before == read_repository(root), "Setup changed project files or refs"
        if mcp_log.exists():
            assert not any(line.endswith("tools/call") for line in mcp_log.read_text().splitlines())
        return json.loads(reports[0].split("\n\n", 1)[1])
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)


def test_setup():
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="pi-taskbook-setup-") as temporary:
        fixture = Path(temporary)
        root = fixture / "repository"
        config = fixture / "pi"
        root.mkdir()
        config.mkdir()
        mcp_log = fixture / "mcp.log"
        subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(root), "remote", "add", "origin", "git@github.com:fixture/repo.git"], check=True)
        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SetupModel)
        model.requests = queue.Queue()
        threading.Thread(target=model.serve_forever, daemon=True).start()
        (config / "models.json").write_text(json.dumps({"providers": {"setup-fixture": {
            "baseUrl": f"http://127.0.0.1:{model.server_port}/v1", "api": "openai-completions",
            "apiKey": "fixture", "models": [{"id": MODEL_ID}],
        }}}))

        def describe_servers(*profiles, unavailable=False):
            mcp_log.unlink(missing_ok=True)
            servers = {profile: {"command": sys.executable, "args": [__file__, str(mcp_log), profile],
                                 "exposure": "direct"} for profile in profiles}
            if unavailable:
                servers["magpie-unavailable"] = {"command": str(fixture / "missing-server")}
            (config / "mcp.json").write_text(json.dumps({"mcpServers": servers}))

        try:
            describe_servers(unavailable=True)
            missing = setup_report(repo, root, config, model, mcp_log, [])
            assert missing["models"]["file"]["status"] == "missing"
            assert missing["models"]["effective"]["status"] == "fallback"
            proposed = missing["models"]["initialization"]["content"]
            assert "design: setup-fixture/diagnostic" in proposed
            assert missing["readiness"] == {"runnable": True, "taskbookNew": False, "initialized": False, "blockers": []}
            assert missing["repository"]["facts"]["status"] == "missing"
            assert missing["repository"]["glossary"]["path"] == "GLOSSARY.md"
            assert missing["mcp"]["magpie"]["capabilities"]["memory_search"]["status"] == "unconfirmed"
            assert missing["t3"]["status"] == "missing" and not missing["t3"]["worktree"]

            models = config.parent / ".agents"
            models.mkdir()
            pstack = "judgment and prose: setup-fixture/diagnostic\n"
            (models / "pstack-models.md").write_text(pstack)
            role_file = models / "taskbook-models.md"
            role_file.write_text(proposed)
            (root / ".fact").mkdir()
            (root / ".fact/facts.tsv").write_text(missing["repository"]["facts"]["initialization"]["content"])
            (root / "docs/agents").mkdir(parents=True)
            (root / "docs/agents/domain.md").write_text("The glossary lives at `docs/terms.md`.\n")
            (root / "docs/terms.md").write_text("# Glossary\n")
            (root / "docs/agents/issue-tracker.md").write_text("Use gh issue create, gh issue comment, and gh issue close.")
            (root / ".audit").mkdir()
            (root / ".audit/unknown.txt").write_text("unclassified material")
            describe_servers("magpie", "forge")
            valid = setup_report(repo, root, config, model, mcp_log, ["magpie", "forge"])
            assert valid["readiness"] == {"runnable": True, "taskbookNew": False, "initialized": True, "blockers": []}
            assert valid["repository"]["glossary"]["path"] == "docs/terms.md"
            assert "checkpoints" not in valid["repository"]["exclusions"]
            assert valid["models"]["pstack"]["content"] == pstack
            assert valid["legacy"]["audit"]["status"] == "ready"
            assert any(item["source"] == ".audit/unknown.txt" for item in valid["legacy"]["facts"]["unresolved"])
            assert all(item["status"] == "discovered" for item in valid["mcp"]["magpie"]["capabilities"].values()), valid["mcp"]
            github = valid["mcp"]["github"]
            assert github["services"] == ["forge"]
            assert all(item["status"] == "discovered" for item in github["read"].values())
            assert github["read"]["repositoryContents"]["tools"][0]["name"] == "mcp__forge__github__get_file_contents"
            assert all(item["status"] == "discovered" for item in github["write"].values())
            assert github["declaredAlternative"] == "gh"

            legacy = root / ".fact/project.json"
            legacy.write_text(json.dumps({"schema": 1, "records": {}, "applied": {}}))
            needs_migration = setup_report(repo, root, config, model, mcp_log, ["magpie", "forge"])
            assert needs_migration["repository"]["facts"]["status"] == "migration-required"
            assert needs_migration["readiness"]["blockers"] == ["projectFactsMigration"]
            assert not needs_migration["readiness"]["runnable"]
            legacy.unlink()

            role_file.write_text(CONFIG_SENTINEL)
            (root / ".fact/facts.tsv").write_text(CONFIG_SENTINEL)
            (root / "docs/terms.md").write_bytes(b"unterminated\xff")
            describe_servers("reduced-memory", "reduced-forge")
            invalid = setup_report(repo, root, config, model, mcp_log, ["reduced-memory", "reduced-forge"])
            assert invalid["models"]["file"]["status"] == "invalid"
            assert invalid["repository"]["facts"]["status"] == "invalid"
            assert invalid["repository"]["glossary"]["status"] == "invalid"
            assert invalid["readiness"]["blockers"] == ["modelRoutes", "projectFactsFormat", "glossaryFormat"]
            assert invalid["mcp"]["magpie"]["capabilities"]["memory_forget"]["status"] == "missing"
            github = invalid["mcp"]["github"]
            assert github["read"]["repositoryContents"]["status"] == "missing"
            assert github["read"]["issueReadOrSearch"]["status"] == "missing"
            assert github["read"]["pullRequestMetadata"]["tools"][0]["name"] == "mcp__reduced_forge__get_pull_request"
            assert github["read"]["pullRequestDiff"]["tools"][0]["name"] == "mcp__reduced_forge__get_pr_diff"
            assert github["write"]["issueCreate"]["status"] == "discovered"
            assert github["write"]["issueComment"]["status"] == "missing"
            assert github["write"]["issueClose"]["status"] == "missing"
        finally:
            model.shutdown()
            model.server_close()
    print("Pi setup RPC: missing, valid and damaged configuration, four Magpie capabilities, GitHub aliases, no writes")


if __name__ == "__main__":
    if len(sys.argv) == 3:
        run_mcp_fixture(*sys.argv[1:])
    else:
        test_setup()
