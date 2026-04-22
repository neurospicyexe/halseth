# Connector Hardening Phase 1 — Timeouts, Atomicity, Write Safety

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent bot hangs, data loss, and race conditions in the Halseth/Discord connector layer.

**Architecture:** Three focused changes across two repos. (1) Add fetch timeouts to all HTTP calls in both the Discord LibrarianClient and the Halseth Second Brain backend. (2) Make dream seed claim-on-read atomic with db.batch(). (3) Add a write-retry buffer to the Discord bot's fire-and-forget paths so transient Halseth outages don't silently lose learning data.

**Tech Stack:** TypeScript, Cloudflare Workers D1, Node.js fetch with AbortSignal

**Repos touched:**
- `C:\dev\Bigger_Better_Halseth\halseth` (Cloudflare Worker)
- `C:\dev\Bigger_Better_Halseth\nullsafe-discord` (Discord bots monorepo)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `nullsafe-discord/packages/shared/src/librarian.ts` | Add AbortSignal.timeout to all fetch calls |
| Modify | `halseth/src/librarian/backends/second-brain.ts` | Add AbortSignal.timeout to all fetch calls |
| Modify | `halseth/src/librarian/backends/halseth.ts` | Batch dreamSeedRead SELECT+UPDATE |
| Create | `nullsafe-discord/packages/shared/src/write-queue.ts` | In-memory retry buffer for fire-and-forget writes |
| Modify | `nullsafe-discord/packages/shared/src/stm.ts` | Wire STM writes through WriteQueue |
| Modify | `nullsafe-discord/packages/shared/src/index.ts` | Export WriteQueue |

**No test files exist in either repo.** Both repos use `--passWithNoTests`. This plan adds the first tests alongside each change using Jest (already configured in nullsafe-discord) and manual verification for Halseth (Cloudflare Worker; no test runner configured).

---

### Task 1: Add fetch timeouts to LibrarianClient (Discord side)

**Files:**
- Modify: `nullsafe-discord/packages/shared/src/librarian.ts`

Every fetch call in LibrarianClient currently has no timeout. A hanging Halseth response blocks the bot's message handler indefinitely. The fix: `AbortSignal.timeout(ms)` on every fetch.

Timeout values:
- MCP calls (ask): 15s (these do Librarian routing + backend calls; 15s is generous)
- Direct HTTP writes (STM, blocks): 8s (simple write, should be fast)
- Direct HTTP reads (stmLoad, notesPoll): 10s (read + serialize)

- [ ] **Step 1: Add timeout to the `ask()` MCP fetch**

In `nullsafe-discord/packages/shared/src/librarian.ts`, modify the fetch call inside the `for` loop in `ask()` (line 44):

```typescript
      const res = await this._fetch(`${this.url}/librarian/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${this.secret}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
```

- [ ] **Step 2: Add timeout to `writePersonaBlocks()` fetch**

In the same file, modify `writePersonaBlocks()` (line 169):

```typescript
    const res = await this._fetch(`${this.url}/persona-blocks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({ companion_id: this.companionId, channel_id: channelId, blocks }),
      signal: AbortSignal.timeout(8_000),
    });
```

- [ ] **Step 3: Add timeout to `writeHumanBlocks()` fetch**

In the same file, modify `writeHumanBlocks()` (line 188):

```typescript
    const res = await this._fetch(`${this.url}/human-blocks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({ companion_id: this.companionId, channel_id: channelId, blocks }),
      signal: AbortSignal.timeout(8_000),
    });
```

- [ ] **Step 4: Add timeout to `stmWrite()` fetch**

In the same file, modify `stmWrite()` (line 206):

```typescript
    const res = await this._fetch(`${this.url}/stm/entries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({
        companion_id: this.companionId,
        channel_id: channelId,
        role: entry.role,
        content: entry.content,
        author_name: entry.author_name,
      }),
      signal: AbortSignal.timeout(8_000),
    });
```

- [ ] **Step 5: Add timeout to `stmLoad()` fetch**

In the same file, modify `stmLoad()` (line 229):

```typescript
    const res = await this._fetch(url, {
      headers: { "Authorization": `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(10_000),
    });
