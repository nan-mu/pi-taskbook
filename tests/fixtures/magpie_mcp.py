import hashlib
import json
from pathlib import Path
import sys

work = Path(sys.argv[1])
log = Path(sys.argv[2])
records = [{"id": "m_other", "owner": "fixture/other", "fact_id": "project:fact:shared-contract",
            "kind": "fact", "text": "Fixture projects use the reviewed interface.", "scope": "global",
            "version": 1, "fact_version": 1, "status": "active", "eligible": True, "writable": False}]

def owner_tag(row):
    encoded = json.dumps([row["owner"], row["fact_id"]], separators=(",", ":")).encode()
    return "pi-" + hashlib.sha256(encoded).hexdigest()[:24]

schemas = {
    "memory_context": {},
    "memory_search": {"scope": "string", "limit": "integer", "tags": "array", "cursor": "string"},
    "memory_save": {"owner": "string", "fact_id": "string", "kind": "string", "text": "string",
                    "scope": "string", "fact_version": "integer", "if_version": ["integer", "null"],
                    "idempotency_key": "string", "id": "string"},
    "memory_forget": {"owner": "string", "fact_id": "string", "fact_version": "integer",
                      "if_version": "integer", "idempotency_key": "string", "id": "string"},
}

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"],
                  "serverInfo": {"name": "fixture-magpie", "version": "1"}, "capabilities": {"tools": {}}}
    elif method == "tools/list":
        result = {"tools": [{"name": name, "description": "Fixture Magpie capability",
                             "inputSchema": {"type": "object", "properties": {
                                 key: {"type": value, **({"items": {"type": "string"}} if value == "array" else {})}
                                 for key, value in fields.items()}}} for name, fields in schemas.items()]}
    elif method == "tools/call":
        name = request["params"]["name"]
        args = request["params"].get("arguments", {})
        completions = []
        for path in (work / ".audit/pi-taskbook").glob("shared-*/state.json"):
            state = json.loads(path.read_text())
            if state.get("exit") == "ready":
                completions.append({"revision": state["revision"], "facts": state["approvedProjectHead"],
                                    "approvals": [r["phase"] for r in state["reports"] if r["outcome"] == "pass"]})
        with log.open("a") as stream:
            stream.write(json.dumps({"tool": name, "args": args, "completions": completions}) + "\n")
        if name == "memory_context":
            payload = {"protocol": "pi-taskbook-magpie-v1", "agent": {"id": "pi"}, "project": {"key": "github.com/fixture/repo"},
                       "search_scopes": ["global"], "capabilities": {"owner_isolated_create": True,
                                                                     "conditional_update": True, "conditional_forget": True}}
        elif name == "memory_search":
            tags = args.get("tags", [])
            matched = [row for row in records if len(tags) != 2 or owner_tag(row) in tags]
            payload = {"scope": "global", "records": matched, "next_cursor": None}
        elif name == "memory_save":
            assert args["owner"] == "fixture/repo" and completions
            current = next((row for row in records if row["owner"] == args["owner"] and row["fact_id"] == args["fact_id"]), None)
            assert args["if_version"] == (current["version"] if current else None)
            assert args.get("id") == (current["id"] if current else None)
            payload = {"id": current["id"] if current else "m_fixture_" + str(len(records)),
                       "owner": args["owner"], "fact_id": args["fact_id"], "kind": args["kind"], "text": args["text"],
                       "scope": "global", "version": current["version"] + 1 if current else 1,
                       "fact_version": args["fact_version"], "status": "active", "eligible": True, "writable": True}
            if current:
                records[records.index(current)] = payload
            else:
                records.append(payload)
            if "lose-receipt" in args["fact_id"]:
                result = {"content": [{"type": "text", "text": "fixture response lost"}], "isError": True}
                print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
                continue
        elif name == "memory_forget":
            current = next(row for row in records if row["id"] == args["id"])
            assert current["owner"] == args["owner"] == "fixture/repo"
            assert args["if_version"] == current["version"] and args["fact_id"] == current["fact_id"]
            payload = {**current, "fact_version": args["fact_version"], "version": current["version"] + 1, "status": "retired"}
            records[records.index(current)] = payload
        else:
            raise AssertionError(name)
        result = {"content": [{"type": "text", "text": json.dumps(payload)}], "structuredContent": payload}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
