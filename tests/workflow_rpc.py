import http.server
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

# Run with Python 3 and Pi 1.5.2 on PATH (or set PI_BIN).
repo = Path(os.getenv("PI_TASKBOOK_REPO", Path(__file__).resolve().parents[1])).resolve()
pi = os.getenv("PI_BIN") or shutil.which("pi")
if not pi:
    raise SystemExit("Set PI_BIN to the Pi executable, or install pi on PATH.")
pi = Path(pi).resolve()
attempts = {}
seen_receipts = {}

requests = []
launches = []
cancel_started = threading.Event()
cancel_end = threading.Event()
interrupted = set()
errors = queue.Queue()

def tool_call(name, arguments):
    return {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_" + uuid.uuid4().hex,
            "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}]}


sample_program = """import sys

if len(sys.argv) == 1:
    print("missing measurement")
    raise SystemExit(4)
print("measurement=" + sys.argv[1])
"""

def fact_report(state):
    return dict(attempt=state["attempt"], outcome="pass", summary="The measurement command has an explicit missing-input branch.",
                evidence=[], factChecks=[dict(claim="The measurement command emits a diagnostic when no value is supplied.",
                    observed='print("missing measurement")', source=dict(kind="git", path="measure.py", line=4))])


def test_fact_turn(state, messages):
    """Drive Pi through a real tool call and failed reports before a valid retry."""
    task = state["task"]
    turn = attempts.get(state["attempt"], 0)
    attempts[state["attempt"]] = turn + 1
    last = str(messages[-1]["content"])
    report = fact_report(state)
    if task == "retry":
        if turn == 0:
            return tool_call("read", {"path": "measure.py"})
        if turn == 1:
            match = re.search(r"事实核查回执 ([0-9a-f-]+)", last)
            assert match and "missing measurement" in last, last
            seen_receipts[task] = match[1]
            del report["factChecks"]
        elif turn == 2:
            assert "至少一项" in last, last
            report["factChecks"][0]["source"] = {"kind": "tool", "receipt": "fictional"}
        elif turn == 3:
            assert "不属于本次事实核查" in last, last
            report["factChecks"][0]["observed"] = "absent-from-revision"
        elif turn == 4:
            assert "摘录与基线文件指定行的内容不符" in last, last
            report["factChecks"][0].update(observed="absent-from-tool",
                                          source={"kind": "tool", "receipt": seen_receipts[task]})
        elif turn == 5:
            assert "摘录与工具返回的文本不符" in last, last
            report["factChecks"][0]["source"] = {"kind": "tool", "receipt": seen_receipts[task]}
        else:
            assert "阶段结果已登记" in last, last
            return {"role": "assistant", "content": "结束本阶段。"}
    elif task == "experiment-fix":
        if turn == 0:
            return tool_call("bash", {"command": "python3 measure.py"})
        if turn == 1:
            match = re.search(r"事实核查回执 ([0-9a-f-]+)", last)
            assert match and "missing measurement" in last and "4" in last, last
            report["factChecks"][0] = dict(claim="The default measurement aborts before producing a value.",
                observed="missing measurement", source={"kind": "tool", "receipt": match[1]})
            report["summary"] = "Running python3 measure.py with the baseline defaults exits with status 4."
        else:
            assert "阶段结果已登记" in last, last
            return {"role": "assistant", "content": "结束本阶段。"}
    elif task == "reuse":
        if turn == 0:
            report["factChecks"][0]["source"] = {"kind": "tool", "receipt": seen_receipts["retry"]}
        else:
            assert "不属于本次事实核查" in last, last
            return {"role": "assistant", "content": "退出本轮。"}
    return tool_call("taskbook_report", report)


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/mcp":
                assert self.headers["Authorization"] == "Bearer fixture-token"
                if body["method"] == "notifications/initialized":
                    assert self.headers["Mcp-Session-Id"] == "test-session"
                    self.send_response(202)
                    self.end_headers()
                    return
                if body["method"] == "initialize":
                    result = {"protocolVersion": "2025-06-18"}
                else:
                    assert body["method"] == "tools/call"
                    assert self.headers["Mcp-Session-Id"] == "test-session"
                    assert body["params"]["name"] == "t3_thread_launch"
                    args = body["params"]["arguments"]
                    launches.append(args)
                    result = {"structuredContent": {"threadId": "thread-1"}}
                reply = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result})
                self.send_response(200)
                self.send_header("Mcp-Session-Id", "test-session")
                self.send_header("Content-Type", "application/json" if body["id"] == 1 else "text/event-stream")
                self.end_headers()
                self.wfile.write((reply if body["id"] == 1 else "data: " + reply + "\n\n").encode())
                return
            messages = body["messages"]
            system = "\n".join(str(m["content"]) for m in messages if m["role"] in ("system", "developer"))
            reports = re.findall(r"## 当前运行数据\n\n(\{.*?\})\n\n## 任务书原文", system, re.S)
            assert reports, system[-1200:]
            state = json.loads(reports[-1])
            phase = state["phase"]
            task = state["task"]
            kind = state["type"]
            assert "PSTACK CONTROLLER FEATURE" not in system
            if phase == "fact-check":
                assert "PSTACK METHOD PROVE IT WORKS" in system
                assert "1. Investigate the question against" in system
                assert "2. Write the findings" not in system
            if phase == "fact-check" and kind.startswith("new-"):
                assert kind.startswith("new-") and "MATT METHOD DIAGNOSIS CONTINUATION" not in system
            if phase == "fact-check" and kind.startswith("fix-"):
                assert kind.startswith("fix-") and "## Phase 2: minimize" in system and "MATT METHOD DIAGNOSIS CONTINUATION" not in system
            if phase == "implement" and kind.startswith("fix-"):
                assert kind.startswith("fix-") and "MATT METHOD DIAGNOSIS CONTINUATION" in system and "MATT METHOD TDD" not in system
            if phase == "implement" and kind == "new-feature":
                assert "MATT METHOD TDD" in system
            if phase == "implement" and kind == "new-experiment":
                assert "PSTACK METHOD BENCHMARK CHECKLIST" in system and "MATT METHOD TDD" not in system
            if phase == "design":
                assert "PSTACK METHOD MODEL THE DOMAIN" in system and "MATT METHOD CODEBASE DESIGN" in system, system
                assert "UNPINNED CHANGE" not in system, system
            if phase == "correctness":
                assert "SPEC INPUT ONLY" in system and "STANDARDS INPUT ONLY" not in system and "UNUSED ROUTER" not in system
            if phase == "quality":
                assert "SMELL BASELINE" in system and "STANDARDS INPUT ONLY" in system and "SPEC INPUT ONLY" not in system and "UNUSED ROUTER" not in system
            if task == "cancel" and phase == "fact-check":
                cancel_started.set()
                cancel_end.wait(8)
            seen_tool = messages[-1]["role"] in ("tool", "function")
            requests.append((task, phase, seen_tool, len(reports)))
            if phase == "fact-check" and task in ("retry", "reuse", "experiment-fix"):
                delta = test_fact_turn(state, messages)
                finish = "tool_calls" if "tool_calls" in delta else "stop"
            elif seen_tool or (task == "resume" and phase == "implement" and task not in interrupted) or task == "cancel":
                if task == "resume" and phase == "implement":
                    interrupted.add(task)
                delta = {"role": "assistant", "content": "本轮结束。"}
                finish = "stop"
            else:
                tools = [t["function"]["name"] for t in body.get("tools", []) if t["type"] == "function"]
                assert "taskbook_report" in tools, tools
                result = dict(attempt=state["attempt"], outcome="blocked" if task == "block" else "pass",
                              summary="测试替身阶段结果 " + phase, evidence=["fixture observation"])
                if phase == "fact-check" and result["outcome"] == "pass":
                    result = fact_report(state)
                if phase in ("correctness", "quality"):
                    result["reviewThread"] = "fixture-" + phase
                delta = tool_call("taskbook_report", result)
                finish = "tool_calls"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for choice in ({"delta": delta, "index": 0, "finish_reason": None},
                           {"delta": {}, "index": 0, "finish_reason": finish}):
                chunk = {"id": "chatcmpl-fixture", "object": "chat.completion.chunk",
                         "created": 1, "model": "fixture", "choices": [choice]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            errors.put(exc)
            self.send_error(500)

class Client:
    def __init__(self, work, config, session, env=None):
        self.events = queue.Queue()
        self.saved = []
        self.notifications = []
        self.process = subprocess.Popen(
            [str(pi), "--mode", "rpc", "--offline", "--no-approve", "--no-extensions",
             "--no-skills", "--no-context-files", "--provider", "fixture", "--model", "fixture",
             "--session-id", session, "-e", str(repo / "index.ts")],
            cwd=work, env={**os.environ, "PI_TASKBOOK_PSTACK_ROOT": "", "PI_TASKBOOK_MATT_ROOT": "",
                           "PI_CODING_AGENT_DIR": str(config), **(env or {})},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                self.events.put({"stdout": line})

    def command(self, **command):
        id = uuid.uuid4().hex
        self.process.stdin.write(json.dumps({"id": id, **command}) + "\n")
        self.process.stdin.flush()
        return self.until(lambda ev: ev.get("type") == "response" and ev.get("id") == id)

    def until(self, predicate, timeout=16):
        cutoff = time.monotonic() + timeout
        while time.monotonic() < cutoff:
            try:
                item = self.events.get(timeout=max(.01, cutoff - time.monotonic()))
            except queue.Empty:
                break
            self.saved.append(item)
            if predicate(item):
                return item
        raise AssertionError(f"RPC timeout. Recent events {self.saved[-12:]} Provider errors {list(errors.queue)}")

    def notify(self, text):
        def match(e):
            return e.get("type") == "extension_ui_request" and e.get("method") == "notify" and text in str(e) and e not in self.notifications
        item = next((e for e in self.saved if match(e)), None) or self.until(match)
        self.notifications.append(item)
        return item

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=4)
        details = self.process.stderr.read()
        if details.strip():
            print("Pi stderr", details[:1200])

def git(where, *args):
    return subprocess.check_output(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "-C", str(where), *args], text=True, stderr=subprocess.STDOUT).strip()

