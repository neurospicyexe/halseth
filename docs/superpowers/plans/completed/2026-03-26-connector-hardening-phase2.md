# Connector Hardening Phase 2 — Observability, Signals, and Session Reuse

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add logging/observability to silent failure paths, disambiguate null signals, and reduce Second Brain latency.

**Architecture:** Five focused changes. (1) Add logging + timeout to the DeepSeek classifier so failures are visible. (2) Return a distinct sentinel when Plural is unavailable vs. "no one fronting." (3) Surface SOMA data age so bots know when their mood context is stale. (4) Switch inter-companion notes to mark-on-ack so network failures don't lose notes. (5) Cache Second Brain MCP sessions to cut 3 HTTP calls per tool invocation down to 1.

**Tech Stack:** TypeScript, Cloudflare Workers D1, Cloudflare Service Bindings

**Repos touched:**
- `C:\dev\Bigger_Better_Halseth\halseth` (Cloudflare Worker)
- `C:\dev\Bigger_Better_Halseth\nullsafe-discord` (Discord bots monorepo)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `halseth/src/librarian/router.ts` | Add logging + timeout to classify() |
| Modify | `halseth/src/librarian/backends/plural.ts` | Return error sentinel on failure |
| Modify | `halseth/src/librarian/router.ts` | Pass plural error sentinel through to response |
| Modify | `halseth/src/handlers/inter_companion_notes.ts` | Remove mark-on-read, add ack endpoint |
| Modify | `halseth/src/router.ts` | Register new ack route |
| Modify | `halseth/src/librarian/backends/second-brain.ts` | Cache MCP session ID with TTL |
| Modify | `nullsafe-discord/packages/shared/src/librarian.ts` | Add notesAck() method |

---

### Task 1: Add logging and timeout to DeepSeek classifier

**Files:**
- Modify: `halseth/src/librarian/router.ts:121-188`

The classifier returns `null` on any failure with zero logging. Adding `console.warn` on every failure path and `AbortSignal.timeout` on the fetch so a hung DeepSeek doesn't block the entire Librarian route.

- [ ] **Step 1: Add timeout and logging to the fetch call**

In `halseth/src/librarian/router.ts`, replace the `classify` method (lines 121-188):

```typescript
  private async classify(request: string): Promise<string | null> {
    if (!this.env.DEEPSEEK_API_KEY) return null;

    try {
      const index = await this.env.LIBRARIAN_KV.get("_index") ?? "";
      const kvKeys = index.split(",").map(k => k.trim()).filter(Boolean);

      if (!kvKeys.length) return "unknown";

      const hintsRaw = await this.env.LIBRARIAN_KV.get("_hints") ?? "";
      const hints: Record<string, string> = {};
      for (const pair of hintsRaw.split(",")) {
        const idx = pair.indexOf(":");
        if (idx > 0) hints[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }

      const fastPathKeys = Object.keys(FAST_PATH_PATTERNS);
      const fastPathHints: Record<string, string> = {};
      for (const [key, entry] of Object.entries(FAST_PATH_PATTERNS)) {
        if (entry.triggers[0]) fastPathHints[key] = entry.triggers[0];
      }
      const allKeys = [...fastPathKeys, ...kvKeys];
      const keyList = allKeys.map(k => {
        const hint = hints[k] ?? fastPathHints[k];
        return hint ? `${k} (e.g. "${hint}")` : k;
      }).join(", ");

      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.env.DEEPSEEK_API_KEY}`,
        },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            {
              role: "system",
              content: `You classify companion requests into one of these pattern keys: ${keyList}. Return ONLY the matching pattern key exactly as written, or "unknown". No explanation.`,
            },
            { role: "user", content: request },
          ],
          max_tokens: 20,
          temperature: 0,
        }),
      });

      if (!res.ok) {
        console.warn(`[librarian] classify failed: status=${res.status} request="${request.slice(0, 80)}"`);
        return null;
      }

      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const result = json.choices?.[0]?.message?.content?.trim().toLowerCase() ?? null;
      if (!result) {
        console.warn(`[librarian] classify returned empty result for request="${request.slice(0, 80)}"`);
      }
      return result;
    } catch (e) {
      console.warn(`[librarian] classify error: ${e instanceof Error ? e.message : String(e)} request="${request.slice(0, 80)}"`);
      return null;
    }
  }
