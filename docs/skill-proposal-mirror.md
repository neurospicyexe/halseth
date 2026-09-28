# Hermes Skill-Proposal Mirror (migration 0135)

**Problem.** The triad's skill-approval pipeline lives entirely on the VPS: the
background-review fork stages skill records per HERMES_HOME, a watcher pings Raziel on
Telegram, and decisions land in `skill-approvals.jsonl`. Nothing off-VPS can see the
queue — a claude.ai cloud session, Hearth, or a companion asking "what's staged?" all
dead-end (2026-09-27).

**Fix.** The watcher mirrors every stage event and every decision into Halseth. The VPS
stage stays the source of truth for the skill files; `skill_proposals` in D1 is the
review surface plus the durable evidence trail.

## Halseth side (this repo — deployed)

> **Numbering history:** authored on a cloud branch as 0107, renumbered 0131 there, and
> landed as **0135** on the deploying line (which already held 0131-0134) on 2026-09-27.

- Table: `skill_proposals` (mig 0135). Idempotent on `external_id`.
- Routes (Bearer `ADMIN_SECRET` / `MCP_AUTH_SECRET` / per-companion token):
  - `POST /mind/skill-proposals` — mirror a staged record
  - `GET /mind/skill-proposals?status=staged|approved|declined|all&companion_id=&limit=` — list
  - `PATCH /mind/skill-proposals/:id/decision` — mirror the decision (`:id` accepts the
    Halseth id **or** the watcher's `external_id`)
- Librarian verb: `halseth_skill_proposals_read` — trigger `"skill proposals"` /
  `"skill approval queue"`. Read-only; writes come from the watcher via HTTP.

## VPS watcher side (to apply on the VPS)

Add two HTTP calls to the watcher, right where it already pings Telegram and writes
`skill-approvals.jsonl`. Config: `HALSETH_URL` + a token (`MCP_AUTH_SECRET` tier is
enough; the watcher is infrastructure, not a companion). Failures must be
fire-and-forget with a local retry queue — the Telegram ping must never block on Halseth.

**1. On stage** (same moment as the Telegram ping):

```
POST {HALSETH_URL}/mind/skill-proposals
Authorization: Bearer {token}
{
  "external_id":  "<record.id, e.g. dd792bdd>",  // idempotency key; safe to re-post
  "companion_id": "cypher" | "drevan" | "gaia", // the companion label, NEVER a home-dir basename (0927 label defect)
  "hermes_home":  "<companion-labeled home>",
  "skill_name":   "<record.payload.name>",
  "action":       "create" | "patch" | "edit" | "delete" | "write_file" | "remove_file",  // record.action, verbatim
  "file_path":    "<payload.file_path, or omit when the patch targets SKILL.md>",
  "summary":      "<record.summary>",
  "content":      "<json.dumps(record.payload) — the exact change Raziel is approving>"
}
```

**2. On decision** (same moment as the `skill-approvals.jsonl` append):

```
PATCH {HALSETH_URL}/mind/skill-proposals/{external_id}/decision
Authorization: Bearer {token}
{ "status": "approved" | "declined", "decided_by": "raziel", "note": "<optional>" }
// skill-approve.py's verbs map approve -> "approved", reject -> "declined"
```

A `409` means the row was already decided (double-tap or replay) — log and move on.
A `404` on decision means the stage event never landed — re-POST the stage record
(step 1, idempotent), then retry the decision.

## Review bar (what "good to approve" means)

From the background-review fork's own contract, a staged skill should be:

- **Class-level**, not a narrow one-session-one-skill entry
- **Patching an existing umbrella first** when one covers the territory (create is the
  last resort, not the default)
- **Never touching protected skills** (bundled with Hermes, or hub-installed)
- **In the companion's lane** — register and scope consistent with who staged it