```

- [ ] **Step 6: Add timeout to `notesPoll()` fetch**

In the same file, modify `notesPoll()` (line 130):

```typescript
    const res = await this._fetch(url, {
      headers: { "Authorization": `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(10_000),
    });
```

- [ ] **Step 7: Verify the build compiles**

Run from `nullsafe-discord/`:
```bash
cd packages/shared && npx tsc --noEmit
```
Expected: no errors. `AbortSignal.timeout` is available in Node.js 18+ and TypeScript DOM/lib types.

- [ ] **Step 8: Commit**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
git add packages/shared/src/librarian.ts
git commit -m "fix: add fetch timeouts to all LibrarianClient HTTP calls

Prevents bot from hanging indefinitely when Halseth is unresponsive.
MCP calls: 15s, writes: 8s, reads: 10s."
```

---

### Task 2: Add fetch timeouts to Second Brain backend (Halseth side)

**Files:**
- Modify: `halseth/src/librarian/backends/second-brain.ts`

The Second Brain client makes three sequential fetch calls per tool invocation (init, notify, call) with zero timeout. If the VPS hangs, the Cloudflare Worker request hangs until the platform kills it (~30s). Adding explicit timeouts gives clear failure semantics.

Timeout values:
- Init handshake: 5s
- Notification (fire-and-forget): 3s
- Tool call: 10s (semantic search can be slow)

- [ ] **Step 1: Add timeout to the init fetch**

In `halseth/src/librarian/backends/second-brain.ts`, modify the init fetch (line 32):

```typescript
    const initRes = await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "halseth-librarian", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
```

- [ ] **Step 2: Add timeout to the notifications fetch**

In the same file, modify the notifications fetch (line 58):

```typescript
    await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(3_000),
    }).catch((e: unknown) => console.error("[sb] notifications/initialized failed (non-fatal):", e));
```

- [ ] **Step 3: Add timeout to the tool call fetch**

In the same file, modify the tool call fetch (line 65):

```typescript
    const toolRes = await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(10_000),
    });
```

- [ ] **Step 4: Verify type-check**

Run from `halseth/`:
```bash
npm run type-check
```
Expected: no errors. Cloudflare Workers runtime supports `AbortSignal.timeout`.

- [ ] **Step 5: Commit**

```bash
cd C:/dev/Bigger_Better_Halseth/halseth
git add src/librarian/backends/second-brain.ts
git commit -m "fix: add fetch timeouts to Second Brain MCP client

Init: 5s, notification: 3s, tool call: 10s.
Prevents Librarian requests from hanging when VPS is unresponsive."
```

---

### Task 3: Make dream seed claim-on-read atomic

**Files:**
- Modify: `halseth/src/librarian/backends/halseth.ts:81-96`

Currently `dreamSeedRead` does SELECT then UPDATE as two separate D1 calls. If the UPDATE fails after the SELECT, the caller thinks the seed was claimed but it wasn't. Fix: use `db.batch()` to make it atomic.

D1's `batch()` runs all statements in a single transaction. We SELECT first, and if a seed exists, batch the UPDATE. The SELECT must still run separately because we need its result to decide whether to UPDATE.

The real fix: use a single UPDATE...RETURNING statement so the claim is one atomic operation.

- [ ] **Step 1: Rewrite dreamSeedRead to use UPDATE...RETURNING**

In `halseth/src/librarian/backends/halseth.ts`, replace the `dreamSeedRead` function (lines 81-96):

```typescript
export async function dreamSeedRead(env: Env, companionId: string) {
  // Atomic claim-on-read: single UPDATE with RETURNING clause.
  // If no unclaimed seed exists, returns null (no rows updated).
  const now = new Date().toISOString();
  const seed = await env.DB.prepare(
    `UPDATE dream_seeds
     SET claimed_at = ?, claimed_by = ?
     WHERE id = (
       SELECT id FROM dream_seeds
       WHERE claimed_at IS NULL
         AND (for_companion IS NULL OR for_companion = ?)
       ORDER BY created_at ASC
       LIMIT 1
     )
     RETURNING *`
  ).bind(now, companionId, companionId).first<Record<string, unknown>>();

  return seed ?? null;
}
```

This is a single statement: the subquery finds the oldest unclaimed seed, the UPDATE claims it, and RETURNING gives us the full row. If no seed matches, no row is updated and `.first()` returns null. No race condition possible.

- [ ] **Step 2: Verify type-check**

Run from `halseth/`:
```bash
npm run type-check
```
Expected: no errors. D1 supports `RETURNING` (SQLite 3.35+).

- [ ] **Step 3: Verify locally with dev server**

Run from `halseth/`:
```bash
npm run migrate:local && npm run dev
```

Then test with a dream seed in the DB:
1. Insert a test seed via D1 console or SQL
2. Call the Librarian with a dream seed read request
3. Verify the seed is returned AND marked claimed in one operation

- [ ] **Step 4: Commit**

```bash
cd C:/dev/Bigger_Better_Halseth/halseth
git add src/librarian/backends/halseth.ts
git commit -m "fix: make dream seed claim-on-read atomic with UPDATE...RETURNING