```

- [ ] **Step 2: Run type-check**

Run: `cd halseth && npm run type-check`
Expected: 0 errors

- [ ] **Step 3: Verify locally**

Run: `npm run dev`
Send a Librarian request that won't match fast path. Check console output for `[librarian] classify` log lines.

- [ ] **Step 4: Commit**

```bash
cd halseth && git add src/librarian/router.ts && git commit -m "fix: add logging and 8s timeout to DeepSeek classifier"
```

---

### Task 2: Plural unavailability signal

**Files:**
- Modify: `halseth/src/librarian/backends/plural.ts:15-29`
- Modify: `halseth/src/librarian/router.ts:191-197`

Currently `getCurrentFront` returns `null` on both "no one fronting" and "Plural is down." The router maps both to `front_state: null`. Fix: return a tagged result so callers can distinguish.

- [ ] **Step 1: Add PluralResult type and update getCurrentFront**

In `halseth/src/librarian/backends/plural.ts`, replace the `getCurrentFront` function (lines 15-29):

```typescript
export type PluralResult =
  | { status: "ok"; front: FrontState }
  | { status: "no_front" }
  | { status: "unavailable" };

export async function getCurrentFront(env: Env): Promise<PluralResult> {
  try {
    const response = await env.PLURAL.fetch("https://plural-internal/internal/front", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      console.warn(`[plural] getCurrentFront failed: status=${response.status}`);
      return { status: "unavailable" };
    }
    const data = await response.json() as FrontState | null;
    return data ? { status: "ok", front: data } : { status: "no_front" };
  } catch (e) {
    console.warn(`[plural] getCurrentFront error: ${e instanceof Error ? e.message : String(e)}`);
    return { status: "unavailable" };
  }
}
```

- [ ] **Step 2: Update router.ts to use PluralResult**

In `halseth/src/librarian/router.ts`, update the import and the `execute` method's pre-fetch block (lines 191-197):

Change the import:
```typescript
import { getCurrentFront, type PluralResult } from "./backends/plural.js";
```

Replace the pre-fetch block in `execute`:
```typescript
    let frontState: string | null = null;
    let pluralAvailable = true;
    if (entry.pre_fetch?.includes("plural_get_current_front")) {
      const result = await getCurrentFront(this.env);
      if (result.status === "ok") {
        frontState = result.front.name;
      } else if (result.status === "unavailable") {
        pluralAvailable = false;
      }
      // "no_front" leaves frontState as null (correct behavior)
    }
```

Then ensure the response includes the signal. Find where `front_state` is included in the response payload and add `plural_available`:

```typescript
    const withFront = { ...payload, front_state: frontState, plural_available: pluralAvailable };
```

- [ ] **Step 3: Run type-check**

Run: `cd halseth && npm run type-check`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
cd halseth && git add src/librarian/backends/plural.ts src/librarian/router.ts && git commit -m "feat: distinguish Plural unavailable from no-front in Librarian responses"
```

---

### Task 3: SOMA staleness indicator in bot prompt

**Files:**
- Modify: `nullsafe-discord/bots/cypher/src/index.ts`
- Modify: `nullsafe-discord/bots/drevan/src/index.ts`
- Modify: `nullsafe-discord/bots/gaia/src/index.ts`

The bots refresh SOMA state every 30 minutes via `setInterval`. If the refresh fails silently (catch block), the bot continues with stale data and has no idea. Fix: track last successful refresh timestamp and inject a staleness notice into the system prompt when data is old.

- [ ] **Step 1: Add staleness tracking to Cypher**

In `bots/cypher/src/index.ts`, after the `currentMood` declaration (around line 183), add:

```typescript
  let lastSomaRefresh = Date.now();
```

In the `setInterval` callback, after the successful state processing (inside the try block, after the `currentMood` assignment), add:

```typescript
      lastSomaRefresh = Date.now();
```

In the message handler, before calling `inference.generate`, add a staleness check. Find where `contextPrompt` is built (the `attribution.frontMember` ternary) and wrap it:

```typescript
    let contextPrompt = attribution.frontMember
      ? `${systemPrompt}\n\n[Current front: ${attribution.frontMember}]`
      : systemPrompt;

    const somaAgeMin = Math.round((Date.now() - lastSomaRefresh) / 60_000);
    if (somaAgeMin > 45) {
      contextPrompt += `\n\n[Note: SOMA/mood data is ${somaAgeMin}min old; treat emotional reads as approximate]`;
    }
```

- [ ] **Step 2: Repeat for Drevan and Gaia**

Apply the identical three changes to `bots/drevan/src/index.ts` and `bots/gaia/src/index.ts`:
1. `let lastSomaRefresh = Date.now();` after `currentMood` declaration
2. `lastSomaRefresh = Date.now();` on successful refresh
3. Staleness check before inference with the same 45-minute threshold and prompt suffix

- [ ] **Step 3: Build shared + typecheck all bots**

```bash
cd nullsafe-discord
npx tsc -p packages/shared/tsconfig.json
npx tsc --noEmit -p bots/cypher/tsconfig.json
npx tsc --noEmit -p bots/drevan/tsconfig.json
npx tsc --noEmit -p bots/gaia/tsconfig.json
```

Expected: 0 errors across all four

