import { Env } from "./types";
import { Router } from "./router";
import { listCompanions, createCompanion, getCompanion } from "./handlers/companions";
import { listMemories, createMemory, getMemory } from "./handlers/memory";
import { listDeltas, appendDelta } from "./handlers/relational";

const router = new Router()
  // Companion routes
  .on("GET",  "/companions",                     listCompanions)
  .on("POST", "/companions",                     createCompanion)
  .on("GET",  "/companions/:id",                 getCompanion)

  // Memory routes (scoped to companion)
  .on("GET",  "/companions/:companionId/memories",           listMemories)
  .on("POST", "/companions/:companionId/memories",           createMemory)
  .on("GET",  "/companions/:companionId/memories/:memoryId", getMemory)

  // Relational delta routes (append-only by covenant)
  .on("GET",  "/companions/:companionId/deltas",             listDeltas)
  .on("POST", "/companions/:companionId/deltas",             appendDelta);

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
