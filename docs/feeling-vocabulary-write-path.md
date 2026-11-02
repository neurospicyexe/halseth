# Feeling-line write path (STATUS B5 + B6)

Code: `src/webmind/vocabulary-write.ts` (logic), `src/handlers/feeling-vocabulary.ts` (HTTP),
guards B and F in `src/webmind/vocabulary-guards.ts`. Tests: `src/__tests__/feeling-vocabulary-write.test.ts`.
No migration (0161 not used): the table is 0131, and the write path only INSERTs and flips `status`.

## Routes

- `POST /mind/feeling-vocabulary` proposes one row. A companion token is that companion (naming a sibling is 403);
  the admin secret must name `companion_id`. `dry_run: true` runs every gate and writes nothing (the read-back step).
  201 written, 200 dry run, 422 refused (all reasons at once), 503 unreadable or 0131 not applied.
- `GET /mind/feeling-vocabulary?companion_id=<id>&status=active|superseded|rejected|all`.

## Gates, in the handoff's order (all report together)

| gate | refuses |
|---|---|
| B | a word two companions used inside one 60-minute window in `companion_journal` (14-day lookback), originator included; returns the sightings. An unreadable journal refuses (fails closed). Reports `decontaminating` when a revision moves off a contaminated word. |
| F | sibling float labels, band names, write-verbs, table names, substrate, canon, any other companion's committed word, the author's own never-list; a never row that would bar a live word. |
| G | clauses the evaluator cannot fire: unknown keys, bands off the ladder, threshold without a value, unsatisfiable same-float bands. Arity is `conditions.length` (kept is a triple, kethrun a quad), capped at 8. Divergence is one clause, Drevan only. |
| D | `cause_kind='tick'` (renders silent, so the row could never speak); any cause on a divergence or never row. |
| C | specificity is computed (clauses, +1 for a bound cause); a claimed number that differs is refused; an identical condition+cause twin is refused; a same-specificity row sharing a clause is a warning. |
| A | `authored_on` required, `authored_at` parseable and not future (default now), `capture_id` must exist in `wm_continuity_notes` (warning when absent). |
| E | `supersedes` must be the author's own ACTIVE row of the same kind; insert + flip are one batch; the old row's words are never edited. Restating a live word without `supersedes` is refused. |

No gate rewrites, trims inside, renames or deletes a companion's words. `FEELING_LINE_MODE` is untouched; a new row is
active, so in `shadow` it is computed and logged only.

## Not built: the bot surface (a Discord piece)

It needs: a Librarian verb or fast-path (for example `<p>: feeling word ...`) that calls this route with
`authored_on: "discord"`; a two-step flow (dry run, read the row back to the author in their own words, then confirm),
because read-back is what caught all three 09-19 failures; writing the author's statement to `wm_continuity_notes` first
so `capture_id` is real; and surfacing the refusal `reason` plus `evidence` verbatim (never a suggested replacement word).
A withdraw verb (author retires a word with no replacement) and a never-list lift are also not built.
