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
  sessionLoad, taskList, handoverRead, addCompanionNote,
  feelingsRead, journalRead, woundRead, deltaRead,
  dreamsRead, dreamSeedRead, eqRead, routineRead, listRead, eventList,
  houseRead, personalityRead, biometricRead, auditRead, sessionRead, fossilCheck,
  feelingLog, journalAdd, dreamLog, woundAdd, deltaLog, eqSnapshot,
  taskAdd, taskUpdateStatus, sessionClose, routineLog, listAdd, listItemComplete,
  eventAdd, biometricLog, auditLog, witnessLog, setAutonomousTurn, bridgePull,
} from "./backends/halseth.js";
import { getCurrentFront, getMember, updateMemberDescription, searchMembers, getFrontHistory, logFrontChange, addMemberNote } from "./backends/plural.js";
import { extractMemberName, extractDescriptionUpdate } from "./extract.js";
import {
  semanticSearch, filteredRecall, recentPatterns,
  sbRead, sbList, sbSaveDocument, sbLogObservation, sbSynthesizeSession, sbSaveStudy,
} from "./backends/second-brain.js";
import { buildResponse } from "./response/builder.js";
import { ResponseKey } from "./response/budget.js";

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

    // Tier 3: KV lookup
    if (patternKey && patternKey !== "unknown") {
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

      const keyList = kvKeys.map(k => hints[k] ? `${k} (e.g. "${hints[k]}")` : k).join(", ");

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
          return { data: result ?? "No results.", meta: { operation: tool } };
        }

        case "sb_recall": {
          const p = this.parseContext<{ companion?: string; content_type?: string; limit?: number }>(req.context);
          const result = await filteredRecall(this.env, { companion: p?.companion ?? req.companion_id, content_type: p?.content_type, limit: p?.limit });
          return { data: result ?? "No results.", meta: { operation: tool } };
        }

        case "sb_recent_patterns": {
          const result = await recentPatterns(this.env);
          return { data: result ?? "No patterns found.", meta: { operation: tool } };
        }

        case "sb_read": {
          const p = this.parseContext<{ path: string; query?: string }>(req.context);
          if (!p?.path) return { response_key: "witness", witness: "sb_read requires { path } in context" };
          const result = await sbRead(this.env, p.path, p.query);
          return { data: result ?? "Not found.", meta: { operation: tool } };
        }

        case "sb_list": {
          const p = this.parseContext<{ path?: string }>(req.context);
          const result = await sbList(this.env, p?.path);
          return { data: result ?? "Empty.", meta: { operation: tool } };
        }

        case "sb_save_document": {
          const p = this.parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(req.context);
          if (!p?.content) return { response_key: "witness", witness: "sb_save_document requires { content } in context" };
          const r = await sbSaveDocument(this.env, { ...p, content_type: "document" });
          return { ack: r.ack, response: r.response };
        }

        case "sb_save_note": {
          const p = this.parseContext<{ content: string; path?: string; companion?: string; tags?: string[] }>(req.context);
          if (!p?.content) return { response_key: "witness", witness: "sb_save_note requires { content } in context" };
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
          return { data: await listRead(this.env, listMatch?.[1]?.trim()), meta: { operation: tool } };
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
          return { data: await fossilCheck(this.env, subject), meta: { operation: tool } };
        }

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
          const p = this.parseContext<{ session_id: string; spine: string; last_real_thing: string; open_threads?: string[]; motion_state: string; active_anchor?: string; notes?: string; spiral_complete?: boolean }>(req.context);
          if (!p || !p.session_id || !p.spine || !p.last_real_thing || !p.motion_state) return { response_key: "witness", witness: "session_close requires { session_id, spine, last_real_thing, motion_state } in context" };
          const r = await sessionClose(this.env, p);
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
          const on = /\bon\b|true|enable/i.test(req.request);
          const off = /\boff\b|false|disable/i.test(req.request);
          if (!on && !off) return { response_key: "witness", witness: "set_autonomous_turn: include 'on' or 'off' in request" };
          await setAutonomousTurn(this.env, on);
          return { ack: true, id: "house_state", autonomous_turn: on };
        }

        case "halseth_bridge_pull": {
          const data = await bridgePull(this.env);
          return { data };
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
