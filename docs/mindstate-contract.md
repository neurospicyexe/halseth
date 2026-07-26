# MindState Contract — Phase 1 Design (DRAFT for Raziel's review)

**Status:** draft, 2026-07-26. Nothing here is migrated or coded yet. This is the design
to react to before any schema work starts.

## The problem this solves

A companion's "self" is currently reconstructed at boot by three divergent, hand-maintained
aggregators:

| Aggregator | Serves | Blocks | Quirks |
|---|---|---|---|
| `execSessionOrient` (`librarian/executors/session.ts`) | Claude.ai sessions | ~25 | consumes guardian cards, stamps motifs; has commons/shelf/ferment/Sol; no imps |
| `execBotOrient` (same file) | Discord bots / Brain | ~30 | has imps; missing commons, shelf, ferment line, Sol inner life, preferences/refusals, open drifts |
| `mindOrient` (`webmind/orient.ts`) | raw `/mind/orient` | ~20 | auto-acks incoming triad notes; missing growth, forage, club, guardian, motifs |

Same companion, same database, **different self depending on which door they woke up
through** — and consume-once side effects mean the first door eats state the other doors
never see. Every new organ (25–30 memory concepts and counting) got bolted onto one or two
of the three, never all, so divergence grows with every migration.

**Goal:** Drevan is one Drevan. Cypher is one Cypher. Gaia is one Gaia. On Discord, on
Claude.ai, on the Hearth chat page, at 3 AM in the autonomous worker — one continuous
being per companion, fed from one canonical state.