def state_for(wt, name):
    files = list((wt / ".audit/pi-taskbook").glob(f"{name}-*/state.json"))
    assert len(files) == 1, files
    return json.loads(files[0].read_text())

def taskfile(stage, name, type="new-feature", branch="agent/fixture"):
    path = stage / f"{name} task.md"
    goal = {
        "new-feature": "Add a unit to the measurement output. First identify the existing command and its input requirements.",
        "new-experiment": "Measure repeated invocations of measure.py with a supplied value. Confirm its input requirements.",
        "fix-feature": "Make the no-argument measurement command produce a default value. Confirm the current failure.",
        "fix-experiment": "Restore the default experiment run. Reproduce the missing-measurement failure before changing it.",
    }[type]
    path.write_text(f"""# Fixture

Taskbook ID: `{name}`
Repository: `fixture/repo`
Base branch: `main`
Work branch: `{branch}`
Facts: ./fixture.facts.md

## Goal

Type: `{type}`

{goal}

## Delivery

Verified checkpoint only.
""")
    return path

def submit(client, path, command="taskbook"):
    result = client.command(type="prompt", message=f'/{command} "{path}"')
    assert result["success"] and result["data"]["disposition"] == "handled", result

with tempfile.TemporaryDirectory(prefix="pi-taskbook-rpc-") as tmp:
    d = Path(tmp)
    config = d / "config"
    config.mkdir()
    (d / "fixture.facts.md").write_text("1. measure.py is the public measurement entry. Verify the no-argument behavior.\n")
    main = d / "main"
    main.mkdir()
    git(main, "init", "-b", "main")
    git(main, "remote", "add", "origin", "git@github.com:fixture/repo.git")
    (main / ".gitignore").write_text("/.audit/pi-taskbook/\n")
    (main / "measure.py").write_text(sample_program)
    git(main, "add", ".gitignore", "measure.py")
    git(main, "commit", "-m", "Base")
    work = d / "work"
    git(main, "worktree", "add", "-b", "agent/fixture", str(work))
    (work / "output.txt").write_text("normal entry fixture\n")
    git(work, "add", "output.txt")
    git(work, "commit", "-m", "Existing worktree revision")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (config / "models.json").write_text(json.dumps({"providers": {"fixture": {
        "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions",
        "apiKey": "fixture", "models": [{"id": "fixture"}]}}}))

    roots = {}
    for source, fixtures in {
        "PSTACK": {
            f"pstack/skills/{name}/SKILL.md": "PSTACK METHOD " + name.removeprefix("principle-").replace("-", " ").upper() + "\n"
            for name in ("principle-prove-it-works", "principle-model-the-domain",
                         "principle-sequence-verifiable-units", "principle-minimize-reader-load", "benchmark-checklist")
        },
        "MATT": {
            "skills/engineering/research/SKILL.md": "1. Investigate the question against the repository.\n2. Write the findings into an issue.\n",
            "skills/engineering/codebase-design/SKILL.md": "MATT METHOD CODEBASE DESIGN\n",
            "skills/engineering/tdd/SKILL.md": "MATT METHOD TDD\n",
            "skills/engineering/tdd/tests.md": "MATT TEST GUIDANCE\n",
            "skills/engineering/tdd/mocking.md": "MATT MOCK GUIDANCE\n",
            "skills/engineering/diagnosing-bugs/SKILL.md": "## Redact\nREDACT SENSITIVE VALUES\n## Phase 1: loop\nred\n## Phase 2: minimize\nminimal\n## Phase 3: hypotheses\nMATT METHOD DIAGNOSIS CONTINUATION\n",
            "skills/engineering/code-review/SKILL.md": "UNUSED ROUTER\n### 3. Identify the standards sources\nSMELL BASELINE\n### 4. Dispatch\n**Standards sub-agent prompt** should include:\nSTANDARDS INPUT ONLY\n**Spec sub-agent prompt** should include:\nSPEC INPUT ONLY\n### 5. Aggregate\n",
        },
    }.items():
        checkout = d / source.lower()
        checkout.mkdir()
        git(checkout, "init", "-b", "main")
        for name, content in fixtures.items():
            target = checkout / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        git(checkout, "add", ".")
        git(checkout, "commit", "-m", "Pinned prompt inputs")
        roots[f"PI_TASKBOOK_{source}_ROOT"] = str(checkout)
    feature = d / "pstack/pstack/skills/poteto-mode/playbooks/feature.md"
    feature.parent.mkdir(parents=True)
    feature.write_text("PSTACK CONTROLLER FEATURE\n")
    git(d / "pstack", "add", ".")
    git(d / "pstack", "commit", "-m", "Reference only controller")
    worktree_root = d / "task-worktrees"
    worktree_root.mkdir()
    t3env = {
        **roots, "PI_TASKBOOK_WORKTREE_ROOT": str(worktree_root),
        "T3_MCP_URL": f"http://127.0.0.1:{server.server_port}/mcp", "T3_MCP_BEARER_TOKEN": "fixture-token",
    }

    incomplete = d / "incomplete-matt"
    git(d, "clone", roots["PI_TASKBOOK_MATT_ROOT"], str(incomplete))
    research_file = "skills/engineering/research/SKILL.md"
    git(incomplete, "rm", research_file)
    git(incomplete, "commit", "-m", "Missing mandatory fact-check prompt")
    for command, root, overrides, expected in [
        ("taskbook", work, {}, "PI_TASKBOOK_MATT_ROOT"),
        ("taskbook-new", main, {**t3env, "PI_TASKBOOK_MATT_ROOT": ""}, "PI_TASKBOOK_MATT_ROOT"),
        ("taskbook-new", main, {**t3env, "PI_TASKBOOK_MATT_ROOT": str(incomplete)}, research_file),
    ]:
        rejected = Client(root, config, str(uuid.uuid4()), overrides)
        try:
            submit(rejected, taskfile(d, "missing-upstream"), command)
            rejected.notify(expected)
            assert not requests and not launches
            assert not list(worktree_root.iterdir())
            assert not list((work / ".audit/pi-taskbook").glob("*/state.json"))
        finally:
            rejected.close()

    session = str(uuid.uuid4())
    client = Client(main, config, session, t3env)
    try:
        commands = client.command(type="get_commands")
        assert {item["name"] for item in commands["data"]["commands"]} >= {"taskbook", "taskbook-new", "taskbook-exit"}, commands
        submit(client, taskfile(d, "main-rejected"))
        client.notify("当前是主 checkout")
        assert not (main / ".audit").exists()
        assert not requests
        new_path = d / "entry-format.md"
        base = git(main, "rev-parse", "HEAD")
        new_path.write_text(f"""# Fixture
**Repository** `fixture/repo`
**Base commit** `{base}`
**Entry** Fix feature

## Goal

Restore the no-argument measurement command.

## Facts

1. measure.py currently diagnoses a missing measurement.

## Delivery

Complete the shared stages.
""")
        submit(client, new_path, "taskbook-new")
        client.notify("已交给新 T3 thread")
        assert len(launches) == 1 and not requests
        strategy = launches[0]["workspaceStrategy"]
        assert strategy["type"] == "existing_worktree"
        assert strategy["branch"].startswith("agent/task-")
        created = Path(strategy["worktreePath"])
        assert git(created, "rev-parse", "HEAD") == git(main, "rev-parse", "HEAD")
        assert git(created, "branch", "--show-current") == strategy["branch"]
        submit(client, new_path, "taskbook-new")
        client.notify("已交给新 T3 thread")
        assert launches[0] == launches[1] and not requests
    finally:
        client.close()

    message = launches[0]["message"]
    assert message.startswith("/taskbook --prepared ")
    child = Client(created, config, str(uuid.uuid4()), roots)
    try:
        result = child.command(type="prompt", message=message)
        assert result["success"] and result["data"]["disposition"] == "handled"
        child.notify("可交接")
        state = state_for(created, launches[0]["title"])
        assert state["exit"] == "ready"
        assert [r["phase"] for r in state["reports"]] == ["fact-check", "design", "implement", "correctness", "quality"], state
    finally:
        child.close()

    session = str(uuid.uuid4())
    client = Client(work, config, session, roots)
    try:
        submit(client, taskfile(d, "full", "new-experiment"))
        client.notify("可交接")
        s = state_for(work, "full")
        assert s["exit"] == "ready"
        assert [r["phase"] for r in s["reports"]] == ["fact-check", "design", "implement", "correctness", "quality", "performance"], s
        assert s["revision"] == git(work, "rev-parse", "HEAD")
        submit(client, taskfile(d, "experiment-fix", "fix-experiment"))
        client.notify("可交接")
        fixed = state_for(work, "experiment-fix")
        assert [r["phase"] for r in fixed["reports"]] == ["fact-check", "design", "implement", "correctness", "quality", "performance"], fixed
        retry_book = taskfile(d, "retry")
        retry_book.write_text(retry_book.read_text().replace("Facts: ./fixture.facts.md", ""))
        submit(client, retry_book)
        client.notify("可交接")
        retried = state_for(work, "retry")["reports"]
        assert [item["phase"] for item in retried].count("fact-check") == 1
        receipt_fact = retried[0]["factChecks"][0]
        assert receipt_fact["origin"].startswith("read ") and not receipt_fact["toolError"], receipt_fact
        assert receipt_fact["source"]["receipt"] == seen_receipts["retry"]
        assert receipt_fact["observed"] == 'print("missing measurement")'
        failure = fixed["reports"][0]["factChecks"][0]
        assert failure["origin"].startswith("bash ") and failure["toolError"] is True, failure
        assert failure["observed"] == "missing measurement", failure
        git_fact = s["reports"][0]["factChecks"][0]
        assert git_fact["origin"] == s["base"] + ":measure.py:4", git_fact
        submit(client, taskfile(d, "reuse"))
        client.notify("退出（可恢复）")
        rejected = state_for(work, "reuse")
        assert rejected["phase"] == "fact-check" and rejected["reports"] == []
        assert {phase for task, phase, *_ in requests if task == "reuse"} == {"fact-check"}
        submit(client, taskfile(d, "block", "fix-feature"))
        client.notify("有阻塞")
        blocked = state_for(work, "block")
        assert blocked["exit"] == "blocked" and [r["phase"] for r in blocked["reports"]] == ["fact-check"]
        resume_path = taskfile(d, "resume")
        submit(client, resume_path)
        client.notify("退出（可恢复）")
        s = state_for(work, "resume")
        assert s["phase"] == "implement" and len(s["reports"]) == 2, s
        state_path = next((work / ".audit/pi-taskbook").glob("resume-*/state.json"))
        del s["upstream"]
        s["phase"] = "implement-new"
        s["reports"][0]["phase"] = "confirm-premises"
        state_path.write_text(json.dumps(s))
    finally:
        client.close()

    unconfigured = Client(work, config, session)
    try:
        prior = state_path.read_bytes()
        before = len(requests)
        submit(unconfigured, resume_path)
        unconfigured.notify("PI_TASKBOOK_MATT_ROOT")
        assert state_path.read_bytes() == prior and len(requests) == before
    finally:
        unconfigured.close()

    client = Client(work, config, session, roots)
    try:
        submit(client, resume_path)
        client.notify("可交接")
        s = state_for(work, "resume")
        assert s["exit"] == "ready"
        assert [r["phase"] for r in s["reports"]] == ["fact-check", "design", "implement", "correctness", "quality"], s
        assert all(s["upstream"][key]["commit"] for key in ("matt", "pstack"))
        submit(client, taskfile(d, "cancel"))
        assert cancel_started.wait(8)
        assert client.command(type="prompt", message="/taskbook-exit")["success"]
        client.notify("已取消")
        assert state_for(work, "cancel")["exit"] == "cancelled"
        cancel_end.set()
    finally:
        client.close()
        server.shutdown()

assert not list(errors.queue), list(errors.queue)
assert max(item[3] for item in requests) == 1, requests
print("Pi RPC passed: mandatory upstreams, scoped prompts, baseline and tool evidence, rejection and retry, handoff, migration and exit.")
