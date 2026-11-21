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
import uuid


MODEL_ID = "diagnostic"
CONFIG_SENTINEL = "PRIVATE_BROKEN_CONFIG_VALUE"
SETUP_REPORT_PROMPT = "这是 /taskbook-setup 的普通对话"
MODEL_APPROVAL = "保存这组角色模型。"
MODEL_POLICY = "key\tvalue\nmodelConfig\t.fact/config/models.tsv\nmodelGitTracking\tfalse\n"
MODEL_RECHECK = "重查新增模型，然后写入。"
MODEL_TSV = "role\tmodel\tthinking\ndesign\tsetup-fixture/new-model\t\n"


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
        latest = request["messages"][-1]
        content = latest.get("content", "")
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content)
        delta = {"content": "Setup report generated"}
        reason = "stop"
        if content == MODEL_RECHECK:
            delta = self.call("taskbook_model_catalog", {}, "catalog")
            reason = "tool_calls"
        elif latest.get("tool_call_id") == "catalog" and "setup-fixture/new-model" in str(latest):
            delta = self.call("taskbook_model_setup", {
                "configuration": MODEL_TSV,
                "approvedBy": [MODEL_APPROVAL, MODEL_RECHECK],
            }, "save")
            reason = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        finish = [
            {"delta": {"role": "assistant", **delta}, "finish_reason": None},
            {"delta": {}, "finish_reason": reason},
        ]
        for event in finish:
            chunk = {"id": "setup-fixture", "object": "chat.completion.chunk",
                     "created": 1, "model": MODEL_ID, "choices": [{"index": 0, **event}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")

    @staticmethod
    def call(name, args, call_id):
        return {"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}


def test_setup_resume(repo, root, config, model):
    session = str(uuid.uuid4())
    env = {"PATH": os.environ["PATH"], "HOME": str(config.parent), "PI_CODING_AGENT_DIR": str(config),
           "T3_MCP_URL": "https://t3.test.invalid/mcp", "T3_MCP_BEARER_TOKEN": "fixture-token"}
    pi = os.getenv("PI_BIN") or shutil.which("pi")

    def run_prompt(message, update_models=None):
        with subprocess.Popen([pi, "--mode", "rpc", "--offline", "--no-mcp", "--no-approve", "--no-skills",
                               "--no-context-files", "--session-id", session, "--provider", "setup-fixture", "--model",
                               MODEL_ID, "-e", str(repo / "index.ts")], cwd=root, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
            events = queue.Queue()
            def read_events():
                for line in process.stdout:
                    events.put(line)

            threading.Thread(target=read_events, daemon=True).start()

            def send(**command):
                process.stdin.write(json.dumps(command) + "\n")
                process.stdin.flush()

            try:
                if update_models:
                    send(type="get_available_models")
                    loaded = json.loads(events.get(timeout=10))
                    assert loaded["success"] and "new-model" not in str(loaded)
                    update_models()
                send(type="prompt", message=message)
                first = model.requests.get(timeout=10)
                observed = []
                while True:
                    event = json.loads(events.get(timeout=10))
                    if event["type"] in ("tool_execution_end", "agent_end"):
                        observed.append(event)
                    if event["type"] == "agent_end":
                        break
                return first, json.dumps(observed, ensure_ascii=False)
            finally:
                process.stdin.close()
                process.wait(timeout=5)

    (root / ".fact").mkdir()
    (root / ".fact/taskbook.tsv").write_text(MODEL_POLICY)
    (root / ".fact/always.tsv").write_text("id\tfact\tsource\tlabels\nfixture\tAlways inject this fixture rule.\tfixture\t\n")
    first, output = run_prompt("/taskbook-setup " + MODEL_APPROVAL)
    assert "Always inject this fixture rule." in str(first["messages"])
    assert "stagedOrTracked" not in str(first["messages"])
    assert "Setup report generated" in output, output[-1200:]
    assert "t3.test.invalid" not in output
    assert not (root / ".fact/config/models.tsv").exists()

    models_file = config / "models.json"
    def add_model():
        model_config = json.loads(models_file.read_text())
        model_config["providers"]["setup-fixture"]["models"].append({"id": "new-model"})
        models_file.write_text(json.dumps(model_config))

    request, output = run_prompt(MODEL_RECHECK, update_models=add_model)
    tools = {tool["function"]["name"] for tool in request["tools"]}
    assert {"taskbook_model_catalog", "taskbook_model_setup", "taskbook_migrate"} <= tools
    assert "cannot be invoked" in json.dumps(request["messages"])
    assert "Always inject this fixture rule." in str(request["messages"])
    assert (root / ".fact/config/models.tsv").is_file(), output[-2000:]
    assert (root / ".fact/config/models.tsv").read_text() == MODEL_TSV
    assert not (root / ".fact/models.tsv").exists()
    assert not (root / ".fact/facts.tsv").exists()
    assert not (root / "GLOSSARY.md").exists()
    assert "project-local" in output
    assert subprocess.check_output(["git", "show", ":.fact/taskbook.tsv"], cwd=root, text=True) == MODEL_POLICY
    subprocess.run(["git", "check-ignore", "-q", ".fact/config/models.tsv"], cwd=root, check=True)


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
        return json.loads(reports[0].split("\n\n## Runtime diagnostics\n", 1)[1])
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
            assert "design\tsetup-fixture/diagnostic\t" in proposed
            assert missing["readiness"] == {"runnable": True, "taskbookNew": False, "initialized": False, "blockers": []}
            assert "facts" not in missing["repository"] and "glossary" not in missing["repository"]
            assert missing["models"]["savePolicy"] == {"path": ".fact/models.tsv", "gitTracking": False, "source": "default"}
            assert not (root / ".fact/facts.tsv").exists() and not (root / "GLOSSARY.md").exists()
            assert missing["mcp"]["magpie"]["capabilities"]["memory_search"]["status"] == "unconfirmed"
            assert missing["t3"]["status"] == "missing" and not missing["t3"]["worktree"]

            models = config.parent / ".agents"
            models.mkdir()
            pstack = "judgment and prose: setup-fixture/diagnostic\n"
            (models / "pstack-models.md").write_text(pstack)
            role_file = models / "taskbook-models.tsv"
            role_file.write_text(proposed)
            (root / ".fact").mkdir()
            (root / "docs/agents").mkdir(parents=True)
            (root / "docs/agents/issue-tracker.md").write_text("Use gh issue create, gh issue comment, and gh issue close.")
            (root / ".audit").mkdir()
            (root / ".audit/unknown.txt").write_text("unclassified material")
            describe_servers("magpie", "forge")
            valid = setup_report(repo, root, config, model, mcp_log, ["magpie", "forge"])
            assert valid["readiness"] == {"runnable": True, "taskbookNew": False, "initialized": True, "blockers": []}
            assert valid["models"]["pstack"]["content"] == pstack
            assert valid["legacy"]["status"] == "ready"
            assert any(item["path"] == ".audit/unknown.txt" for item in valid["repository"]["audit"]["unresolved"])
            assert all(item["status"] == "discovered" for item in valid["mcp"]["magpie"]["capabilities"].values()), valid["mcp"]
            github = valid["mcp"]["github"]
            assert github["services"] == ["forge"]
            assert all(item["status"] == "discovered" for item in github["read"].values())
            assert github["read"]["repositoryContents"]["tools"][0]["name"] == "mcp__forge__github__get_file_contents"
            assert all(item["status"] == "discovered" for item in github["write"].values())
            assert github["declaredAlternative"] == "gh"

            role_file.write_text(CONFIG_SENTINEL)
            describe_servers("reduced-memory", "reduced-forge")
            invalid = setup_report(repo, root, config, model, mcp_log, ["reduced-memory", "reduced-forge"])
            assert invalid["models"]["file"]["status"] == "invalid"
            assert invalid["readiness"]["blockers"] == ["modelRoutes"]
            assert invalid["mcp"]["magpie"]["capabilities"]["memory_forget"]["status"] == "missing"
            github = invalid["mcp"]["github"]
            assert github["read"]["repositoryContents"]["status"] == "missing"
            assert github["read"]["issueReadOrSearch"]["status"] == "missing"
            assert github["read"]["pullRequestMetadata"]["tools"][0]["name"] == "mcp__reduced_forge__get_pull_request"
            assert github["read"]["pullRequestDiff"]["tools"][0]["name"] == "mcp__reduced_forge__get_pr_diff"
            assert github["write"]["issueCreate"]["status"] == "discovered"
            assert github["write"]["issueComment"]["status"] == "missing"
            assert github["write"]["issueClose"]["status"] == "missing"
            model.requests = queue.Queue()
            resumed_root = fixture / "resumed"
            subprocess.run(["git", "init", "-q", str(resumed_root)], check=True)
            test_setup_resume(repo, resumed_root, config, model)
        finally:
            model.shutdown()
            model.server_close()
    print("Pi setup RPC passed: read-only diagnostics, resumed approval, live model refresh, local TSV write")


if __name__ == "__main__":
    if len(sys.argv) == 3:
        run_mcp_fixture(*sys.argv[1:])
    else:
        test_setup()
