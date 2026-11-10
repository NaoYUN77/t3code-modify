#!/usr/bin/env python3
"""Extract a demo fixture from T3 Code's local state (read-only).

Pulls one thread's timeline steps straight out of
`~/.t3/userdata/statev2.sqlite` so the panel can be developed and screenshot
without a live, authenticated T3 session.

The rows are the same turn items the panel's `toNode` reads, in the same shape,
so the fixture goes through the identical code path as the live client — with
three differences that are the cost of committing a fixture: only a sample of
the steps is taken (see `pick`), long diffs and outputs are clipped at `CLIP`,
and anything that looks like a credential is replaced (see `redact`) — because a
real thread is a real thread, and this one's `.env` diff carries live tokens.

Usage:  python3 scripts/make-fixture.py [thread-id] [max-items] > demo/fixture.json
        python3 scripts/make-fixture.py --redact demo/fixture.json
"""
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB = Path.home() / ".t3" / "userdata" / "statev2.sqlite"
DEFAULT_THREAD = "af8da415-c1b2-4cdd-a549-2258c048fc99"

# Everything the model did or decided, except its private reasoning — the same
# list as KEY_TYPES in src/timeline-core.js, which owns the definition.
KEY_TYPES = [
    "user_message",
    "user_input_request",
    "secret_request",
    "proposed_plan",
    "approval_request",
    "assistant_message",
    "subagent",
    "dynamic_tool",
    "command_execution",
    "web_search",
    "file_change",
    "checkpoint",
    "notification",
    "compaction",
    "run_interrupt_request",
    "run_interrupt_result",
    "error",
]

CLIP = 1200

# Steps worth keeping every one of, against the ones that are texture.
NOTABLE = {
    "user_message",
    "user_input_request",
    "secret_request",
    "proposed_plan",
    "approval_request",
    "checkpoint",
    "compaction",
    "error",
    "run_interrupt_request",
    "run_interrupt_result",
}

# How many of each texture type to keep per turn. An assistant message is the
# one worth reading — the turn's answer, which is its last, not every aside on
# the way there — and the tool calls are sampled so a single busy turn cannot
# fill the fixture.
PER_TURN = {
    "assistant_message": 1,
    "dynamic_tool": 2,
    "command_execution": 2,
    "file_change": 2,
    "web_search": 1,
    "subagent": 1,
    "notification": 1,
}
KEEP_LAST = {"assistant_message"}


def sqlite_uri(path):
    """A read-only `file:` URI for a path on any platform.

    SQLite reads a Windows path in a URI as a sequence of escapes, so the path
    goes in with forward slashes (`C:/Users/...`) and a leading slash after the
    scheme (`file:/C:/Users/...`), which is what it expects there.
    """
    p = Path(path).as_posix()
    if not p.startswith("/"):
        p = "/" + p
    return f"file:{p}?mode=ro&immutable=1"


def run_turn(run_id):
    """`run:thread:<tid>:ordinal:<N>` -> N, the turn count used by getTurnDiff."""
    if not run_id:
        return None
    try:
        return int(run_id.rsplit(":", 1)[1])
    except ValueError:
        return None


def clip(text, limit=CLIP):
    """Long diffs and outputs are the bulk of a fixture; cap them with a note."""
    if not isinstance(text, str) or len(text) <= limit:
        return text
    return text[:limit] + f"\n… 截断，原长 {len(text)} 字"


def pick(items, max_items):
    """A sample that still reads like a task.

    The panel records every step but the model's reasoning, and this thread has
    thousands of them — a fixture of the first N would be nothing but tool calls
    from the opening turn. So every decision and boundary is kept, and the
    texture around it is sampled by `PER_TURN`, keeping the last of a run where
    that is the one that matters and the first where it is not.
    """
    kept = set()
    seen = {}  # (turn, type) -> indices, so a run can be cut down afterwards
    for i, it in enumerate(items):
        t = it["type"]
        if t in NOTABLE:
            kept.add(i)
            continue
        budget = PER_TURN.get(t, 0)
        if not budget:
            continue
        group = seen.setdefault((it["turn"], t), [])
        group.append(i)
        kept.add(i)
        if len(group) > budget:
            kept.discard(group.pop(0 if t in KEEP_LAST else -1))

    picked = [items[i] for i in sorted(kept)]
    return picked[:max_items]


# A fixture is a real thread, and a real thread contains credentials: this one
# carries a live Slack bot and app token in a diff of `.env`, and quotes an
# inference key in a message. A fixture gets committed and screenshotted, so
# every string that looks like a secret is replaced on the way out — an env
# assignment first (so `SLACK_BOT_TOKEN=xoxb-…` keeps its name and loses only
# the value), then the shapes themselves wherever they appear in prose or logs.
SECRET_PATTERNS = [
    # KEY=value / TOKEN: value / PASSWORD = value, in a diff or in code
    (
        re.compile(
            r"(?im)^([+\-]?[ \t]*(?:export[ \t]+)?[A-Za-z0-9_]*"
            r"(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*[ \t]*[:=][ \t]*)(\S.*)$"
        ),
        r"\1<redacted>",
    ),
    (re.compile(r"(?im)^([+\-]?[ \t]*(?:Authorization|X-Api-Key|X-API-KEY)[ \t]*:[ \t]*)(\S.*)$"), r"\1<redacted>"),
    (re.compile(r"(?i)\bBearer[ \t]+[A-Za-z0-9._\-]{12,}"), "Bearer <redacted>"),
    (re.compile(r"\bxox[abposr]-[0-9A-Za-z\-]{6,}"), "xoxb-<redacted>"),
    (re.compile(r"\bxapp-[0-9A-Za-z\-]{6,}"), "xapp-<redacted>"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}"), "sk-<redacted>"),
    (re.compile(r"\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}"), "ghp_<redacted>"),
    (re.compile(r"\bAKIA[0-9A-Z]{12,}"), "AKIA<redacted>"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "<private key redacted>"),
]