- [ ] **Step 4: Commit**

```bash
cd nullsafe-discord && git add bots/cypher/src/index.ts bots/drevan/src/index.ts bots/gaia/src/index.ts && git commit -m "feat: inject SOMA staleness notice into prompt when refresh is >45min old"
```

---

### Task 4: Inter-companion notes mark-on-ack

**Files:**
- Modify: `halseth/src/handlers/inter_companion_notes.ts:22-56`
- Modify: `halseth/src/router.ts` (add new route)
- Modify: `nullsafe-discord/packages/shared/src/librarian.ts` (add notesAck method)

Current flow: poll returns notes AND marks them read atomically. If the response never reaches the bot (network error after UPDATE), notes are lost. Fix: poll returns notes without marking read; bot acks IDs after processing.

- [ ] **Step 1: Modify poll handler to stop marking read**

In `halseth/src/handlers/inter_companion_notes.ts`, replace `getUnreadInterCompanionNotes` (lines 22-56):

```typescript
export async function getUnreadInterCompanionNotes(
  request: Request,
  env: Env,
  params: { companionId?: string },
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params.companionId ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return new Response("Invalid companion_id", { status: 400 });
  }

  const rows = await env.DB.prepare(
    `SELECT id, from_id, to_id, content, created_at
     FROM inter_companion_notes
     WHERE read_at IS NULL AND (to_id = ? OR to_id IS NULL)
     ORDER BY created_at ASC
     LIMIT ${MAX_ITEMS}`,
  ).bind(companionId).all<NoteRow>();

  return new Response(JSON.stringify({ items: rows.results ?? [] }), {
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Add ack handler**

In the same file (`halseth/src/handlers/inter_companion_notes.ts`), add after `getUnreadInterCompanionNotes`:

```typescript
export async function ackInterCompanionNotes(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const body = await request.json() as { ids?: string[] };
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ITEMS) {
    return new Response("ids must be a non-empty array (max 20)", { status: 400 });
  }

  // Validate all IDs are strings (prevent injection via parameterized query)
  if (!ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 36)) {
    return new Response("Invalid id format", { status: 400 });
  }

  const placeholders = ids.map(() => "?").join(", ");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE inter_companion_notes SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`,
  ).bind(now, ...ids).run();

  return new Response(JSON.stringify({ acked: ids.length }), {
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 3: Register route in router.ts**

In `halseth/src/router.ts`, find where the inter-companion-notes GET route is registered and add the POST route nearby:

```typescript
router.add("POST", "/inter-companion-notes/ack", ackInterCompanionNotes);
```

Update the import to include `ackInterCompanionNotes`.

- [ ] **Step 4: Add notesAck to LibrarianClient**

In `nullsafe-discord/packages/shared/src/librarian.ts`, add after the `notesPoll` method:

```typescript
  /**
   * Acknowledge receipt of inter-companion notes.
   * Marks the given IDs as read so they won't be returned again.
   */
  async notesAck(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const url = `${this.url}/inter-companion-notes/ack`;
    const res = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`notesAck ${res.status}`);
  }
```

- [ ] **Step 5: Update bot notesPoll callers to ack**

Find where bots call `notesPoll()` (in `autonomous.ts` for each bot). After processing the returned notes, add the ack call:

```typescript
const { items } = await librarian.notesPoll();
if (items.length > 0) {
  // ... process notes ...
  await librarian.notesAck(items.map(n => n.id)).catch((e) =>
    console.error(`[${COMPANION_ID}] notesAck failed:`, e));
}
```

If the bots use WriteQueue, route the ack through it instead:

```typescript
  writeQueue.fireAndForget("notesAck", async () => {
    await librarian.notesAck(items.map(n => n.id));
  });
