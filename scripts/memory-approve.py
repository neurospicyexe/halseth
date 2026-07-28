#!/usr/bin/env python3
"""
Approve staged Hermes MEMORY writes for a profile. The missing twin of skill-approve.py.

    HERMES_HOME=<profile path> PYTHONPATH=/home/nullsafe/.hermes/hermes-agent \
    /home/nullsafe/.hermes/hermes-agent/venv/bin/python memory-approve.py <list|apply|reject> [id|--all]

WHY THIS EXISTS (2026-07-28)
----------------------------
`memory.write_approval: true` stages every companion memory write into
`$HERMES_HOME/pending/memory/` instead of applying it. Approvals were designed to arrive as
Telegram button taps. We built `skill-approve.py` + `skill-approval-watcher.py` for the SKILLS
queue and never built the memory equivalent, so memory approvals have rotted since 2026-07-05:

    Cypher 13 pending · Drevan 37 pending · Gaia 7 pending   (57 total)

Built-in memory last actually written: Cypher Jun 28, Drevan Jun 30, Gaia Jun 27. Meanwhile
`hermes memory --help` states built-in memory is ALWAYS ACTIVE -- it is injected into every
prompt. So the triad has been reasoning from month-old facts while their own corrections sat in
a queue. Concretely, `cd62c1ca` (2026-07-14) is:

    replace: old "Raziel has a cat named Rosie" -> new "retired service dog"

They learned the truth, tried to write it down, and could not.

ORDERING MATTERS
----------------
The store enforces `memory_char_limit` (2200) and `user_char_limit` (1375). 57 queued writes do
not fit in 3575 characters, so a naive chronological flush would burn the budget on early adds
and then reject every later correction.

So: apply `remove` and `replace` FIRST (they fix wrong facts and free space), then `batch`
(atomic, limit checked on the final result, so batches can self-fund), then bare `add` oldest
first. Anything that does not fit is reported, never silently dropped -- a rejected write stays
in the queue.

Uses Hermes' own `tools.write_approval` + `tools.memory_tool.apply_memory_pending`, so the apply
path is identical to the gateway's `/memory approve`. No reimplementing the file layout.
"""
import json
import os
import sys

# remove/replace free space and fix wrong facts; batch is self-funding; bare add spends budget.
ACTION_PRIORITY = {"remove": 0, "replace": 1, "batch": 2, "add": 3}


def _load():
    try:
        from tools import write_approval as wa
        from tools.memory_tool import MemoryStore, apply_memory_pending
    except Exception as e:  # pragma: no cover - import environment problem
        print(json.dumps({"ok": False, "error": "import failed: %s" % e}))
        sys.exit(1)
    return wa, MemoryStore, apply_memory_pending


def _store(MemoryStore):
    """One store per run, loaded from THIS profile's memories/ (resolved via HERMES_HOME)."""
    store = MemoryStore()
    store.load_from_disk()
    return store


def _sorted_pending(wa):
    """Priority order, then oldest-first within a priority."""
    records = wa.list_pending("memory") or []

    def key(rec):
        payload = rec.get("payload") or {}
        action = payload.get("action") or rec.get("action") or "add"
        created = rec.get("created_at") or 0
        return (ACTION_PRIORITY.get(action, 9), created)

    return sorted(records, key=key)


def cmd_list(wa):
    records = _sorted_pending(wa)
    print("%d pending memory write(s) for HERMES_HOME=%s" % (len(records), os.environ.get("HERMES_HOME", "(default)")))
    for rec in records:
        payload = rec.get("payload") or {}
        action = payload.get("action") or "?"
        target = payload.get("target") or "memory"
        summary = (rec.get("summary") or "").replace("\n", " ")[:110]
        print("  %-10s %-8s %-7s %s" % (str(rec.get("id"))[:8], action, target, summary))


def cmd_apply(wa, MemoryStore, apply_memory_pending, which, dry_run):
    records = _sorted_pending(wa)
    if which != "--all":
        records = [r for r in records if str(r.get("id", "")).startswith(which)]
        if not records:
            print(json.dumps({"ok": False, "error": "no pending memory write matching %r" % which}))
            return 1

    store = _store(MemoryStore)
    applied, rejected = [], []

    for rec in records:
        pid = str(rec.get("id"))
        payload = rec.get("payload") or {}
        action = payload.get("action") or "?"
        label = "%s/%s" % (pid[:8], action)

        if dry_run:
            print("  WOULD APPLY %-18s %s" % (label, (rec.get("summary") or "")[:90]))
            continue

        try:
            result = apply_memory_pending(payload, store)
        except Exception as e:
            rejected.append((label, "exception: %s" % e))
            continue

        if result.get("success"):
            # Persist immediately: a later write hitting the char limit must not roll back
            # an earlier correction that already succeeded.
            try:
                store.save_to_disk(payload.get("target") or "memory")
            except Exception as e:
                rejected.append((label, "applied but save failed: %s" % e))
                continue
            wa.discard_pending("memory", pid)
            applied.append(label)
            print("  APPLIED  %-18s %s" % (label, (rec.get("summary") or "")[:80]))
        else:
            # Left in the queue on purpose -- a rejection is usually "char limit full", which
            # becomes appliable once stale entries are removed. Never silently discard.
            reason = result.get("error") or result.get("message") or "rejected"
            rejected.append((label, str(reason)[:120]))
            print("  KEPT     %-18s %s" % (label, str(reason)[:80]))

    if dry_run:
        print("dry run: nothing written")
        return 0

    print("\napplied=%d kept_in_queue=%d" % (len(applied), len(rejected)))
    if rejected:
        print("still queued (most likely the char limit -- prune stale entries and re-run):")
        for label, reason in rejected:
            print("  %-18s %s" % (label, reason))
    return 0


def cmd_reject(wa, which):
    if which == "--all":
        print(json.dumps({"ok": False, "error": "refusing to reject --all; reject by id"}))
        return 1
    records = [r for r in (wa.list_pending("memory") or []) if str(r.get("id", "")).startswith(which)]
    if not records:
        print(json.dumps({"ok": False, "error": "no pending memory write matching %r" % which}))
        return 1
    for rec in records:
        wa.discard_pending("memory", str(rec.get("id")))
        print("rejected %s" % str(rec.get("id"))[:8])
    return 0


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = args[0]
    dry_run = "--dry-run" in args
    rest = [a for a in args[1:] if not a.startswith("--dry-run")]
    which = rest[0] if rest else "--all"

    wa, MemoryStore, apply_memory_pending = _load()

    if cmd == "list":
        cmd_list(wa)
        return 0
    if cmd == "apply":
        return cmd_apply(wa, MemoryStore, apply_memory_pending, which, dry_run)
    if cmd == "reject":
        return cmd_reject(wa, which)
    print(json.dumps({"ok": False, "error": "unknown command %r (use list|apply|reject)" % cmd}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