def redact(obj):
    """Every string in the fixture, through every pattern. Returns the count."""
    hits = 0

    def one(text):
        nonlocal hits
        out = text
        for pattern, replacement in SECRET_PATTERNS:
            out, n = pattern.subn(replacement, out)
            hits += n
        return out

    def walk(node):
        if isinstance(node, str):
            return one(node)
        if isinstance(node, list):
            return [walk(v) for v in node]
        if isinstance(node, dict):
            return {k: walk(v) for k, v in node.items()}
        return node

    return walk(obj), hits


def redact_file(path):
    """Apply the patterns to a fixture already on disk, in place."""
    p = Path(path)
    fixture = json.loads(p.read_text())
    fixture, hits = redact(fixture)
    p.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
    print(f"{p}: {hits} secret(s) redacted", file=sys.stderr)


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--redact":
        redact_file(sys.argv[2])
        return

    thread_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_THREAD
    max_items = int(sys.argv[2]) if len(sys.argv) > 2 else 260

    db = sqlite3.connect(sqlite_uri(DB), uri=True)
    db.row_factory = sqlite3.Row

    thread = db.execute(
        "SELECT thread_id, project_id, title FROM orchestration_v2_projection_threads WHERE thread_id=?",
        (thread_id,),
    ).fetchone()
    if thread is None:
        sys.exit(f"thread {thread_id} not found")

    placeholders = ",".join("?" * len(KEY_TYPES))
    rows = db.execute(
        f"""SELECT p.ordinal AS position, p.turn_item_id, i.type, i.payload_json
            FROM orchestration_v2_turn_item_positions p
            JOIN orchestration_v2_projection_turn_items i
              ON i.thread_id = p.thread_id AND i.turn_item_id = p.turn_item_id
            WHERE p.thread_id = ? AND i.type IN ({placeholders})
              AND (i.payload_json NOT LIKE '%"visibility":"synthetic"%')
            ORDER BY p.ordinal""",
        (thread_id, *KEY_TYPES),
    ).fetchall()

    items = []
    for r in rows:
        d = json.loads(r["payload_json"])
        item = {
            "position": r["position"],
            "id": d.get("id"),
            "type": d.get("type"),
            "ordinal": d.get("ordinal"),
            "runId": d.get("runId"),
            "turn": run_turn(d.get("runId")),
            "status": d.get("status"),
            "startedAt": d.get("startedAt"),
            "completedAt": d.get("completedAt"),
        }
        t = d.get("type")
        if t in ("user_message", "assistant_message"):
            item["text"] = clip(d.get("text"))
        elif t == "proposed_plan":
            item["markdown"] = clip(d.get("markdown"))
        elif t == "file_change":
            item.update(
                fileName=d.get("fileName"),
                additions=d.get("additions"),
                deletions=d.get("deletions"),
                diffStr=clip(d.get("diffStr")),
            )
        elif t == "checkpoint":
            item["files"] = d.get("files") or []
            item["filesTotal"] = d.get("filesTotal")
        elif t == "user_input_request":
            item["questions"] = d.get("questions") or []
            item["questionAnswer"] = d.get("questionAnswer")
        elif t == "approval_request":
            item.update(prompt=d.get("prompt"), reason=d.get("reason"))
        elif t == "secret_request":
            item.update(
                label=d.get("label"),
                reason=d.get("reason"),
                placeholder=d.get("placeholder"),
                secretStatus=d.get("secretStatus") or d.get("status"),
            )
        elif t in ("dynamic_tool", "command_execution"):
            item.update(
                toolName=d.get("toolName"),
                title=d.get("title"),
                input=d.get("input"),
                output=clip(d.get("output")),
                outputOmitted=d.get("outputOmitted"),
            )
        elif t == "web_search":
            item.update(patterns=d.get("patterns") or [], results=d.get("results") or [])
        elif t == "subagent":
            item.update(
                prompt=clip(d.get("prompt")),
                result=clip(d.get("result")),
                progress=d.get("progress"),
            )
        elif t == "notification":
            item.update(summary=d.get("summary"), message=d.get("message"), outcome=d.get("outcome"))
        elif t == "compaction":
            item.update(
                beforeTokenCount=d.get("beforeTokenCount"),
                afterTokenCount=d.get("afterTokenCount"),
            )
        elif t in ("run_interrupt_request", "run_interrupt_result"):
            item["message"] = d.get("message")
        elif t == "error":
            item["failure"] = d.get("failure")
        items.append(item)

    picked = pick(items, max_items)

    fixture = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {"threadId": thread_id, "database": str(DB)},
        "thread": {
            "id": thread["thread_id"],
            "projectId": thread["project_id"],
            "title": thread["title"],
        },
        "items": picked,
    }
    fixture, hits = redact(fixture)
    json.dump(fixture, sys.stdout, ensure_ascii=False, indent=2)
    print(file=sys.stderr)
    print(f"{len(picked)} steps, {hits} secret(s) redacted", file=sys.stderr)


if __name__ == "__main__":
    main()