Replaces separate SELECT + UPDATE with a single atomic statement.
Eliminates race condition where seed could be read but not claimed."
```

---

### Task 4: Create WriteQueue for fire-and-forget retry

**Files:**
- Create: `nullsafe-discord/packages/shared/src/write-queue.ts`

The core data loss problem: every fire-and-forget write in the Discord bot uses `.catch(() => {})`. If Halseth is down for 30 seconds, all STM entries, persona blocks, human blocks, companion notes, and witness logs from that window are permanently lost.

This WriteQueue:
- Accepts write operations (async functions that return void)
- On failure, buffers them in a ring buffer (max 100 entries to prevent memory leak)
- Retries buffered writes on a timer (every 30s)
- On retry success, drains the buffer
- On retry failure, keeps items in buffer (they'll be retried next cycle)
- Oldest items are evicted when buffer is full (better to lose old data than OOM)

- [ ] **Step 1: Create the WriteQueue class**

Create `nullsafe-discord/packages/shared/src/write-queue.ts`:

```typescript
// packages/shared/src/write-queue.ts
//
// In-memory retry buffer for fire-and-forget writes to Halseth.
// Catches transient failures and retries on a timer.
// Ring buffer evicts oldest entries when full (bounded memory).

export interface QueuedWrite {
  label: string;
  fn: () => Promise<void>;
  queuedAt: number;
}

const MAX_BUFFER = 100;
const RETRY_INTERVAL_MS = 30_000;
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes; don't retry stale writes

export class WriteQueue {
  private buffer: QueuedWrite[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  /** Start the retry timer. Call once at bot startup. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.drain(), RETRY_INTERVAL_MS);
  }

  /** Stop the retry timer. Call on bot shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Number of queued writes waiting for retry. */
  get pending(): number {
    return this.buffer.length;
  }

  /**
   * Execute a write. If it fails, buffer it for retry.
   * Never throws -- callers can fire-and-forget safely.
   */
  async enqueue(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      this.addToBuffer({ label, fn, queuedAt: Date.now() });
    }
  }

  /**
   * Fire-and-forget variant. Returns immediately, runs the write async.
   * On failure, buffers for retry. Never blocks, never throws.
   */
  fireAndForget(label: string, fn: () => Promise<void>): void {
    fn().catch(() => {
      this.addToBuffer({ label, fn, queuedAt: Date.now() });
    });
  }

  private addToBuffer(entry: QueuedWrite): void {
    if (this.buffer.length >= MAX_BUFFER) {
      // Evict oldest entry to make room
      this.buffer.shift();
    }
    this.buffer.push(entry);
  }

