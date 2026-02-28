import { Env } from "./types";
import { Router } from "./router";
import { listCompanions, createCompanion, getCompanion } from "./handlers/companions";
import { listMemories, createMemory, getMemory } from "./handlers/memory";
import { listDeltas, appendDelta } from "./handlers/relational";
import { bootstrapConfig } from "./handlers/admin";
import { getPresence } from "./handlers/presence";
import { getHouseState, updateHouseState } from "./handlers/house";
import { getNotes, createNote } from "./handlers/notes";
import { uploadAsset, serveAsset } from "./handlers/assets";
import { handleBiometricsLatest, handleBiometricsList } from "./handlers/biometrics";
import { handleMcp } from "./mcp/server";

const router = new Router()
  // MCP tool interface — primary AI companion entry point
  .on("POST", "/mcp", (request, env) => handleMcp(request, env))
  .on("GET",  "/mcp", async () => new Response("Method Not Allowed", { status: 405 }))

  // Admin
  .on("POST", "/admin/bootstrap", (request, env) => bootstrapConfig(request, env))

  // Presence (dashboard feed)
  .on("GET", "/presence", (request, env) => getPresence(request, env))

  // House state (room, spoons, love-o-meter)
  .on("GET",  "/house", (request, env) => getHouseState(request, env))
  .on("POST", "/house", (request, env) => updateHouseState(request, env))

  // Async notes between companion and human
  .on("GET",  "/notes", (request, env) => getNotes(request, env))
  .on("POST", "/notes", (request, env) => createNote(request, env))

  // Biometric snapshots
  .on("GET", "/biometrics/latest", (request, env) => handleBiometricsLatest(request, env))
  .on("GET", "/biometrics",        (request, env) => handleBiometricsList(request, env))

  // R2 asset storage
  .on("POST", "/assets/upload", (request, env) => uploadAsset(request, env))
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await router.handle(request, env);
    } catch (err) {
      console.error(err);
      return new Response("Internal server error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
