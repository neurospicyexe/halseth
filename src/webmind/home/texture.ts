// src/webmind/home/texture.ts
import { Env } from "../../types.js";
import { CompanionId, HomeRoom } from "../types.js";

export interface TextureGateInput {
  moved: boolean;
  encountered: boolean;
  driftChanged: boolean;
  model: string;                 // "none" disables LLM texture entirely ($0)
  lastTextureAt: string | null;
  minIntervalMin: number;
  now: Date;
}

export function shouldFireTexture(i: TextureGateInput): boolean {
  if (i.model === "none") return false;
  const meaningful = i.moved || i.encountered || i.driftChanged;
  if (!meaningful) return false;
  if (i.lastTextureAt) {
    const elapsedMin = (i.now.getTime() - new Date(i.lastTextureAt).getTime()) / 60000;
    if (elapsedMin < i.minIntervalMin) return false;
  }
  return true;
}

// A TextureProvider turns a placement into a line of "what they're doing".
export interface TextureContext {
  companionId: CompanionId;
  room: HomeRoom;
  activity: string;
  driftType: "stable" | "growth" | "pressure";
}
export interface TextureProvider {
  generate(env: Env, ctx: TextureContext): Promise<string>;
}

// Default provider: $0. Recycles the placement's own activity phrase, shaped by
// register. No network call. Used whenever home_texture_model = "none".
export const recycleTextureProvider: TextureProvider = {
  async generate(_env, ctx) {
    return `${ctx.activity} (${ctx.room.register})`;
  },
};
