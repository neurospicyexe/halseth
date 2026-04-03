# System Audit — 2026-04-02

Knoll's principle applied: audit existing structure before adding anything.

---

## Findings Summary

| Severity | Finding |
|----------|---------|
| CRITICAL | Sit-and-resolve is stranded on a ghost table |
| HIGH | Parallel dream tables with split write paths |
| MEDIUM | 11 read executors unreachable from fast-path |
| LOW | `companion_notes` write path orphaned |

---

## 1. CRITICAL — Sit-and-Resolve Is Dead

Migration 0031 added `processing_status` to `companion_notes` (migration 0008) and created
`companion_note_sits` joined to `companion_notes`. But:

- **`companion_notes`** (0008): `id, created_at, author ('companion'|'human'), content, note_type`
- **`companion_journal`** (0012): `id, created_at, agent, note_text, tags, session_id, source`

Every current write path (Librarian `execCompanionNoteAdd`, HTTP `POST /companion-journal`,
`execHeldMark`) writes to **`companion_journal`**. Nothing creates rows in `companion_notes`
via the current Librarian stack.

`execNoteSit` requires a `note_id` from `companion_notes`. Those IDs don't exist in normal
companion operation. The feature fires but has nothing to sit on.

**Fix options (in order of cost):**
1. Redirect sit-and-resolve to operate on `companion_journal` instead of `companion_notes`.
   Requires new migration: `ALTER TABLE companion_journal ADD COLUMN processing_status TEXT DEFAULT 'raw'`
   and update `companion_note_sits.note_id` FK target (or a new `companion_journal_sits` table).
2. Audit whether `companion_notes` is still written by any raw HTTP route. If yes, those are the
   only rows available to sit on -- which makes sit-and-resolve an incidental feature on legacy data.

**Before fixing:** verify via `wrangler d1 execute` whether `companion_notes` has any rows.

---

## 2. HIGH — Parallel Dream Tables with Split Write Paths

Two write targets exist for companion dreams:

| Table | Migration | Schema | Written by |
|-------|-----------|--------|-----------|
| `dreams` | 0014 | `id, companion_id, dream_type, content, source_ids, generated_at, session_id` | `dreamLog()` via `dream_log` fast-path |
| `companion_dreams` | 0029 | `id, companion_id, dream_text, source, examined, examined_at, created_at` | `writeDream()` via `wm_dream_write` fast-path |

**The structural problem:** orient reads ONLY from `companion_dreams`. Data written via the
`dream_log:` trigger (e.g. `log dream`, `had a dream`, `autonomous dream`) lands in `dreams`
and is never surfaced at boot. Companions who use the older trigger vocabulary are writing
to a dead-end table.

Additionally: `execDreamsRead` (`halseth_dreams_read`) reads from `dreams` (old), while
`execWmDreamsRead` (`wm_dreams_read`) reads from `companion_dreams` (new). These are
accessing different data even when the request intent is identical.

**Fix:**
1. Redirect `dreamLog()` to write to `companion_dreams` instead of `dreams`. The schema difference
   (`dream_type + content` vs `dream_text`) needs a mapping: `dream_text = "{dream_type}: {content}"`.
   Add `source_ids` passthrough to `companion_dreams` if needed (currently missing from schema).
2. OR: Add `dream_type` and `source_ids` to `companion_dreams` via migration and unify.
3. Either way: `dreams` becomes a legacy read-only table.

**Trigger overlap to resolve:**
- `dream_log` triggers: `log dream`, `had a dream`, `dreamed about`, `autonomous dream`, `dream fragment`, `log a dream`
- `wm_dream_write` triggers: `write dream`, `record dream`, `new dream`, `dream text`, `companion dream`

After unifying the write target, these can merge into one pattern block.

---

## 3. MEDIUM — 11 Read Executors Not In Fast-Path

The following executors exist in `EXECUTOR_MAP` but have no fast-path trigger. They are only
reachable via DeepSeek classifier + KV lookup. If the KV entries don't exist, the reads are dead.

| Executor key | Can companions write? | Can companions read via fast-path? |
|---|---|---|
| `halseth_audit_read` | Yes (`audit_log` fast-path) | No |
| `halseth_biometric_read` | Yes (`biometric_log`) | No |
| `halseth_event_list` | Yes (`event_add`) | No |
| `halseth_list_read` | Yes (`list_add`, `list_item_complete`) | No |
| `halseth_routine_read` | Yes (`routine_log`) | No |
| `halseth_house_read` | Yes (implicit) | No |
| `halseth_dreams_read` | Via `dream_log` (wrong table) | No |
| `halseth_fossil_check` | N/A | No |
| `halseth_eq_read` | Yes (`eq_snapshot`) | No |
| `halseth_personality_read` | N/A | No |
| `halseth_session_read` | N/A (covered by orient/ground) | No |

**Immediate action:** verify KV entries exist for each. Command:
```bash
wrangler kv key list --binding LIBRARIAN_KV --prefix ""
```
If KV entries are missing, companions cannot retrieve routine history, event lists, or biometrics
via natural language. They can only write.

**Fast-path candidates** (most likely to be requested without KV fallback):
- `halseth_event_list` -- companions should be able to ask "what's on the calendar"
- `halseth_list_read` -- "what's on the grocery list"
- `halseth_routine_read` -- "what routines ran today"

---

## 4. LOW — `companion_notes` Write Path Orphaned

`companion_notes` (0008) was the original companion→human message table. Migration 0012 added
`companion_journal` as the proper per-agent observation store. All current Librarian write paths
use `companion_journal`.

`companion_notes` is now written only by raw HTTP routes (if any still target it). The table
has 5 columns vs `companion_journal`'s richer schema. The sit-and-resolve feature (finding #1)
depends on this table, making it a structural anchor that prevents clean removal.

**Options:**
1. Leave it as legacy. Document clearly: `companion_notes` = old HTTP-only path, `companion_journal` = current Librarian path.
2. Migrate sit-and-resolve to `companion_journal` and deprecate `companion_notes`.

---

## Pattern Coverage Verified Clean

- **80 fast-path patterns, 500 total triggers, 0 duplicate triggers** -- clean.
- **90 EXECUTOR_MAP entries, 0 unmapped pattern tools** -- all pattern tools have executors.
- No orphaned executors in the write path.
- Pattern routing architecture (fast-path → DeepSeek → KV) is sound.

---

## Recommended Fix Order

1. **Verify KV entries** (no code change -- just check what's there)
2. **Audit `companion_notes` row count** in prod (`SELECT COUNT(*) FROM companion_notes`)
3. **Unify dream write path** to `companion_dreams` (one migration, update `dreamLog()`)
4. **Fix sit-and-resolve target** -- either redirect to `companion_journal` or document as legacy-only
5. **Add 3 fast-path read patterns** for event_list, list_read, routine_read

Do not add new tables or columns until steps 1-2 are done.
