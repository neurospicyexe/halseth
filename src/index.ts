import { Env } from "./types";
import { Router } from "./router";
import { listCompanions, createCompanion, getCompanion } from "./handlers/companions";
import { listMemories, createMemory, getMemory } from "./handlers/memory";
import { listDeltas, appendDelta } from "./handlers/relational";
import { bootstrapConfig, backfillEmbeddings } from "./handlers/admin";
import { getPresence } from "./handlers/presence";
import { getHouseState, updateHouseState } from "./handlers/house";
import { getNotes, createNote } from "./handlers/notes";
import { uploadAsset, serveAsset, listAssets } from "./handlers/assets";
import { handleBiometricsLatest, handleBiometricsList, handleBiometricsPost } from "./handlers/biometrics";
import { getHandovers, getCompanionJournal, getCypherAudit, getGaiaWitness, getWounds, getRoutines, getDeltas, getTasks, getEvents, getLists, patchTask, completeListItem } from "./handlers/history";
import { postCompanionJournal } from "./handlers/companion_journal";
import { getSessions, getSessionById, getRecentRelationalSessions } from "./handlers/sessions";
import { getFeelings, getDreams, getDreamSeeds, postDreamSeed } from "./handlers/feelings-dreams";
import { getJournal } from "./handlers/human-journal";
import { getBridgeShared, postBridgeAct, postBridgeToggle } from "./handlers/bridge";
import {
  getOAuthProtectedResource,
  getOAuthAuthServerMetadata,
  postOAuthRegister,
  getOAuthAuthorize,
  postOAuthAuthorize,
  postOAuthToken,
  handleOAuthCors,
} from "./handlers/oauth";
import { handleMcp } from "./mcp/server";
import { handleLibrarian } from "./librarian/index.js";
import { handleLibrarianMcp } from "./librarian/mcp.js";
import { postStmEntry, getStmEntries } from "./handlers/stm.js";
import { postPersonaBlocks, postHumanBlocks, getPersonaBlocks, getHumanBlocks } from "./handlers/blocks.js";
import { getSoma } from "./handlers/soma.js";
import { getUnreadInterCompanionNotes, ackInterCompanionNotes } from "./handlers/inter_companion_notes.js";
import { getMindOrient, getMindGround, postMindHandoff, postMindThread, postMindNote, postMindDream, getMindDreams, postMindDreamExamine, postMindLoop, getMindLoops, postMindLoopClose, postMindRelational, getMindRelational } from "./handlers/webmind.js";
import { postNoteSit, postNoteMetabolize, getSittingNotes } from "./handlers/sits.js";
import { getSynthesisSummaries, getInterCompanionNotes, getMindHandoffs } from "./handlers/ingest.js";
import {
  getBasins, postBasin,
  getBasinHistory, postBasinHistory, confirmBasinHistory,
  getTensions, postTension, patchTension,
} from "./handlers/companion-growth.js";
import { checkRateLimit } from "./lib/rate-limit.js";
import { authGuard } from "./lib/auth.js";

