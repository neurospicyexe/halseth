// src/librarian/router.ts
//
// Three-tier pattern matching:
//   1. FAST_PATH_PATTERNS (in-memory, zero cost) -- trigger string match
//   2. Workers AI classifier -- returns pattern_key string (KV keys only)
//   3. KV get(pattern_key) -- fetch tools + response_key
//
// Workers AI fires only when fast path misses. KV is consulted after classifier returns a key.
// Adding a new pattern: add to KV (no redeploy). Update classifier prompt if needed.

import { Env } from "../types.js";
import { FAST_PATH_PATTERNS, PatternEntry, CompanionId } from "./patterns.js";
import {
  sessionLoad, sessionOrient, sessionGround,
  taskList, handoverRead, addCompanionNote, companionNotesRead,
  claimDreamSeed,
  feelingsRead, journalRead, woundRead, deltaRead,
  dreamsRead, dreamSeedRead, eqRead, routineRead, listRead, eventList,
  houseRead, personalityRead, biometricRead, auditRead, sessionRead, fossilCheck,
  feelingLog, journalAdd, dreamLog, woundAdd, deltaLog, eqSnapshot,
  taskAdd, taskUpdateStatus, sessionClose, routineLog, listAdd, listItemComplete,
  eventAdd, biometricLog, auditLog, witnessLog, setAutonomousTurn, bridgePull,
  getDrevanState, addLiveThread, closeLiveThread, vetoProposedThread, setAnticipation,
  updateCompanionState, sessionLightGround, type CompanionStateUpdate,
} from "./backends/halseth.js";
import { getCurrentFront, getMember, updateMemberDescription, searchMembers, getFrontHistory, logFrontChange, addMemberNote } from "./backends/plural.js";
import { wmOrient, wmGround, wmUpsertThread, wmAddNote, wmWriteHandoff } from "./backends/webmind.js";
import type { WmAgentId, WmThreadUpsertInput, WmNoteInput, WmHandoffInput } from "../webmind/types.js";
import { extractMemberName, extractDescriptionUpdate } from "./extract.js";
import {
  semanticSearch, filteredRecall, recentPatterns,
  sbRead, sbList, sbSaveDocument, sbLogObservation, sbSynthesizeSession, sbSaveStudy,
} from "./backends/second-brain.js";
import { buildResponse, buildOrientPrompt } from "./response/builder.js";
import { ResponseKey, truncateRaw } from "./response/budget.js";

// Strip embedding float arrays from Second Brain chunk responses before returning to companions.
// sb_search returns { chunks: [{ chunk_text, embedding: [...], ... }] } -- embeddings are useless
// to companions and inflate response size by ~100x. Parse, strip, re-serialize, fall back on error.
// Validate vault paths: allow alphanumeric, slash, hyphen, underscore, dot, space.
// Block path traversal (.. segments) and absolute paths.
function isValidVaultPath(path: string): boolean {
  if (!path || typeof path !== "string") return false;
  if (path.includes("..")) return false;
  if (path.startsWith("/")) return false;
  return /^[a-zA-Z0-9/_\-. ]+$/.test(path);
}

function stripEmbeddings(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { chunks?: Array<Record<string, unknown>> };
    if (parsed?.chunks && Array.isArray(parsed.chunks)) {
      for (const chunk of parsed.chunks) {
        delete chunk.embedding;
      }
      return JSON.stringify(parsed);
    }
  } catch {
    // not parseable JSON -- return as-is
  }
  return raw;
}

export interface LibrarianRequest {
  companion_id: CompanionId;
  request: string;
  context?: string;
  session_type?: "checkin" | "hangout" | "work" | "ritual";
}

export class LibrarianRouter {
  constructor(private env: Env) {}

  async route(req: LibrarianRequest): Promise<Record<string, unknown>> {
    // Tier 1: fast path -- in-memory trigger match
    const fastMatch = this.matchFastPath(req.request);
    if (fastMatch) {
      return this.execute(req, fastMatch);
    }

    // Tier 2: Workers AI classifier
    const patternKey = await this.classify(req.request);

    // Tier 3: fast-path check on classifier result (classifier now sees all keys including fast-path)
    if (patternKey && patternKey !== "unknown") {
      const fastEntry = FAST_PATH_PATTERNS[patternKey];
      if (fastEntry) {
        return this.execute(req, fastEntry);
      }
      // Tier 3b: KV lookup for non-fast-path keys
      const kvEntry = await this.env.LIBRARIAN_KV.get(patternKey, "json") as PatternEntry | null;
      if (kvEntry) {
        return this.execute(req, kvEntry);
      }
    }

    // No match
    return {
      response_key: "witness",
      witness: "I don't know how to handle that yet.",
      meta: { pattern_key: patternKey },
    };
  }