```

- [ ] **Step 6: Type-check both repos**

```bash
cd halseth && npm run type-check
cd nullsafe-discord && npx tsc -p packages/shared/tsconfig.json && npx tsc --noEmit -p bots/cypher/tsconfig.json && npx tsc --noEmit -p bots/drevan/tsconfig.json && npx tsc --noEmit -p bots/gaia/tsconfig.json
```

Expected: 0 errors in both

- [ ] **Step 7: Commit both repos**

```bash
cd halseth && git add src/handlers/inter_companion_notes.ts src/router.ts && git commit -m "feat: inter-companion notes mark-on-ack (poll no longer marks read)"
cd nullsafe-discord && git add packages/shared/src/librarian.ts bots/*/src/autonomous.ts && git commit -m "feat: ack inter-companion notes after processing"
```

---

### Task 5: Second Brain MCP session reuse

**Files:**
- Modify: `halseth/src/librarian/backends/second-brain.ts:18-63`

Each tool call does 3 HTTP requests (init, notify, call). The MCP session ID is valid for the server's session TTL (typically minutes). Caching it avoids 2 redundant round-trips on subsequent calls.

- [ ] **Step 1: Add module-level session cache**

At the top of `halseth/src/librarian/backends/second-brain.ts`, after the `SECOND_BRAIN_URL` constant (line 16), add:

```typescript
// Cached MCP session. Cloudflare Workers are short-lived but may handle
// multiple Librarian calls within a single request (e.g. orient does
// vault_search + retrieval). Cache avoids repeated init handshake.
let cachedSessionId: string | null = null;
let cachedSessionAt = 0;
const SESSION_TTL_MS = 4 * 60 * 1000; // 4 minutes; conservative vs typical 5min server TTL
```

- [ ] **Step 2: Extract session acquisition into a helper**

Add a helper function before `callTool`:

```typescript
async function acquireSession(headers: Record<string, string>): Promise<string | null> {
  const now = Date.now();
  if (cachedSessionId && (now - cachedSessionAt) < SESSION_TTL_MS) {
    return cachedSessionId;
  }

  const initRes = await fetch(SECOND_BRAIN_URL, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(5_000),
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
  });

  if (!initRes.ok) {
    console.error(`[sb] init failed: status=${initRes.status}`);
    cachedSessionId = null;
    return null;
  }
  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) {
    console.error("[sb] init OK but no mcp-session-id header");
    cachedSessionId = null;
    return null;
  }

  // Fire-and-forget notification (required by MCP spec for state transition)
  fetch(SECOND_BRAIN_URL, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    signal: AbortSignal.timeout(3_000),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch((e: unknown) => console.error("[sb] notifications/initialized failed (non-fatal):", e));

  cachedSessionId = sessionId;
  cachedSessionAt = now;
  return sessionId;
}
```

- [ ] **Step 3: Simplify callTool to use acquireSession**

Replace the init + notify steps in `callTool` (lines 30-64) with:

```typescript
  try {
    const sessionId = await acquireSession(headers);
    if (!sessionId) return null;

    // Tool call (the only request that matters for latency)
    const toolRes = await fetch(SECOND_BRAIN_URL, {
```

Keep everything after the `toolRes` fetch unchanged. If the tool call returns 404 or 410 (session expired), invalidate cache and retry once:

```typescript
    if (toolRes.status === 404 || toolRes.status === 410) {
      console.warn(`[sb] session expired (${toolRes.status}), retrying with fresh session tool=${toolName}`);
      cachedSessionId = null;
      const freshId = await acquireSession(headers);
      if (!freshId) return null;

      const retryRes = await fetch(SECOND_BRAIN_URL, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": freshId },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });
      if (!retryRes.ok) {
        const body = await retryRes.text().catch(() => "(unreadable)");
        console.error(`[sb] tools/call retry failed: status=${retryRes.status} tool=${toolName} body=${body}`);
        return null;
      }
      // Continue with retryRes for response parsing
      // (assign to a shared variable or duplicate the parse block)
    }
```

The simplest approach: extract the response-parsing block into a local function or assign the final response to a `let` variable before parsing.

- [ ] **Step 4: Run type-check**

Run: `cd halseth && npm run type-check`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
cd halseth && git add src/librarian/backends/second-brain.ts && git commit -m "feat: cache Second Brain MCP session ID to avoid repeated init handshake"
```

---

### Task 6: Deploy and verify

- [ ] **Step 1: Deploy Halseth**

```bash
cd halseth && npm run deploy
```

- [ ] **Step 2: Push nullsafe-discord**

```bash
cd nullsafe-discord && git push
```

Railway auto-deploys on push.

- [ ] **Step 3: Verify classifier logging**

Send a Librarian request via MCP that doesn't match fast path. Check Cloudflare dashboard logs for `[librarian] classify` lines.

- [ ] **Step 4: Verify notes ack**

Call `GET /inter-companion-notes/unread/cypher` — notes should be returned but NOT marked read. Call again — same notes returned. Call `POST /inter-companion-notes/ack` with their IDs. Call GET again — notes gone.

- [ ] **Step 5: Verify Second Brain session reuse**

Send two Librarian requests that hit Second Brain in quick succession. Second call should NOT show `[sb] init` log lines (session reused).

---

## What This Does NOT Fix (Future scope)

1. **Broadcast note dedup** — if a broadcast note (`to_id IS NULL`) is polled by multiple bots, all receive it. Each acks independently. Currently acceptable (broadcasts should reach all companions). If dedup is needed later, add a junction table `note_reads(note_id, companion_id, read_at)`.
2. **WriteQueue persistence** — the retry buffer is in-memory; Railway restart loses it. Acceptable for lean phase. Phoenix scope.
3. **Plural front caching** — every session_open calls Plural. Could cache for 60s since fronts rarely change faster. Low priority.