const router = new Router()
  // MCP tool interface — primary AI companion entry point
  .on("POST",   "/mcp", (request, env) => handleMcp(request, env))
  .on("GET",    "/mcp", (request, env) => handleMcp(request, env))
  .on("DELETE", "/mcp", (request, env) => handleMcp(request, env))

  // Librarian — natural language companion entry point
  .on("POST", "/librarian", async (request, env) => {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    return (await checkRateLimit(env.RATE_LIMITER, `librarian:${ip}`)) ?? handleLibrarian(request, env);
  })

  // Librarian MCP -- single ask_librarian tool for companion Claude.ai projects
  .on("POST",   "/librarian/mcp", (request, env) => handleLibrarianMcp(request, env))
  .on("GET",    "/librarian/mcp", (request, env) => handleLibrarianMcp(request, env))
  .on("DELETE", "/librarian/mcp", (request, env) => handleLibrarianMcp(request, env))

  // OAuth 2.0
  .on("OPTIONS", "/.well-known/oauth-protected-resource",   async () => handleOAuthCors())
  .on("OPTIONS", "/.well-known/oauth-authorization-server", async () => handleOAuthCors())
  .on("OPTIONS", "/oauth/register",  async () => handleOAuthCors())
  .on("OPTIONS", "/oauth/authorize", async () => handleOAuthCors())
  .on("OPTIONS", "/oauth/token",     async () => handleOAuthCors())
  .on("GET",  "/.well-known/oauth-protected-resource",   async (request) => getOAuthProtectedResource(request))
  .on("GET",  "/.well-known/oauth-authorization-server", async (request) => getOAuthAuthServerMetadata(request))
  .on("POST", "/oauth/register",  (request, env) => postOAuthRegister(request, env))
  .on("GET",  "/oauth/authorize", (request, env) => getOAuthAuthorize(request, env))
  .on("POST", "/oauth/authorize", (request, env) => postOAuthAuthorize(request, env))
  .on("POST", "/oauth/token", async (request, env) => {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    return (await checkRateLimit(env.RATE_LIMITER, `oauth:${ip}`)) ?? postOAuthToken(request, env);
  })

  // Admin
  .on("POST", "/admin/bootstrap", async (request, env) => {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    return (await checkRateLimit(env.RATE_LIMITER, `bootstrap:${ip}`)) ?? bootstrapConfig(request, env);
  })
  .on("POST", "/admin/backfill-embeddings",  (request, env) => backfillEmbeddings(request, env))

  // Presence (dashboard feed)
  .on("GET", "/presence", (request, env) => getPresence(request, env))

  // House state
  .on("GET",  "/house", (request, env) => getHouseState(request, env))
  .on("POST", "/house", (request, env) => updateHouseState(request, env))

  // Async notes between companion and human
  .on("GET",  "/notes", (request, env) => getNotes(request, env))
  .on("POST", "/notes", (request, env) => createNote(request, env))

  // Biometric snapshots
  .on("GET", "/biometrics/latest", (request, env) => handleBiometricsLatest(request, env))
  .on("GET", "/biometrics",        (request, env) => handleBiometricsList(request, env))
  .on("POST", "/biometrics",       (request, env) => handleBiometricsPost(request, env))

  // Inter-companion notes — Discord bot note delivery poll
  .on("GET", "/inter-companion-notes/unread/:companionId", (request, env, params) => getUnreadInterCompanionNotes(request, env, params ?? {}))
  .on("POST", "/inter-companion-notes/ack", (request, env) => ackInterCompanionNotes(request, env))

  // STM — Discord bot short-term memory persistence
  .on("POST", "/stm/entries", (request, env) => postStmEntry(request, env))
  .on("GET",  "/stm/entries", (request, env) => getStmEntries(request, env))

  // Distillation blocks — rolling LTM from Discord conversations
  .on("POST", "/persona-blocks", (request, env) => postPersonaBlocks(request, env))
  .on("GET",  "/persona-blocks", (request, env) => getPersonaBlocks(request, env))
  .on("POST", "/human-blocks",   (request, env) => postHumanBlocks(request, env))
  .on("GET",  "/human-blocks",   (request, env) => getHumanBlocks(request, env))

  // Soma — companion SOMA state for Hearth
  .on("GET", "/soma", (request, env) => getSoma(request, env))

  // WebMind — companion continuity and thread state
  .on("GET",  "/mind/orient/:agent_id", (request, env, params) => getMindOrient(request, env, params ?? {}))
  .on("GET",  "/mind/ground/:agent_id", (request, env, params) => getMindGround(request, env, params ?? {}))
  .on("POST", "/mind/handoff",          (request, env) => postMindHandoff(request, env))
  .on("POST", "/mind/thread",           (request, env) => postMindThread(request, env))
  .on("POST", "/mind/note",             (request, env) => postMindNote(request, env))
  .on("POST", "/mind/dream",            (request, env) => postMindDream(request, env))
  .on("GET",  "/mind/dreams/:agent_id", (request, env, params) => getMindDreams(request, env, params ?? {}))
  .on("POST", "/mind/dream/:id/examine",(request, env, params) => postMindDreamExamine(request, env, params ?? {}))
  .on("POST", "/mind/loop",             (request, env) => postMindLoop(request, env))
  .on("GET",  "/mind/loops/:agent_id",  (request, env, params) => getMindLoops(request, env, params ?? {}))
  .on("POST", "/mind/loop/:id/close",   (request, env, params) => postMindLoopClose(request, env, params ?? {}))
  .on("POST", "/mind/relational",       (request, env) => postMindRelational(request, env))
  .on("GET",  "/mind/relational/:agent_id", (request, env, params) => getMindRelational(request, env, params ?? {}))
  .on("POST", "/mind/note/:id/sit",         (request, env, params) => postNoteSit(request, env, params ?? {}))
  .on("POST", "/mind/note/:id/metabolize",  (request, env, params) => postNoteMetabolize(request, env, params ?? {}))
  .on("GET",  "/mind/sitting/:agent_id",    (request, env, params) => getSittingNotes(request, env, params ?? {}))

  // Companion self-defense layer -- basins, tensions, drift history
  .on("GET",  "/companion-growth/basins/:companion_id",           (request, env, params) => getBasins(request, env, params ?? {}))
  .on("POST", "/companion-growth/basins",                         (request, env)         => postBasin(request, env))
  .on("GET",  "/companion-growth/basin-history/:companion_id",    (request, env, params) => getBasinHistory(request, env, params ?? {}))
  .on("POST", "/companion-growth/basin-history",                  (request, env)         => postBasinHistory(request, env))
  .on("POST", "/companion-growth/basin-history/:id/confirm",      (request, env, params) => confirmBasinHistory(request, env, params ?? {}))
  .on("GET",  "/companion-growth/tensions/:companion_id",         (request, env, params) => getTensions(request, env, params ?? {}))
  .on("POST", "/companion-growth/tensions",                       (request, env)         => postTension(request, env))
  .on("PATCH","/companion-growth/tensions/:id",                   (request, env, params) => patchTension(request, env, params ?? {}))

  // Ingest — read-only feeds for Second Brain pull pipeline
  .on("GET", "/ingest/synthesis-summaries",   (request, env) => getSynthesisSummaries(request, env))
  .on("GET", "/ingest/inter-companion-notes", (request, env) => getInterCompanionNotes(request, env))
  .on("GET", "/ingest/mind-handoffs",         (request, env) => getMindHandoffs(request, env))

  // Bridge
  .on("GET",  "/bridge/shared",  (request, env) => getBridgeShared(request, env))
  .on("POST", "/bridge/act",     (request, env) => postBridgeAct(request, env))
  .on("POST", "/bridge/toggle",  (request, env) => postBridgeToggle(request, env))

  // Sessions (read-only — used by nullsafe-second-brain synthesis tools)
  .on("GET", "/sessions/recent-relational", (request, env) => getRecentRelationalSessions(request, env))
  .on("GET", "/sessions",    (request, env) => getSessions(request, env))
  .on("GET", "/sessions/:id", (request, env, params) => getSessionById(request, env, params))

  // History feeds (read-only, authenticated)
  .on("GET", "/handovers",         (request, env) => getHandovers(request, env))
  .on("GET",  "/companion-journal", (request, env) => getCompanionJournal(request, env))
  .on("POST", "/companion-journal", (request, env) => postCompanionJournal(request, env))
  // Alias: Hearth API proxy calls /companion-notes
  .on("GET", "/companion-notes",   (request, env) => getCompanionJournal(request, env))
  .on("GET", "/cypher-audit",      (request, env) => getCypherAudit(request, env))
  .on("GET", "/gaia-witness",      (request, env) => getGaiaWitness(request, env))
  .on("GET", "/wounds",            (request, env) => getWounds(request, env))
  .on("GET", "/routines",          (request, env) => getRoutines(request, env))
  .on("GET", "/deltas",            (request, env) => getDeltas(request, env))

  // Emotion and dream feeds
  .on("GET",  "/feelings",     (request, env) => getFeelings(request, env))
  .on("GET",  "/dreams",       (request, env) => getDreams(request, env))
  .on("GET",  "/dream-seeds",  (request, env) => getDreamSeeds(request, env))
  .on("POST", "/dream-seeds",  (request, env) => postDreamSeed(request, env))

  // Human journal
  .on("GET", "/journal", (request, env) => getJournal(request, env))

  // Tasks, events, lists (direct access — no bridge required)
  .on("GET",   "/tasks",       (request, env) => getTasks(request, env))
  .on("PATCH", "/tasks/:id",   (request, env, params) => patchTask(request, env, params ?? {}))
  .on("GET",   "/events",      (request, env) => getEvents(request, env))
  .on("GET",   "/lists",       (request, env) => getLists(request, env))
  .on("POST",  "/lists/:id/complete", (request, env, params) => completeListItem(request, env, params ?? {}))

  // R2 asset storage
  .on("POST", "/assets/upload", (request, env) => uploadAsset(request, env))
  .on("GET",  "/assets",        (request, env) => listAssets(request, env))
  .on("GET",  "/assets/*",      (request, env) => serveAsset(request, env))

  // Legacy HTTP API (companion-scoped routes)
  .on("GET",  "/companions",                               listCompanions)
  .on("POST", "/companions",                               createCompanion)
  .on("GET",  "/companions/:id",                           getCompanion)
  .on("GET",  "/companions/:companionId/memories",         listMemories)
  .on("POST", "/companions/:companionId/memories",         createMemory)
  .on("GET",  "/companions/:companionId/memories/:memoryId", getMemory)
  .on("GET",  "/companions/:companionId/deltas",           listDeltas)
  .on("POST", "/companions/:companionId/deltas",           appendDelta);

// Routes that do NOT require auth (OAuth flow + presence read-only dashboard feed)
const PUBLIC_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/presence",
  "/librarian/mcp",  // has its own auth gate that accepts OAuth tokens
]);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      // OPTIONS preflight and public paths skip auth entirely
      if (request.method !== "OPTIONS" && !isPublicPath(url.pathname)) {
        const denied = authGuard(request, env);
        if (denied) return denied;
      }

      return await router.handle(request, env);
    } catch (err) {
      console.error(err);
      return new Response("Internal server error", { status: 500 });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { processQueue } = await import("./synthesis/index.js");
    ctx.waitUntil(processQueue(env));
  },
} satisfies ExportedHandler<Env>;