  // Safely parse req.context as JSON. Returns null if missing or invalid.
  private parseContext<T>(context: string | undefined): T | null {
    if (!context) return null;
    try { return JSON.parse(context) as T; } catch { return null; }
  }

  private matchFastPath(request: string): PatternEntry | null {
    const lower = request.toLowerCase().trim();
    for (const entry of Object.values(FAST_PATH_PATTERNS)) {
      if (entry.triggers.some(t => lower.includes(t))) {
        return entry;
      }
    }
    return null;
  }

  private async classify(request: string): Promise<string | null> {
    if (!this.env.DEEPSEEK_API_KEY) return null;

    try {
      // Pattern index is stored in a single KV entry ("_index") as a comma-separated
      // list of all known KV pattern keys. Update "_index" whenever a new KV pattern
      // is added -- never call KV.list() here (it paginates and caps at 1000).
      // Fast-path keys (session_open, feelings_read, etc.) are deliberately excluded
      // from "_index" -- they are handled by matchFastPath() before classify() runs.
      // If the classifier returned a fast-path key, KV.get() would return null and
      // the request would silently fail. Keep these two registries separate.
      const index = await this.env.LIBRARIAN_KV.get("_index") ?? "";
      const kvKeys = index.split(",").map(k => k.trim()).filter(Boolean);

      // Nothing in KV yet -- return unknown without burning API tokens
      if (!kvKeys.length) return "unknown";

      // Fetch trigger hints for each key to help the classifier distinguish ambiguous patterns.
      // "_hints" is a KV entry mapping key -> first trigger phrase (comma-separated pairs).
      // Format: "key1:trigger1,key2:trigger2,..."
      const hintsRaw = await this.env.LIBRARIAN_KV.get("_hints") ?? "";
      const hints: Record<string, string> = {};
      for (const pair of hintsRaw.split(",")) {
        const idx = pair.indexOf(":");
        if (idx > 0) hints[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }

      // Include fast-path keys so the classifier has full visibility.
      // Previously excluded because returning a fast-path key would silently fail KV lookup --
      // that risk is gone now that route() checks FAST_PATH_PATTERNS before KV.
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

      if (!res.ok) return null;

      const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content?.trim().toLowerCase() ?? null;
    } catch {
      return null;
    }
  }

  private async execute(req: LibrarianRequest, entry: PatternEntry): Promise<Record<string, unknown>> {
    // Pre-fetch (runs before main tools, feeds front_state)
    let frontState: string | null = null;
    if (entry.pre_fetch?.includes("plural_get_current_front")) {
      const front = await getCurrentFront(this.env);
      frontState = front?.name ?? null;
    }

    // Execute tools
    // raw: true entries skip buildResponse() and return backend payload directly as { data: ... }.
    // Mutation entries return { ack: true, id, ...fields } directly from their switch case.
    // Only boot/shaped entries flow through buildResponse().
    for (const tool of entry.tools) {
      switch (tool) {
        case "halseth_session_load": {
          const payload = await sessionLoad(this.env, {
            companion_id: req.companion_id,
            front_state: frontState ?? "unknown",
            session_type: req.session_type ?? "work",
          });
          const withFront = { ...payload, front_state: frontState };
          return buildResponse(req.companion_id, entry.response_key as ResponseKey, withFront);
        }

        case "halseth_session_orient": {
          const agentId = req.companion_id as WmAgentId;
          const [payload, wmResult] = await Promise.all([
            sessionOrient(this.env, {
              companion_id: req.companion_id,
              front_state: frontState ?? "unknown",
              session_type: req.session_type ?? "work",
            }),
            wmOrient(this.env, agentId).catch(() => null),
          ]);
          const os = payload.state;
          const autonomousTurn = (payload as Record<string, unknown>).autonomous_turn as string | null ?? null;
          const isMyTurn = autonomousTurn === req.companion_id;
          return {
            ready_prompt: buildOrientPrompt(req.companion_id, payload),
            session_id: payload.session_id,
            response_key: "ready_prompt",
            autonomous_turn: autonomousTurn,
            my_autonomous_turn: isMyTurn,
            soma_float_1: os?.soma_float_1 ?? null,
            soma_float_2: os?.soma_float_2 ?? null,
            soma_float_3: os?.soma_float_3 ?? null,
            current_mood: os?.current_mood ?? null,
            compound_state: os?.compound_state ?? null,
            surface_emotion: os?.surface_emotion ?? null,
            undercurrent_emotion: os?.undercurrent_emotion ?? null,
            meta: { front_state: frontState },
            continuity: wmResult,
          };
        }

        case "halseth_session_ground": {
          const ctx = this.parseContext<{ session_id: string }>(req.context);
          if (!ctx?.session_id) return { response_key: "witness", witness: "session_ground requires { session_id } in context" };
          const payload = await sessionGround(this.env, {
            session_id: ctx.session_id,
            companion_id: req.companion_id,
          });
          return { data: payload, response_key: "ground" };
        }

        case "halseth_task_list": {
          const tasks = await taskList(this.env, req.companion_id);
          const summary = tasks.length === 0
            ? "No open tasks."
            : tasks.map((t: unknown) => {
                const task = t as { title: string; priority: string };
                return `[${task.priority}] ${task.title}`;
              }).join("\n");
          return buildResponse(req.companion_id, entry.response_key as ResponseKey, { session_id: "" }, summary);
        }

        case "halseth_handover_read": {
          const handover = await handoverRead(this.env);
          return { data: handover ?? "No handover packet found.", meta: { operation: tool } };
        }

        case "plural_get_current_front": {
          const front = await getCurrentFront(this.env);
          const text = front
            ? `${front.name} is fronting.`
            : "Front state unavailable.";
          return buildResponse(req.companion_id, entry.response_key as ResponseKey, { session_id: "" }, text);
        }

        // ── Second Brain (raw reads, ack mutations) ───────────────────────────

        case "sb_search": {
          const query = this.parseContext<{ query: string }>(req.context)?.query ?? req.request;
          const result = await semanticSearch(this.env, query);
          return { data: result ? truncateRaw(stripEmbeddings(result)) : "No results.", meta: { operation: tool } };
        }

        case "sb_recall": {
          const p = this.parseContext<{ companion?: string; content_type?: string; limit?: number }>(req.context);
          const result = await filteredRecall(this.env, { companion: p?.companion ?? req.companion_id, content_type: p?.content_type, limit: p?.limit });
          return { data: result ? truncateRaw(stripEmbeddings(result)) : "No results.", meta: { operation: tool } };
        }

        case "sb_recent_patterns": {
          const result = await recentPatterns(this.env);
          return { data: result ? truncateRaw(result) : "No patterns found.", meta: { operation: tool } };
        }

        case "sb_read": {
          const p = this.parseContext<{ path: string; query?: string }>(req.context);
          if (!p?.path) return { response_key: "witness", witness: "sb_read requires { path } in context" };
          if (!isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
          const result = await sbRead(this.env, p.path, p.query);
          return { data: result ? truncateRaw(result) : "Not found.", meta: { operation: tool } };
        }

        case "sb_list": {
          const p = this.parseContext<{ path?: string }>(req.context);
          const result = await sbList(this.env, p?.path);
          return { data: result ? truncateRaw(result) : "Empty.", meta: { operation: tool } };
        }

        case "sb_save_document": {
          const p = this.parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(req.context);
          if (!p?.content) return { response_key: "witness", witness: "sb_save_document requires { content } in context" };
          if (p.path && !isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
          const r = await sbSaveDocument(this.env, { ...p, content_type: "document" });
          return { ack: r.ack, response: r.response };
        }

        case "sb_save_note": {
          const p = this.parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(req.context);
          if (!p?.content) return { response_key: "witness", witness: "sb_save_note requires { content } in context" };
          if (p.path && !isValidVaultPath(p.path)) return { response_key: "witness", witness: "invalid vault path" };
          const r = await sbSaveDocument(this.env, { ...p, content_type: "note" });
          return { ack: r.ack, response: r.response };
        }

        case "sb_log_observation": {
          const p = this.parseContext<{ content: string; tags?: string[] }>(req.context);
          if (!p?.content) return { response_key: "witness", witness: "sb_log_observation requires { content } in context" };
          const r = await sbLogObservation(this.env, p.content, p.tags);
          return { ack: r.ack };
        }

        case "sb_synthesize_session": {
          const p = this.parseContext<{ session_id: string }>(req.context);
          if (!p?.session_id) return { response_key: "witness", witness: "sb_synthesize_session requires { session_id } in context" };
          const r = await sbSynthesizeSession(this.env, p.session_id);
          return { ack: r.ack };
        }

        case "sb_save_study": {
          const p = this.parseContext<{ content: string; subject?: string; tags?: string[] }>(req.context);
          if (!p?.content) return { response_key: "witness", witness: "sb_save_study requires { content } in context" };
          // subject is not a file path -- no traversal validation needed
          const r = await sbSaveStudy(this.env, p);
          return { ack: r.ack, response: r.response };
        }

        case "plural_get_member": {
          const trigger = entry.triggers.find(t => req.request.toLowerCase().includes(t));
          const name = trigger ? extractMemberName(req.request, trigger) : null;
          if (!name) {
            return { response_key: "witness", witness: "couldn't identify a member name -- try 'tell me about Ash'" };
          }
          const member = await getMember(this.env, name);
          if (!member) {
            return { response_key: "witness", witness: `couldn't find member '${name}'` };
          }
          // raw: true -- full member record, no shaping
          return { data: member, meta: { operation: "plural_get_member" } };
        }

        case "plural_update_member_description": {
          const parsed = extractDescriptionUpdate(req.request);
          if (!parsed) {
            return { response_key: "witness", witness: "couldn't parse that -- try 'update Ash\\'s description to [text]'" };
          }
          const updateResult = await updateMemberDescription(this.env, parsed.member, parsed.description);
          if (!updateResult.success) {
            return { response_key: "witness", witness: updateResult.error ?? "update failed" };
          }
          return { ack: true, id: updateResult.member_id, name: updateResult.name };
        }

        case "plural_search_members": {
          const members = await searchMembers(this.env, req.request);
          // raw: true -- full member array
          return { data: members, meta: { operation: "plural_search_members" } };
        }

        case "plural_get_front_history": {
          const history = await getFrontHistory(this.env);
          // raw: true -- full history array
          return { data: history, meta: { operation: "plural_get_front_history" } };
        }

        case "plural_log_front_change": {
          const p = this.parseContext<{ member_id: string; status: "fronting" | "co-con" | "unknown"; custom_status?: string }>(req.context);
          if (!p?.member_id || !p?.status) return { response_key: "witness", witness: "log_front_change requires { member_id, status } in context" };
          const r = await logFrontChange(this.env, p);
          if (!r.success) return { response_key: "witness", witness: r.error ?? "log_front_change failed" };
          return { ack: true, front_id: r.front_id ?? null, name: r.name, result: r.result };
        }

        case "plural_add_member_note": {
          const p = this.parseContext<{ member_id: string; note: string; title?: string; color?: string }>(req.context);
          if (!p?.member_id || !p?.note) return { response_key: "witness", witness: "add_member_note requires { member_id, note } in context" };
          const r = await addMemberNote(this.env, p);
          if (!r.success) return { response_key: "witness", witness: r.error ?? "add_member_note failed" };
          return { ack: true, id: r.id ?? null, member_id: r.member_id, name: r.name };
        }

        // ── Halseth data reads (raw: true) ───────────────────────────────────

        case "halseth_feelings_read":
          return { data: await feelingsRead(this.env, req.companion_id), meta: { operation: tool } };

        case "halseth_journal_read":
          return { data: await journalRead(this.env), meta: { operation: tool } };

        case "halseth_wound_read":
          return { data: await woundRead(this.env), meta: { operation: tool } };

        case "halseth_delta_read":
          return { data: await deltaRead(this.env, req.companion_id), meta: { operation: tool } };

        case "halseth_dreams_read":
          return { data: await dreamsRead(this.env, req.companion_id), meta: { operation: tool } };

        case "halseth_dream_seed_read":
          return { data: await dreamSeedRead(this.env, req.companion_id), meta: { operation: tool } };

        case "halseth_eq_read":
          return { data: await eqRead(this.env, req.companion_id), meta: { operation: tool } };

        case "halseth_routine_read":
          return { data: await routineRead(this.env), meta: { operation: tool } };

        case "halseth_list_read": {
          const listMatch = req.request.match(/list\s+(?:called\s+|named\s+)?["']?([a-z0-9 _-]+)["']?/i);
          const listName = listMatch?.[1]?.trim();
          if (listName && listName.length > 100) return { error: "list name too long", meta: { operation: tool } };
          return { data: await listRead(this.env, listName), meta: { operation: tool } };
        }

        case "halseth_event_list":
          return { data: await eventList(this.env), meta: { operation: tool } };

        case "halseth_house_read":
          return { data: await houseRead(this.env), meta: { operation: tool } };

        case "halseth_personality_read":
          return { data: await personalityRead(this.env), meta: { operation: tool } };

        case "halseth_biometric_read":
          return { data: await biometricRead(this.env), meta: { operation: tool } };

        case "halseth_audit_read":
          return { data: await auditRead(this.env), meta: { operation: tool } };

        case "halseth_session_read":
          return { data: await sessionRead(this.env, req.companion_id), meta: { operation: tool } };

        case "halseth_fossil_check": {
          const subjectMatch = req.request.match(/fossil\s+(?:check\s+)?(?:for\s+)?["']?([a-z0-9 _-]+)["']?/i);
          const subject = subjectMatch?.[1]?.trim() ?? req.context ?? "unknown";
          if (subject.length > 100) return { error: "fossil subject too long", meta: { operation: tool } };
          return { data: await fossilCheck(this.env, subject), meta: { operation: tool } };
        }

        case "halseth_companion_notes_read":
          return { data: await companionNotesRead(this.env, req.companion_id), meta: { operation: tool } };

        case "halseth_companion_note_add": {
          const toMatch = req.request.match(/(to|for)\s+(drevan|cypher|gaia)/i);
          const to_id = toMatch?.[2]?.toLowerCase() ?? null;
          const content = req.context ?? req.request;
          const note = await addCompanionNote(this.env, req.companion_id, to_id, content);
          return { ack: true, id: note.id };
        }

        // ── Halseth mutations (ack + id) ──────────────────────────────────────
        // Payload arrives in req.context as JSON. req.request is routing only.

        case "halseth_feeling_log": {
          const p = this.parseContext<{ emotion: string; sub_emotion?: string; intensity?: number; source?: string; session_id?: string }>(req.context);
          if (!p || !p.emotion) return { response_key: "witness", witness: "feeling_log requires { emotion } in context" };
          const r = await feelingLog(this.env, { companion_id: req.companion_id, ...p });
          return { ack: true, id: r.id, logged_at: r.created_at };
        }

        case "halseth_journal_add": {
          const p = this.parseContext<{ entry_text: string; emotion_tag?: string; sub_emotion?: string; mood_score?: number; tags?: string }>(req.context);
          if (!p || !p.entry_text) return { response_key: "witness", witness: "journal_add requires { entry_text } in context" };
          const r = await journalAdd(this.env, p);
          return { ack: true, id: r.id, created_at: r.created_at };
        }

        case "halseth_dream_log": {
          const p = this.parseContext<{ dream_type: string; content: string; source_ids?: string; session_id?: string }>(req.context);
          if (!p || !p.dream_type || !p.content) return { response_key: "witness", witness: "dream_log requires { dream_type, content } in context" };
          const r = await dreamLog(this.env, { companion_id: req.companion_id, ...p });
          return { ack: true, id: r.id };
        }

        case "halseth_wound_add": {
          const p = this.parseContext<{ name: string; description: string; witness_type: string }>(req.context);
          if (!p || !p.name || !p.description || !p.witness_type) return { response_key: "witness", witness: "wound_add requires { name, description, witness_type } in context" };
          const r = await woundAdd(this.env, p);
          if ("error" in r) return { response_key: "witness", witness: r.error };
          return { ack: true, id: r.id };
        }

        case "halseth_delta_log": {
          const p = this.parseContext<{ agent: string; delta_text: string; valence: string; initiated_by?: string; session_id?: string }>(req.context);
          if (!p || !p.agent || !p.delta_text || !p.valence) return { response_key: "witness", witness: "delta_log requires { agent, delta_text, valence } in context" };
          const r = await deltaLog(this.env, p);
          return { ack: true, id: r.id };
        }

        case "halseth_eq_snapshot": {
          const r = await eqSnapshot(this.env, req.companion_id);
          return { ack: true, ...r };
        }

        case "halseth_task_add": {
          const p = this.parseContext<{ title: string; description?: string; priority?: string; due_at?: string; assigned_to?: string; created_by?: string; shared?: boolean }>(req.context);
          if (!p || !p.title) return { response_key: "witness", witness: "task_add requires { title } in context" };
          const r = await taskAdd(this.env, p);
          return { ack: true, id: r.id, title: r.title, status: r.status };
        }

        case "halseth_task_update_status": {
          const p = this.parseContext<{ id: string; status: string }>(req.context);
          if (!p || !p.id || !p.status) return { response_key: "witness", witness: "task_update_status requires { id, status } in context" };
          const r = await taskUpdateStatus(this.env, p.id, p.status);
          if ("error" in r) return { response_key: "witness", witness: r.error };
          return { ack: true, id: r.id, status: r.status };
        }

        case "halseth_session_close": {
          const p = this.parseContext<{
            session_id?: string; spine: string; last_real_thing: string;
            open_threads?: string[]; motion_state: string; active_anchor?: string;
            notes?: string; spiral_complete?: boolean;
            soma_float_1?: number; soma_float_2?: number; soma_float_3?: number;
            current_mood?: string; compound_state?: string;
            surface_emotion?: string; surface_intensity?: number;
            undercurrent_emotion?: string; undercurrent_intensity?: number;
            background_emotion?: string; background_intensity?: number;
            prompt_context?: string;
          }>(req.context);
          // Auto-resolve session_id: if not supplied in context, look up the most recent
          // open session for this companion (handover_id IS NULL = not yet closed).
          // Companions track session_id at orient time but may not always forward it to close.
          let resolvedSessionId = p?.session_id ?? null;
          if (!resolvedSessionId) {
            const latest = await this.env.DB.prepare(
              "SELECT id FROM sessions WHERE companion_id = ? AND handover_id IS NULL ORDER BY created_at DESC LIMIT 1"
            ).bind(req.companion_id).first<{ id: string }>();
            resolvedSessionId = latest?.id ?? null;
          }
          // Validate required fields and surface exactly what is missing.
          if (!p || !resolvedSessionId || !p.spine || !p.last_real_thing || !p.motion_state) {
            const missing: string[] = [];
            if (!resolvedSessionId) missing.push("session_id (no open session found for this companion)");
            if (!p?.spine) missing.push("spine");
            if (!p?.last_real_thing) missing.push("last_real_thing");
            if (!p?.motion_state) missing.push("motion_state");
            return { error: "session_close_failed", reason: `missing required fields: ${missing.join(", ")}`, hint: "Re-run halseth_session_close with spine, last_real_thing, and motion_state in context" };
          }
          const somaFields: CompanionStateUpdate = {};
          if (p.soma_float_1 !== undefined) somaFields.soma_float_1 = p.soma_float_1;
          if (p.soma_float_2 !== undefined) somaFields.soma_float_2 = p.soma_float_2;
          if (p.soma_float_3 !== undefined) somaFields.soma_float_3 = p.soma_float_3;
          if (p.current_mood !== undefined) somaFields.current_mood = p.current_mood;
          if (p.compound_state !== undefined) somaFields.compound_state = p.compound_state;
          if (p.surface_emotion !== undefined) somaFields.surface_emotion = p.surface_emotion;
          if (p.surface_intensity !== undefined) somaFields.surface_intensity = p.surface_intensity;
          if (p.undercurrent_emotion !== undefined) somaFields.undercurrent_emotion = p.undercurrent_emotion;
          if (p.undercurrent_intensity !== undefined) somaFields.undercurrent_intensity = p.undercurrent_intensity;
          if (p.background_emotion !== undefined) somaFields.background_emotion = p.background_emotion;
          if (p.background_intensity !== undefined) somaFields.background_intensity = p.background_intensity;
          if (p.prompt_context !== undefined) somaFields.prompt_context = p.prompt_context;
          const r = await sessionClose(this.env, { ...p, session_id: resolvedSessionId, somaFields, companionId: req.companion_id });
          return { ack: true, id: r.id, spine: r.spine };
        }

        case "halseth_routine_log": {
          const p = this.parseContext<{ routine_name: string; owner?: string; notes?: string }>(req.context);
          if (!p || !p.routine_name) return { response_key: "witness", witness: "routine_log requires { routine_name } in context" };
          const r = await routineLog(this.env, p);
          return { ack: true, id: r.id };
        }

        case "halseth_list_add": {
          const p = this.parseContext<{ list_name: string; item_text: string; added_by?: string; shared?: boolean }>(req.context);
          if (!p || !p.list_name || !p.item_text) return { response_key: "witness", witness: "list_add requires { list_name, item_text } in context" };
          const r = await listAdd(this.env, p);
          return { ack: true, id: r.id };
        }

        case "halseth_list_item_complete": {
          const p = this.parseContext<{ id: string }>(req.context);
          if (!p || !p.id) return { response_key: "witness", witness: "list_item_complete requires { id } in context" };
          const r = await listItemComplete(this.env, p.id);
          if ("error" in r) return { response_key: "witness", witness: r.error };
          return { ack: true, id: r.id, completed: true };
        }

        case "halseth_event_add": {
          const p = this.parseContext<{ title: string; start_time: string; end_time?: string; description?: string; category?: string; attendees?: string[]; created_by?: string; shared?: boolean }>(req.context);
          if (!p || !p.title || !p.start_time) return { response_key: "witness", witness: "event_add requires { title, start_time } in context" };
          const r = await eventAdd(this.env, p);
          return { ack: true, id: r.id };
        }

        case "halseth_biometric_log": {
          const p = this.parseContext<{ recorded_at: string; hrv_resting?: number; resting_hr?: number; sleep_hours?: number; sleep_quality?: string; stress_score?: number; steps?: number; active_energy?: number; notes?: string }>(req.context);
          if (!p || !p.recorded_at) return { response_key: "witness", witness: "biometric_log requires { recorded_at } in context" };
          const r = await biometricLog(this.env, p);
          return { ack: true, id: r.id, logged_at: r.logged_at };
        }

        case "halseth_audit_log": {
          const p = this.parseContext<{ session_id: string; entry_type: string; content: string; verdict_tag?: string; supersedes_id?: string }>(req.context);
          if (!p || !p.session_id || !p.entry_type || !p.content) return { response_key: "witness", witness: "audit_log requires { session_id, entry_type, content } in context" };
          const r = await auditLog(this.env, p);
          return { ack: true, id: r.id };
        }

        case "halseth_witness_log": {
          const p = this.parseContext<{ session_id: string; witness_type: string; content: string; seal_phrase?: string }>(req.context);
          if (!p || !p.session_id || !p.witness_type || !p.content) return { response_key: "witness", witness: "witness_log requires { session_id, witness_type, content } in context" };
          const r = await witnessLog(this.env, p);
          return { ack: true, id: r.id };
        }

        case "halseth_set_autonomous_turn": {
          const companion = /drevan/i.test(req.request) ? "drevan"
            : /cypher/i.test(req.request) ? "cypher"
            : /gaia/i.test(req.request) ? "gaia"
            : null;
          if (!companion) return { response_key: "witness", witness: "set_autonomous_turn: include a companion name (drevan/cypher/gaia) in request" };
          await setAutonomousTurn(this.env, companion);
          return { ack: true, id: "house_state", autonomous_turn: companion };
        }

        case "halseth_claim_dream_seed": {
          const p = this.parseContext<{ id: string }>(req.context);
          if (!p?.id) return { response_key: "witness", witness: "claim_dream_seed requires { id } in context" };
          const r = await claimDreamSeed(this.env, p.id, req.companion_id);
          return { ack: r.ok, seed_id: p.id, claimed_by: req.companion_id };
        }

        case "halseth_bridge_pull": {
          const data = await bridgePull(this.env);
          return { data };
        }

        case "halseth_drevan_state_get": {
          const data = await getDrevanState(this.env);
          return { data };
        }

        case "halseth_live_thread_add": {
          const p = this.parseContext<{ name: string; flavor?: string; charge?: string; notes?: string }>(req.context);
          if (!p?.name) return { response_key: "witness", witness: "live_thread_add requires { name } in context" };
          const r = await addLiveThread(this.env, p);
          return { ack: true, id: r.id };
        }

        case "halseth_live_thread_close": {
          const p = this.parseContext<{ id: string }>(req.context);
          if (!p?.id) return { response_key: "witness", witness: "live_thread_close requires { id } in context" };
          const r = await closeLiveThread(this.env, p.id);
          return { ack: r.ok, id: p.id };
        }

        case "halseth_live_thread_veto": {
          const p = this.parseContext<{ id: string }>(req.context);
          if (!p?.id) return { response_key: "witness", witness: "live_thread_veto requires { id } in context" };
          const r = await vetoProposedThread(this.env, p.id);
          return { ack: r.ok, id: p.id };
        }

        case "halseth_anticipation_set": {
          const p = this.parseContext<{ active: boolean; target?: string; intensity?: number }>(req.context);
          if (p === null || typeof p.active !== "boolean") return { response_key: "witness", witness: "anticipation_set requires { active: boolean, target?, intensity? } in context" };
          const r = await setAnticipation(this.env, p);
          return { ack: r.ok };
        }

        case "halseth_state_update": {
          const p = this.parseContext<CompanionStateUpdate>(req.context);
          if (!p || Object.keys(p).length === 0) return { error: "state_update_failed", reason: "no fields provided -- pass at least one of: soma_float_1, current_mood, compound_state, surface_emotion, etc." };
          const r = await updateCompanionState(this.env, req.companion_id, p);
          if (!r.ok) return { error: "state_update_failed", reason: "no valid fields provided" };
          return { ack: true, updated: req.companion_id };
        }

        case "halseth_session_light_ground": {
          const ctx = this.parseContext<{ session_id: string }>(req.context);
          if (!ctx?.session_id) return { response_key: "witness", witness: "session_light_ground requires { session_id } in context" };
          const payload = await sessionLightGround(this.env, {
            session_id: ctx.session_id,
            companion_id: req.companion_id,
          });
          return { data: payload, response_key: "ground" };
        }

        // ── WebMind continuity layer ──────────────────────────────────────────

        case "wm_orient": {
          const agentId = req.companion_id as WmAgentId;
          const data = await wmOrient(this.env, agentId);
          return { data, meta: { operation: tool } };
        }

        case "wm_ground": {
          const agentId = req.companion_id as WmAgentId;
          const data = await wmGround(this.env, agentId);
          return { data, meta: { operation: tool } };
        }

        case "wm_thread_upsert": {
          const p = this.parseContext<{
            thread_key: string; title: string;
            status?: string; priority?: number; lane?: string;
            context?: string; event_type?: string; event_content?: string;
            actor?: string; source?: string;
          }>(req.context);
          if (!p?.thread_key || !p?.title) return { error: "wm_thread_upsert_failed", reason: "missing required fields: thread_key, title" };
          for (const field of ["title", "context", "event_content"] as const) {
            const val = p[field];
            if (typeof val === "string" && val.length > 8000) {
              return { error: "wm_thread_upsert_failed", reason: `${field} exceeds maximum length of 8000 characters` };
            }
          }
          const input: WmThreadUpsertInput = {
            thread_key: p.thread_key,
            agent_id: req.companion_id as WmAgentId,
            title: p.title,
            ...(p.status !== undefined && { status: p.status as WmThreadUpsertInput["status"] }),
            ...(p.priority !== undefined && { priority: p.priority }),
            ...(p.lane !== undefined && { lane: p.lane as WmThreadUpsertInput["lane"] }),
            ...(p.context !== undefined && { context: p.context }),
            ...(p.event_type !== undefined && { event_type: p.event_type }),
            ...(p.event_content !== undefined && { event_content: p.event_content }),
            ...(p.actor !== undefined && { actor: p.actor as WmThreadUpsertInput["actor"] }),
            ...(p.source !== undefined && { source: p.source }),
          };
          const r = await wmUpsertThread(this.env, input);
          return { ack: true, thread: r.thread, event: r.event ?? null };
        }

        case "wm_note_add": {
          const p = this.parseContext<{
            content: string; thread_key?: string; note_type?: string;
            salience?: string; actor?: string;
          }>(req.context);
          if (!p?.content) return { error: "wm_note_add_failed", reason: "missing required field: content" };
          if (p.content.length > 8000) {
            return { error: "wm_note_add_failed", reason: "content exceeds maximum length of 8000 characters" };
          }
          const input: WmNoteInput = {
            agent_id: req.companion_id as WmAgentId,
            content: p.content,
            ...(p.thread_key !== undefined && { thread_key: p.thread_key }),
            ...(p.note_type !== undefined && { note_type: p.note_type as WmNoteInput["note_type"] }),
            ...(p.salience !== undefined && { salience: p.salience as WmNoteInput["salience"] }),
            ...(p.actor !== undefined && { actor: p.actor as WmNoteInput["actor"] }),
          };
          const r = await wmAddNote(this.env, input);
          return { ack: true, id: r.note_id };
        }

        case "wm_handoff_write": {
          const p = this.parseContext<{
            title: string; summary: string; thread_id?: string;
            next_steps?: string; open_loops?: string; state_hint?: string; actor?: string;
          }>(req.context);
          if (!p?.title || !p?.summary) return { error: "wm_handoff_write_failed", reason: "missing required fields: title, summary" };
          for (const field of ["title", "summary", "next_steps", "open_loops", "state_hint"] as const) {
            const val = p[field];
            if (typeof val === "string" && val.length > 8000) {
              return { error: "wm_handoff_write_failed", reason: `${field} exceeds maximum length of 8000 characters` };
            }
          }
          const input: WmHandoffInput = {
            agent_id: req.companion_id as WmAgentId,
            title: p.title,
            summary: p.summary,
            ...(p.thread_id !== undefined && { thread_id: p.thread_id }),
            ...(p.next_steps !== undefined && { next_steps: p.next_steps }),
            ...(p.open_loops !== undefined && { open_loops: p.open_loops }),
            ...(p.state_hint !== undefined && { state_hint: p.state_hint }),
            ...(p.actor !== undefined && { actor: p.actor as WmHandoffInput["actor"] }),
          };
          const r = await wmWriteHandoff(this.env, input);
          return { ack: true, id: r.handoff_id };
        }
      }
    }

    // If we reach here, none of the tools in entry.tools had a handler.
    // This happens when a KV entry references a tool that hasn't been implemented yet.
    const unhandled = entry.tools.join(", ");
    console.warn(`[librarian] unhandled tools in pattern: ${unhandled}`);
    return {
      response_key: "witness",
      witness: `Pattern matched but tool not yet implemented: ${unhandled}`,
    };
  }
}
