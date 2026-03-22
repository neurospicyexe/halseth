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
import { sessionLoad, taskList, handoverRead, addCompanionNote } from "./backends/halseth.js";
import { getCurrentFront, getMember, updateMemberDescription, searchMembers, getFrontHistory } from "./backends/plural.js";
import { extractMemberName, extractDescriptionUpdate } from "./extract.js";
import { semanticSearch, filteredRecall } from "./backends/second-brain.js";
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
    try {
      // Workers AI text generation -- classification only, not generation.
      // IMPORTANT: Only KV keys are listed here. Fast-path keys (session_open, etc.)
      // are already handled by matchFastPath() before classify() is called.
      // If the classifier returned a fast-path key, KV.get() would return null
      // and the request would silently fail. Keep these lists separate.
      // TODO: KV.list() is paginated -- kvList.keys is capped at 1000 entries and
      // does not follow the cursor. Before adding more than ~50 KV patterns, replace
      // this with a cached "_index" KV entry that lists all known pattern keys,
      // updated whenever a pattern is added. Safe for now: classify() short-circuits
      // at line below when KV is empty.
      const kvList = await this.env.LIBRARIAN_KV.list();
      const kvKeys = kvList.keys.map(k => k.name).join(", ");

      // Nothing in KV yet -- return unknown rather than prompting with empty list
      if (!kvKeys) return "unknown";

      const prompt = `You are a request classifier. Given a companion's request, return ONLY the matching pattern key from this list, or "unknown" if none match.

Pattern keys: ${kvKeys}

Request: "${request}"

Return only the pattern key name or "unknown". No explanation.`;

      // Cast required: Workers AI types don't accept string literals directly.
      // If model name changes, update here -- no compile-time typo detection.
      const result = await this.env.AI.run(
        "@cf/meta/llama-3.1-8b-instruct" as Parameters<typeof this.env.AI.run>[0],
        {
          messages: [{ role: "user", content: prompt }],
          max_tokens: 20,
        }
      ) as { response?: string };

      return result?.response?.trim().toLowerCase() ?? null;
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
          const text = handover
            ? JSON.stringify(handover)
            : "No handover packet found.";
          const handoverField = handover
            ? {
                active_anchor: (handover as Record<string, unknown>).active_anchor as string | null ?? null,
                open_threads: (handover as Record<string, unknown>).open_threads as string | null ?? null,
              }
            : null;
          return buildResponse(
            req.companion_id,
            entry.response_key as ResponseKey,
            { session_id: "", handover: handoverField },
            text
          );
        }

        case "plural_get_current_front": {
          const front = await getCurrentFront(this.env);
          const text = front
            ? `${front.name} is fronting.`
            : "Front state unavailable.";
          return buildResponse(req.companion_id, entry.response_key as ResponseKey, { session_id: "" }, text);
        }

        case "sb_search": {
          const result = await semanticSearch(this.env, req.request);
          return buildResponse(req.companion_id, entry.response_key as ResponseKey, { session_id: "" }, result ?? "No results.");
        }

        case "sb_recall": {
          const result = await filteredRecall(this.env, { companion: req.companion_id });
          return buildResponse(req.companion_id, entry.response_key as ResponseKey, { session_id: "" }, result ?? "No results.");
        }

        case "plural_get_member": {
          const trigger = entry.triggers.find(t => req.request.toLowerCase().includes(t));
          const name = trigger ? extractMemberName(req.request, trigger) : null;
          if (!name) {
            return buildResponse(req.companion_id, "witness", {} as never, "couldn't identify a member name -- try 'tell me about Ash'");
          }
          const member = await getMember(this.env, name);
          if (!member) {
            return buildResponse(req.companion_id, "witness", {} as never, `couldn't find member '${name}'`);
          }
          return buildResponse(req.companion_id, "summary", member as never, JSON.stringify(member));
        }

        case "plural_update_member_description": {
          const parsed = extractDescriptionUpdate(req.request);
          if (!parsed) {
            return buildResponse(req.companion_id, "witness", {} as never, "couldn't parse that -- try 'update Ash\\'s description to [text]'");
          }
          const updateResult = await updateMemberDescription(this.env, parsed.member, parsed.description);
          return buildResponse(req.companion_id, "witness", {} as never, updateResult.success ? `updated ${updateResult.name}` : (updateResult.error ?? "update failed"));
        }

        case "plural_search_members": {
          const members = await searchMembers(this.env, req.request);
          return buildResponse(req.companion_id, "summary", {} as never, JSON.stringify(members));
        }

        case "plural_get_front_history": {
          const history = await getFrontHistory(this.env);
          return buildResponse(req.companion_id, "summary", {} as never, JSON.stringify(history));
        }

        case "halseth_companion_note_add": {
          const toMatch = req.request.match(/(to|for)\s+(drevan|cypher|gaia)/i);
          const to_id = toMatch?.[2]?.toLowerCase() ?? null;
          const content = req.context ?? req.request;
          const note = await addCompanionNote(this.env, req.companion_id, to_id, content);
          return buildResponse(req.companion_id, "witness", {} as never, `note recorded: ${note.id}`);
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