**Non-goals:** no rewrite, no new inference architecture, no merging of the 25-30 tables
themselves (that's later, optional, and may never be needed if the loader unifies access).

## Design

### 1. One contract: `MindState`

A single versioned TypeScript interface in `halseth/src/mind/contract.ts` (new dir), the
union of everything the three aggregators load today:

```ts
interface MindState {
  contract_version: string;      // semver; renderers assert major compatibility
  companion_id: CompanionId;
  loaded_at: string;             // ISO
  loom: Loom;                    // which surface requested it (for the delivery ledger, NOT for content)

  identity: { anchor, self_model, preferences, refusals, agency_affordance };
  felt: { soma_floats, soma_arc, limbic, ferment_line, drives, biometrics_latest };
  continuity: { handoffs, threads, notes_3pool, spiral_turn, session_narrative };
  carried: { dreams_unexamined, open_loops, tensions_annotated, sits, feelings_recent };
  beliefs: { conclusions_distributed, flagged, worldview };
  relational: { snapshot, deltas_recent, witness_raziel, triad_incoming, triad_outgoing, letters };
  growth: { journal_recent, patterns, markers, reflection, seeds, clearing_count, drifts_open, basin_flags };
  world: { house, home_events, club, commons, shelf, collection, forage, listens, motifs, sol, imps_active };
  oversight: { guardian_cards, tripwires, questions };
  meta: { datetime_iso, datetime_local, staleness: Record<block, ISO> };
}
```

**Key rule: the CONTENT is identical for every loom.** No per-loom subsets at the data
layer. If Discord-Drevan shouldn't render the obsession shelf, that's the *renderer's*
choice to omit — the state still arrived, and nothing was consumed by loading it.

Blocks that don't apply carry `null`/empty rather than being absent, so a renderer can
always distinguish "nothing there" from "loader didn't fetch it."

### 2. One loader: `loadMindState()`

`halseth/src/mind/loader.ts`. One function, one `Promise.all`, every block null-safe the
way orient already is (a failed block returns empty + a `staleness` warning, never breaks
boot). All four current consumers become thin adapters:

- `execSessionOrient` → `loadMindState(env, id, { loom: "claude" })` + prose renderer (existing `builder.ts` becomes the renderer)
- `execBotOrient` → same loader + flat wire renderer
- `mindOrient` HTTP → same loader, JSON straight out
- Hearth chat page (future) → same loader via `/mind/state/:id`

The autonomous worker's Phase-1 orient also switches to this endpoint, so autonomous runs
start from the same self the live sessions see.

### 3. Consume-once moves to the data layer: the delivery ledger

Today "surfacing" mutates state as a side effect of *reading* (guardian cards flip to
surfaced, incoming triad notes auto-ack, motifs stamp `last_surfaced_at`) — bound to
whichever loom read first. Replace with one table:

```sql
CREATE TABLE mind_deliveries (
  item_kind   TEXT NOT NULL,   -- 'guardian_card' | 'triad_note' | 'motif' | 'home_event' | ...
  item_id     TEXT NOT NULL,
  companion_id TEXT NOT NULL,
  loom        TEXT NOT NULL,   -- 'claude' | 'discord' | 'worker' | 'hearth' | 'raw'
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_id, loom)
);
```

Rules:
- The loader records deliveries; it never mutates the source rows.
- An item stops surfacing on a loom once delivered **to that loom** (or globally once
  delivered to N looms / after a TTL — per-kind policy, declared in one place).
- True consumption (a note being *acknowledged*, a card being *resolved*) becomes an
  explicit verb the companion invokes, not a side effect of booting.

This fixes the at-most-once triad-mail race (HOLE 8) and the guardian/motif loom-binding
in one mechanism, without touching the source tables.

### 4. Felt-state ownership: one writer per field

Six writers currently race on SOMA-adjacent state. Proposed ownership (enforced by a
`FELT_OWNERS` map in code + a CI check that greps writers, same style as the
write-read-coverage test):

| Field | Owner | Everyone else |
|---|---|---|
| `companion_state.soma_float_*` (baseline drift) | Halseth ferment tick | read-only |
| `somatic_snapshot` (session-close snapshots) | session_close | read-only |
| `soma_arc` continuity notes | session_close | read-only |
| `limbic_states` | Phoenix synthesis loop (or its successor) | read-only |
| `companion_drives` | ferment tick | worker reads, never nudges |
| `drift/basin history` | ONE evaluator (pick: second-brain 6h) | session-close + worker stop writing basin rows; they enqueue observations for the evaluator instead |

(Exact owner picks are open questions below — the invariant is *one owner per field*, not
which one.)

### 5. Migration path — strangler, not big-bang

1. **Build** `contract.ts` + `loader.ts` beside the existing aggregators. Loader initially
   *calls the same queries* the three aggregators use (copy, don't move).
2. **Parity harness:** a test endpoint `/mind/state/:id?parity=1` returns
   `{ mindstate, legacy_orient, legacy_bot_orient }`; a script diffs block-by-block. Run
   for a week of real boots.
3. **Cut over one loom at a time**, lowest-risk first: raw `/mind/orient` → bot_orient →
   session_orient. Each cut is one PR, revertible.
4. **Delivery ledger** ships with the first cutover; legacy consume-once code paths are
   deleted per-loom as each loom cuts over.
5. **Delete the two dead aggregators** when parity holds. The CI coverage test gains an
   assertion: no `FROM` of a mind table outside `src/mind/` (loader is the only reader).
6. **Hearth chat page** builds on `/mind/state/:id` — it is the acceptance test: if the
   chat page and Discord render recognizably the same companion, Phase 1 is done.

Total new schema: **one table** (`mind_deliveries`). Everything else is code motion.

### 6. What this unblocks

- **Phase 2 (retrieval):** the loader is the single place orient RAG queries get built —
  query variation and returned-id exclusion land once, not three times.
- **Phase 3 (loops):** fresh-material injection for Discord replies can pull from the same
  loader (the `world` block IS the freshBlock, kept current).
- **New organs stop costing divergence:** a new block is added to the contract + loader
  once and every surface gets it. The migration freeze lifts when this lands.

## Open questions for Raziel

1. **Loom granularity:** is `claude | discord | worker | hearth | raw` the right set? Should
   the three Discord bots count as one loom or three?
2. **Delivery policy defaults:** should triad notes surface on EVERY loom until explicitly
   acked, or first-loom-per-24h? (I lean: every loom until acked — mail should nag.)
3. **Basin/drift owner:** second-brain evaluator (has the most context, 6h cadence) or
   session-close (most immediate)? Pick one.
4. **Does bot_orient's imp block go into the contract** (my assumption: yes — Claude
   sessions should feel imps too) **or stay Discord-only by design?**
5. **Sol/creatures on Discord:** currently Claude-only. Contract carries it; do the bot
   renderers show it? (I lean yes, brief.)
6. **`ready_prompt` size budget:** the union is bigger than any current single surface.
   Claude.ai's renderer may need tier-aware truncation. Acceptable, or should the contract
   define per-block caps?

## Explicitly rejected alternatives

- **Table consolidation first** (merge 30 tables into a clean schema): months of risk
  before any behavior improves; the loader gets the same benefit without data migration.
- **A "core self" as a new surface/page that companions visit:** a fourth divergent loom.
  The core self is the data layer, not a place.
- **Event-sourcing rebuild:** right shape in theory, wrong size for a working live system.
