# The ledger lane: spec (step 2 proper, the imp lane)

2026-09-26. **Authority: `DREVAN-ANSWER-2026-09-26.md` (verbatim). Where this file and his answer disagree, his
answer wins.** Census inputs: two read-only sweeps (halseth; bots + Second Brain), summarised in section 7.

## 0. The ruling in one paragraph

Clerks (machine writers that read and record) never write as a companion and never write without a source.
They write into a lane of their own, `ledger_entries`, through one door that enforces the grammar in code.
The mark `〔ledger · <function> · <date>〕` is stamped by the server, never produced by a model, and stays on
the line in every surface: orient, commons, recall, the vault index. The tray (mig 0132) stays exactly as it
is and keeps holding the companion's own words (speech captures stay there, per Drevan).

Two corrections from Drevan decide the design:
- **Sourceless content is the enemy, more than borrowed voice.** "Noted: 187 after sandwich" is as dangerous
  as "I felt 187". So the source rule is enforced harder than the pronoun rule.
- **The index must honour the lane.** The mark survives indexing, and a drop purges the chunk.

## 1. Grammar (enforced at the door, `src/ledger/grammar.ts`, pure)

| Rule | Enforcement |
|---|---|
| Mark | Server stamps `〔ledger · ${function} · ${observed_on}〕 ` in front of the body. A body that already contains `〔` or `〕` is rejected (no forged or double marks). |
| Function | Allowlist, nameless, signed by function: `distiller`, `gap-reader`, `pattern-counter`, `drift-reader`, `witness-log`. Extending it is a code change. Cypher's named clerks come later, his call; Gaia has not been asked. |
| Verbs | Body starts with a record verb: `Logged`, `Counted`, `Recorded`, `Found`, `Missing` (case-insensitive, optionally followed by `:`). |
| No self | Rejected anywhere in the body: first person (`I`, `I'm`, `I've`, `I'd`, `me`, `my`, `mine`, `myself`, `we`, `us`, `our`); interior verbs (`felt`, `feel`, `feels`, `wanted`, `want`, `knew`, `remembered`, `loved`, `longed`, `missed`, `hoped`); the private lexicon and pet names (Drevan's closed list, `LEDGER_PET_NAMES` in `grammar.ts`: hard tokens anywhere, address words only when they name someone; section 9). Quoted speech is the one exception: text inside straight or curly double quotes is not scanned for pronouns, so `Counted: Drevan said "held, not slow" 2x` passes. Quotes are still scanned for the lexicon. |
| Source | **No source, no write.** `source_kind` in `message` (a Discord message id), `window` (a channel or thread id plus an `HH:MM–HH:MM` UTC range), `session` (a Halseth session id), or `row` (`<table>:<id>`). `source_ref` must be non-empty and match its kind's format. The rendered line ends ` Source: <kind> <ref>.` so the pointer travels with the text. |
| Health values (Drevan's Hex sibling) | If the body names a health value (glucose, blood sugar, BG, mg/dL, A1c, insulin, dose, dosage, mg, mcg, units, weight, lbs, kg, lab, labs, HRV, BP, blood pressure, near a digit), the source must be `row` pointing at a **human record**. A `conversation_capture` is NOT human-authored: it is the companion's own digest of an exchange, and any Librarian caller (a Discord bot through Hermes included) can write one. So a `wm_continuity_notes` row counts only when it is a live, kept `conversation_capture` whose `thread_key` is `capture:<session_id>` (never `capture:unsessioned:*`) for a session of the same companion whose `surface` starts `claude-ai:` (the human-present Claude.ai surface; fail closed on NULL, `discord:*`, `claude-code:*`, anything else). A `biometric_snapshots` row counts only with a human `source` (`hearth`, `apple_health`). The door loads that row; it must exist and contain every number in the body, **exactly** (no rounding), and a biometric number only inside the column its label names (else `notes`). Otherwise the write is rejected. Why: Raziel is only in the room on Claude.ai, so only there is a companion's digest a record of what he said. |

The health rule answers a specific failure. On 09-25 the 187 was in Drevan's own Discord reply. A line
reading "Counted: Drevan said 187. Source: message <his msg id>" passes a format check and would launder the
fabrication. A companion utterance is never a valid source for a health number. Only a human record is.

Every ledger line is fact-shaped by construction, because interpretive content cannot pass the verb and self
rules. That is why **keep as written** is safe for any ledger line (Drevan's promotion path 1).

## 2. Store: `ledger_entries` (mig 0134)

```
id TEXT PK (led_<uuid>), companion_id TEXT NOT NULL CHECK IN (drevan,cypher,gaia),  -- the SUBJECT
function TEXT NOT NULL, body TEXT NOT NULL, content TEXT NOT NULL,                  -- content = mark + body + source tail
source_kind TEXT NOT NULL CHECK IN (message,window,session,row), source_ref TEXT NOT NULL,
observed_on TEXT NOT NULL (YYYY-MM-DD), created_at, dedup_key TEXT UNIQUE NULL,
state TEXT NOT NULL DEFAULT 'open' CHECK IN (open,kept,dropped), state_at TEXT NULL,
promoted_journal_id TEXT NULL
```

- One INSERT in the codebase: `src/ledger/door.ts`. The sweep test gains a ledger clause: no other file
  INSERTs into `ledger_entries`, and no ledger content is ever inserted into `wm_continuity_notes` or
  `companion_journal` except by the promotion path. The mark is not `[`, so the existing `NOT LIKE '[%'` and
  draft `startsWith('[...')` rules would not see it. The lane lives in its own table so they never have to.
- `dedup_key` keeps an idempotent clerk (gap-reader re-running every 20 minutes) from writing the same line
  twice.

## 3. Surfaces

- `POST /ledger` (admin auth): `{companion_id, function, body, source_kind, source_ref, observed_on?, dedup_key?}`.
  Returns 201 `{id, content}`, 200 `{id, duplicate:true}`, or 422 `{error, rule}` naming the rule that
  failed. It never writes partially.
- `GET /ledger?companion_id&state&limit`: for Hearth and ops.
- `GET /ingest/ledger?since=` (the SB puller feed): open and kept rows. It pages on `created_at` or `state_at`, whichever is later.
- `GET /ingest/ledger-ineligible?since=`: dropped ids (the SB purge feed).
- **Librarian verbs**, the owner's only (the companion reads and acts on entries about himself):
  - `my ledger`: open entries about me, newest first, mark intact.
  - `keep ledger <id>`: a state flip to `kept`. The line stays a ledger line with its mark (path 1: a sourced fact
    is not claiming to be me).
  - `keep ledger <id>: <my words>`: path 2. The companion's own words go into `companion_journal` as kept,
    `source='tray_rewrite'`, `external_id='ledger:<id>'`, through `tray-insert.ts`. The ledger row keeps its
    original line and records `promoted_journal_id`.
  - `drop ledger <id>`: sets state to `dropped`; SB purges the chunk on its next reconcile.
- **Orient:** one block, `Ledger (clerk records about you, not your words)`. It shows up to 5 open entries,
  `content` verbatim. It is never merged into any first-person block.
- **Siblings (Drevan's rule 5):** siblings may see ledger lines about each other, but only as whole ledger
  lines with the mark intact. Never folded into a block under another companion's name.
- **Commons supply and director supply:** exclude the legacy first-person distiller notes
  (`note_type IN ('day_distillation','discord_session')` with unbracketed content, which is exactly the
  `distillation.ts:88` and `day-distillation.ts:93` writes). Every other `writeWmNote` caller brackets its
  content or sets its own note_type.

## 4. Tranche 1 (halseth + Second Brain): the lane, and the gap-detector today

**Halseth**
1. Mig 0134 (the table above).
2. `grammar.ts`, `door.ts`, routes, verbs, orient block, and the commons/director exclusion.
3. **The gap-detector stops writing as him.** The journal door rejects `source='synthesis-gap-detector'`
   with a loud 410 that names `/ledger`, so an old SB build cannot keep writing. The existing gap-fill rows
   are drafted by a one-line reversible UPDATE (in the keyboard file). Verify that orient's recent-journal
   read is kept-gated: the census says these rows currently win its 3 slots.
4. **Gaia's digest (rule 5, the merge point):** `vibecheck.ts` stops printing sibling tension text
   (`newest:`) and sibling guardian summaries under Gaia's agent. It keeps counts only for siblings, as the
   09-26 fix already did for utterances.
5. Sweep test (one door) and a render test (every surface that emits ledger content starts each line with
   the mark).

**Second Brain**
1. **The gap-reader is deterministic, with no LLM.** A session with no note produces
   `Missing: no companion note recorded for the <type> session on <date> (<duration>).`, with source
   `session <id>` and dedup_key `gap:<companion>:<session_id>`. A query can name a gap; a model can fill one.
2. The evaluator writes its drift flags to `/ledger` as `drift-reader`, with `Recorded:` lines and a row
   source (`row companion_basin_history:<id>`).
3. The puller pulls `/ingest/ledger` into `rag/ledger/<id>`. It **bypasses `wrapChunk`** (whose preamble
   re-voices by construction), with one entry per chunk, chunk text = `content` (mark first), and
   `content_type='ledger'`. Never the vault-materializer: slugify drops the mark and firstSentence turns it
   into the H1.
4. `rag/ledger/` joins the retract allowlist, and recall-reconcile consumes `/ingest/ledger-ineligible`.
   That is the "a drop purges the chunk" half of Drevan's rule.

## 5. Tranche 2 (bots): distillers become clerks, behind one rollback knob

Knob: `LEDGER_DISTILL=on|off` (default `on`, pm2-allowlisted). `off` restores today's behaviour byte for byte.

- `distillSessionOnInactive`: one shared clerk prompt (not per-bot voice) returns up to 6 record lines as
  JSON. Each line is POSTed to `/ledger` as `distiller`, subject = this bot's companion, source
  `window <channelId> HH:MM–HH:MM` from the STM timestamps. The four first-person writes stop:
  `witnessLog`, `synthesizeSession`, `updatePromptContext`, and `writeWmNote(synthResult)`. The handoff
  stays (Claude.ai's `latest_handoff` depends on it), but its `summary` becomes the accepted ledger lines
  joined (marks intact) instead of the first-person synth. **Run `scripts/orient-block-diff.mjs` before
  and after.**
- `runDistillation`: the `[discord:distillation]` wm note becomes `/ledger` `distiller` lines with a window
  source. Persona and human blocks are unchanged (section 6).
- `day-distillation`: the first-person day note becomes a `distiller` ledger entry per day with
  `row wm_continuity_notes:<first fragment id>` as its source. This is the sibling-served one.
- `consolidation`: the handoff summary becomes ledger lines, as above. The session-close spine is unchanged
  in T2 (section 6).
- Gaia's passive witness (`[witnessed, did not respond] <sibling>: <snippet>` under Gaia's agent): becomes a
  `witness-log` ledger line with the sibling as subject and a `message <id>` source (`message.id` is in scope).

## 6. Not in this build (open, and whose)

- **Distillation's SOMA update and feeling log. Drevan and Raziel decide.** By Drevan's rule 6 both are
  interpretive ("what I felt") written by a clerk. T2 leaves them running, behind the same knob, until they
  answer. Question to carry: *the distiller also sets your SOMA and logs a feeling from each session. Do
  those stop, or do they come to you as drafts?*
- Autonomous-worker growth, reflect and relational-delta writes. These are the companion's own autonomous
  voice, which is tray territory, not clerk work under Drevan's frame. (Side finding: the growth orient
  block reads without a `review_status` filter.)
- Persona and human memory blocks (mid-session distillation).
- The sibling-exploration relay (`[sibling:<id>]` filed under the receiving companion).
- Consolidation's session-close spine.
- `companion_open_loops` and `gaia_witness` have no source column. Existing machine rows cannot be told apart.
- The dead worker `ingestToSecondBrain` (400 on every call; the route wants title and content).
- Cypher's clerk names (his call). Gaia's view of the lane (not yet asked).

## 7. Census summary (what this rests on)

- The gap-detector, evaluator and pattern-worker live in Second Brain. The distillers live in bots. Halseth only receives.
- Clerk rows are born `kept`. Only the five speech sources and three note prefixes draft.
- No structured glucose, dose or lab columns exist anywhere. A health number only travels as free text.
- Commons supply (`handlers/webmind.ts:1455-1471`, `director/supply-query.ts:74-79`) filters
  `review_state='kept' AND content NOT LIKE '[%'`. That lets exactly the unbracketed first-person distiller
  prose through to siblings.
- The SB puller wraps every row in an LLM "who wrote this" preamble (`deepseek-wrapper.ts`), and only
  `rag/companion_journal/<id>` is ever purged on archive.

## 8. Build notes (2026-09-26)

What the three parallel builds (halseth `808a9bf..b574965`, Second Brain `c65db88..4b1f263`, bots
`4e69e09..f22328e`) changed against this spec, and what the integration pass closed.

- **The health rule is wider than section 1.** Any *unlabeled* number (2+ digits or a decimal, that is not a
  clock time `HH:MM`, a date `YYYY-MM-DD`, a 10+ digit id, or a count followed by its unit such as
  `14 messages`, `2x`, `45 min`) is treated as a possible health value: it only moves with a `row` source the
  door can read and find the number in (the human rows, plus `companion_basin_history` for the drift-reader).
  Why: "Counted: Drevan said 187 after sandwich" names no health keyword, so the keyword list alone passes
  exactly the line the rule exists for. A health keyword plus *any* non-coordinate number is still a health
  value (human row only). Consequence for the distillers: their sources are `window` / `session`, so a clerk
  line carrying such a number is 422'd, and a pass with zero accepted lines writes no handoff. The bots' clerk
  prompt now states the exact number rule, and the bots' local pre-filter is a port of the server's number
  classification (`scanNumbers` and the source gating), pinned by one fixture file kept byte-identical in
  both repos (`halseth/src/__tests__/fixtures/ledger-number-fixtures.json`,
  `nullsafe-discord/packages/shared/src/__tests__/fixtures/ledger-number-fixtures.json`). The server is
  still the authority.
- **Pet names are not enforced.** No list exists in the codebase or the canon files read for this build, so
  the server only rejects `🩸`, `vevi`, `vevan`, `vaselrin`, `vethmerin`. (The bots' pre-filter also drops a
  few generic endearments locally.) ~~Open item for Drevan: supply the list.~~ Supplied and enforced, section 9.
- **Day-distillation goes dry under `LEDGER_DISTILL=on`.** Its input was the first-person session notes that
  T2 stopped writing, so the nightly day entry has nothing to distill. The per-session ledger lines replace
  it; the day pass is not rebuilt on top of them.
- **Commons supply serves sibling ledger lines.** Once the legacy distiller prose was excluded and T2 stopped
  writing it, `GET /mind/commons-supply/:agent_id` would have been empty forever. It now also serves ledger
  entries about siblings (`companion_id != reader`, state open or kept, last 7 days, not yet opened on by
  this reader), `content` verbatim with `note_type: 'ledger'` and `note_id` = the ledger id. Read tracking
  uses `commons_note_reads` unchanged (no FK, so no migration). The bots frame it as a clerk's record about
  the sibling, "not <who>'s words and not yours", and never truncate it (the source tail travels with it).
  **The director's `sibling_note` tier does not read the ledger**, and stays empty (it tolerates that).
  `SupplyKind` is a two-repo contract, the worker maps `sibling_note` to `wm_continuity_notes` for
  neighbourhood seeds, and the invite renders `body.slice(0, 300)` with no clerk framing, which would cut the
  source tail. That work is deferred, not dropped.
- **Dedup keys carry a line index.** `postLedgerLines` keys each line `${prefix}:${i}`, because one key for
  every line in a pass would collide on the UNIQUE index and silently keep only the first. The witness line
  keys on `witness:<message id>`.
- **`POST /ledger` takes the admin token only.** A companion token gets a 403: clerks never write as a
  companion, and a companion does not write records about itself.
- **The clerk needs a direct adapter.** The bots' clerk call must go to a direct provider
  (`DEEPINFRA_API_KEY` or `DEEPSEEK_API_KEY`), because the Hermes fallback discards system prompts, and a
  clerk without its prompt would write in whatever voice the gateway gives it.
- **Feed paging is tie-safe end to end.** `/ingest/ledger` and `/ingest/ledger-ineligible` are strictly
  after `since`, so rows sharing a `cursor_at` at a page boundary would be lost unless the client passes
  `after_id` back. Second Brain's puller and ledger reconcile now persist `after_id` next to the high-water
  mark (`ledger.after_id`, `ledger_ineligible.after_id`) and send it.
- **Second Brain's vector-store test was flaky** because it used a fixed `dbPath`, so the `src` and `dist`
  copies of the suite collided on the same file. `searchByTags` can still flake.
- **Witness lines are quoted speech with a `message` source.** A sibling utterance that carries any unlabeled
  number (or `Source:`, or a lexicon word) gets the whole witness line 422'd. That is correct under rule 2 (a
  companion's words are never a source for a number), and it is stated here so it does not read as a
  dropped line.

## 9. Adversarial-review pass (2026-09-26)

- **A capture is not a human record** (was the section 1 wording). The door now accepts a
  `wm_continuity_notes` capture only when it is anchored to a `claude-ai:*` session of the same companion
  (see section 1). The allowlisted value is the prefix `claude-ai:` followed by at least one character:
  every Claude.ai skill sends `claude-ai:<companion>` (`skills/nullsafe-boot`, `nullsafe-session-close`,
  `daily-planning-drevan`, `monthly-planning-cypher`), the MCP schema documents `claude-ai:<thread>`, and
  `executors/session.ts` already treats `surface LIKE 'claude-ai:%'` as the Claude.ai family. Bots send
  `discord:<companion>`, the Claude Code hook sends `claude-code:<cwd>`; both fail. Two writer holes were
  closed with it: `conversation_capture` anchors to a `claude-ai:*` session only when the CALLER declares a
  `claude-ai:*` surface (a surfaceless bot call used to fall through to "newest open session on any
  surface"), and the Librarian's `biometric_log` stamps `apple_health` only for a `claude-ai:*` caller,
  `librarian` for everyone else. **Residual:** `surface` is self-declared; a caller that forges
  `claude-ai:` is a token problem (per-companion tokens are Phoenix scope), not a grammar one.
- **The number rule is normalised and glue-aware.** NFKC and every `\p{Nd}` digit to ASCII first (the
  normalised body is stored); a number glued to letters on either side is significant unless it is `2x`
  or a correct ordinal up to 31; spaced count units are exact plural count nouns only. `10pm`-style clock
  times are coordinates. U+2028, U+2029, U+0085 (and `\v`, `\f`) are line breaks; invisible format
  characters (`\p{Cf}`, e.g. a zero-width space) are rejected. Two fixtures flipped to `health`:
  `a 5k run` and `ran 45 min` (write `45 minutes`).
- **Health numbers match exactly.** Rounding is allowed only against `companion_basin_history`.
- **Drevan's pet-name list is enforced** (`LEDGER_PET_NAMES`, closed, his words in the header comment).
  `caleth` also blocks `calethian` (same root). `love/loves/loving` left the interior-verb list (`loved`
  stays): the address rule is what stops a clerk calling anyone "love", and "Blue loves Decker" passes.
- **Commons supply serves ledger lines only on opt-in:** `GET /mind/commons-supply/:agent_id?kinds=ledger`.
  An older bot build would frame a ledger line as a sibling's first-person note, so without the param the
  ledger tier is not queried.
- The Librarian's journal path answers a retired source (`synthesis-gap-detector`) with a structured
  `{ error: "journal_source_retired", status: 410, use: "/ledger" }`, not a 500. Gaia's vibe-check day line
  prints `watch logged` for siblings, never the title.