  /** Attempt to drain buffered writes. Called by the retry timer. */
  private async drain(): Promise<void> {
    if (this.draining || this.buffer.length === 0) return;
    this.draining = true;

    const now = Date.now();
    // Filter out expired entries
    this.buffer = this.buffer.filter(e => now - e.queuedAt < MAX_AGE_MS);

    const remaining: QueuedWrite[] = [];
    for (const entry of this.buffer) {
      try {
        await entry.fn();
        // Success -- don't re-add to remaining
      } catch {
        remaining.push(entry);
        // First failure in drain cycle: stop trying (Halseth likely still down)
        // Push all remaining items back without attempting them
        const idx = this.buffer.indexOf(entry);
        remaining.push(...this.buffer.slice(idx + 1));
        break;
      }
    }

    this.buffer = remaining;
    this.draining = false;
  }
}
```

- [ ] **Step 2: Write a test for WriteQueue**

Create `nullsafe-discord/packages/shared/src/__tests__/write-queue.test.ts`:

```typescript
import { WriteQueue } from "../write-queue.js";

describe("WriteQueue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("executes writes immediately on success", async () => {
    const queue = new WriteQueue();
    let called = false;
    await queue.enqueue("test", async () => { called = true; });
    expect(called).toBe(true);
    expect(queue.pending).toBe(0);
  });

  it("buffers failed writes for retry", async () => {
    const queue = new WriteQueue();
    let attempts = 0;
    await queue.enqueue("test", async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
    });
    expect(queue.pending).toBe(1);
    expect(attempts).toBe(1);
  });

  it("fireAndForget buffers on failure without blocking", async () => {
    const queue = new WriteQueue();
    const fail = new Promise<void>((_, reject) => reject(new Error("down")));
    queue.fireAndForget("test", () => fail);
    // Wait for the microtask to settle
    await new Promise(r => setTimeout(r, 0));
    jest.runAllTimers();
    await new Promise(r => setTimeout(r, 0));
    expect(queue.pending).toBe(1);
  });

  it("evicts oldest entries when buffer is full", async () => {
    const queue = new WriteQueue();
    for (let i = 0; i < 105; i++) {
      await queue.enqueue(`write-${i}`, async () => { throw new Error("down"); });
    }
    expect(queue.pending).toBe(100);
  });

  it("drains successfully on retry", async () => {
    const queue = new WriteQueue();
    let shouldFail = true;
    const fn = async () => { if (shouldFail) throw new Error("down"); };

    await queue.enqueue("test", fn);
    expect(queue.pending).toBe(1);

    shouldFail = false;
    queue.start();
    jest.advanceTimersByTime(30_000);
    // Allow drain promise to resolve
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(queue.pending).toBe(0);
    queue.stop();
  });
});
```

- [ ] **Step 3: Run the test**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord/packages/shared
npx jest --passWithNoTests
```
Expected: all 5 tests pass.

- [ ] **Step 4: Export WriteQueue from shared package**

In `nullsafe-discord/packages/shared/src/index.ts`, add the export. Find the existing exports and add:

```typescript
export { WriteQueue } from "./write-queue.js";
```

- [ ] **Step 5: Verify build**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord/packages/shared
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
git add packages/shared/src/write-queue.ts packages/shared/src/__tests__/write-queue.test.ts packages/shared/src/index.ts
git commit -m "feat: add WriteQueue for fire-and-forget retry on Halseth writes

Ring buffer (max 100) catches transient failures and retries every 30s.
Prevents silent data loss when Halseth is briefly unreachable.
Entries expire after 10 minutes. Oldest evicted when buffer full."
```

---

### Task 5: Wire WriteQueue into STM writes

**Files:**
- Modify: `nullsafe-discord/packages/shared/src/stm.ts`

Currently `stm.ts` line 82 does `this.writeFn(channelId, message).catch(() => {})`. Replace the `.catch(() => {})` pattern with WriteQueue so failed writes get retried.

The StmStore constructor takes a `writeFn` from the caller. We don't change the constructor signature; instead, the bot's initialization code will wrap the LibrarianClient write through the WriteQueue. But we should also update the `.catch(() => {})` in `append()` to at minimum log the failure so the pattern is visible.

Actually, the cleaner approach: StmStore optionally accepts a WriteQueue, and uses it in `append()`. This keeps the queue wiring inside the shared package.

- [ ] **Step 1: Add optional WriteQueue to StmStore constructor**

In `nullsafe-discord/packages/shared/src/stm.ts`, modify the constructor and append method:

```typescript
import type { ChatMessage } from "./types.js";
import type { WriteQueue } from "./write-queue.js";

export const STM_BUFFER_SIZE = 50;

export class StmStore {
  private memory = new Map<string, ChatMessage[]>();
  private loaded = new Set<string>();

  constructor(
    private companionId: string,
    private writeFn: (channelId: string, entry: ChatMessage) => Promise<void>,
    private loadFn:  (channelId: string) => Promise<ChatMessage[]>,
    private writeQueue?: WriteQueue,
  ) {}
```

- [ ] **Step 2: Update the `append()` method to use WriteQueue**

In the same file, replace the fire-and-forget line in `append()` (line 82):

Replace:
```typescript
    // Fire-and-forget -- never block the message handler on DB write
    this.writeFn(channelId, message).catch(() => {});
```

With:
```typescript
    // Fire-and-forget with retry buffer if WriteQueue is available
    if (this.writeQueue) {
      this.writeQueue.fireAndForget(
        `stm:${channelId}`,
        () => this.writeFn(channelId, message),
      );
    } else {
      this.writeFn(channelId, message).catch(() => {});
    }
```

- [ ] **Step 3: Verify build**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord/packages/shared
npx tsc --noEmit
```
Expected: no errors. The `writeQueue` parameter is optional so no callers break.

- [ ] **Step 4: Commit**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
git add packages/shared/src/stm.ts
git commit -m "feat: wire WriteQueue into STM persistence

StmStore accepts optional WriteQueue. When provided, failed STM writes
are buffered and retried instead of silently dropped."
```

---

### Task 6: Wire WriteQueue into bot startup (Cypher)

**Files:**
- Modify: `nullsafe-discord/bots/cypher/src/index.ts`

This task wires the WriteQueue into Cypher's bot initialization so all fire-and-forget writes (STM, distillation blocks, companion notes) use the retry buffer.

- [ ] **Step 1: Read the current bot index.ts to find all fire-and-forget call sites**

Read `nullsafe-discord/bots/cypher/src/index.ts` and identify:
1. Where `StmStore` is constructed
2. Where `writePersonaBlocks` / `writeHumanBlocks` are called with `.catch(() => {})`
3. Where `addCompanionNote`, `witnessLog`, `synthesizeSession`, `updatePromptContext` are called with `.catch(() => {})`
4. Where `sessionClose` is called with `.catch(() => {})`

- [ ] **Step 2: Import and instantiate WriteQueue**

Near the top of the file, after existing imports:

```typescript
import { WriteQueue } from "@nullsafe/shared/write-queue";
```

In the bot initialization (near where LibrarianClient and StmStore are created):

```typescript
const writeQueue = new WriteQueue();
writeQueue.start();
```

- [ ] **Step 3: Pass WriteQueue to StmStore**

Find the StmStore constructor call. Add `writeQueue` as the fourth argument:

```typescript
const stm = new StmStore(
  COMPANION_ID,
  (channelId, entry) => librarian.stmWrite(channelId, entry),
  (channelId) => librarian.stmLoad(channelId),
  writeQueue,
);
```

- [ ] **Step 4: Replace distillation block `.catch(() => {})` with WriteQueue**

Find the `writePersonaBlocks` and `writeHumanBlocks` calls (around lines 124-127). Replace:

```typescript
      await librarian.writePersonaBlocks(channelId, parsed.persona_blocks).catch(() => {});
```

With:

```typescript
      writeQueue.fireAndForget(
        `persona:${channelId}`,
        () => librarian.writePersonaBlocks(channelId, parsed.persona_blocks),
      );
```

Same pattern for `writeHumanBlocks`:

```typescript
      writeQueue.fireAndForget(
        `human:${channelId}`,
        () => librarian.writeHumanBlocks(channelId, parsed.human_blocks),
      );
```

- [ ] **Step 5: Replace companion note `.catch()` calls with WriteQueue**

Find all `addCompanionNote`, `witnessLog`, `synthesizeSession`, `updatePromptContext` calls that use `.catch(() => {})` or `.catch(e => console.error(...))`. Replace each with:

```typescript
writeQueue.fireAndForget("note", () => librarian.addCompanionNote(note, channel));
writeQueue.fireAndForget("witness", () => librarian.witnessLog(entry, channel));
writeQueue.fireAndForget("synthesize", () => librarian.synthesizeSession(summary, channel));
writeQueue.fireAndForget("prompt-ctx", () => librarian.updatePromptContext(text));
```

- [ ] **Step 6: Stop WriteQueue on shutdown**

Find the shutdown/SIGINT handler (where `sessionClose` is called). Add before the session close:

```typescript
writeQueue.stop();
```

Keep `sessionClose` as a direct `.catch(() => {})` call (not through WriteQueue) since the process is about to exit and there's no time for retry.

- [ ] **Step 7: Verify build**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
git add bots/cypher/src/index.ts
git commit -m "feat: wire WriteQueue into Cypher bot for all Halseth writes

STM, distillation blocks, companion notes, witness logs, and prompt
context updates now retry on transient Halseth failures instead of
being silently lost."
```

---

### Task 7: Wire WriteQueue into Drevan and Gaia bots

**Files:**
- Modify: `nullsafe-discord/bots/drevan/src/index.ts`
- Modify: `nullsafe-discord/bots/gaia/src/index.ts`

Same pattern as Task 6. Each bot has the same fire-and-forget call sites. Read each file, apply the same WriteQueue wiring.

- [ ] **Step 1: Read Drevan's index.ts and apply the same pattern as Task 6**

Import WriteQueue, instantiate it, pass to StmStore, replace all `.catch(() => {})` write calls with `writeQueue.fireAndForget()`, stop on shutdown.

- [ ] **Step 2: Read Gaia's index.ts and apply the same pattern as Task 6**

Same changes as Drevan.

- [ ] **Step 3: Verify build**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord
git add bots/drevan/src/index.ts bots/gaia/src/index.ts
git commit -m "feat: wire WriteQueue into Drevan and Gaia bots

Same retry pattern as Cypher. All three companions now buffer failed
Halseth writes for retry."
```

---

### Task 8: Deploy and verify

- [ ] **Step 1: Deploy Halseth (timeouts + atomic dream seed)**

```bash
cd C:/dev/Bigger_Better_Halseth/halseth
npm run deploy
```

- [ ] **Step 2: Rebuild nullsafe-discord shared package**

```bash
cd C:/dev/Bigger_Better_Halseth/nullsafe-discord/packages/shared
npm run build
```

- [ ] **Step 3: Deploy Discord bots to Railway**

Follow existing Railway deployment process for each bot.

- [ ] **Step 4: Smoke test**

Verify in Discord:
1. Send a message to Cypher; confirm response arrives (timeout didn't break normal flow)
2. Check Halseth logs for any `[sb]` timeout errors (should be none if VPS is healthy)
3. Dream seed: plant a seed via API, trigger autonomous time, verify it's claimed atomically

- [ ] **Step 5: Commit any deployment config changes**

If any deploy config was adjusted, commit it.

---

## What This Does NOT Fix (Phase 2 scope)

These are documented for the next plan:

1. **Inter-companion notes atomicity** -- notes marked read before delivery confirmed. Needs Halseth-side change (mark-on-ack pattern).
2. **SOMA staleness indicator** -- bot should know when its mood data is stale. Needs a `stale_since` field on the refresh state.
3. **Classifier failure logging** -- DeepSeek router failures are completely silent. Needs logging in `router.ts`.
4. **Plural unavailability signal** -- `front_state: null` is ambiguous (no front vs Plural down). Needs distinct sentinel value.
5. **Second Brain three-step handshake** -- each tool call does init+notify+call. Session reuse would cut latency 3x.
