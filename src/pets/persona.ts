// B64 Sol mind: the per-pet part (spec 5.6). A second pet is a new creatures row + a persona row, no new code.
// Parsing never throws: malformed JSON reads as empty vocab / no sample lines. No row = null, and the voice
// then keeps the deterministic line and writes nothing.
import { SELECT_PERSONA } from "./sql.js";

export interface PersonaBody { perches: string[]; objects: string[]; sounds: string[] }

export interface PersonaRow {
  creature_id: string;
  species: string | null;
  body: PersonaBody;
  voice_rules: string | null;
  sample_lines: string[];
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

function parse(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function parsePersonaBody(raw: unknown): PersonaBody {
  const o = parse(raw);
  const b = o && typeof o === "object" && !Array.isArray(o) ? o as Record<string, unknown> : {};
  return { perches: strings(b["perches"]), objects: strings(b["objects"]), sounds: strings(b["sounds"]) };
}

export async function loadPersona(db: D1Database, creatureId: string): Promise<PersonaRow | null> {
  const r = await db.prepare(SELECT_PERSONA).bind(creatureId).first<{
    creature_id: string; species: string | null; body_json: string | null; voice_rules: string | null; sample_lines: string | null;
  }>();
  if (!r) return null;
  return {
    creature_id: r.creature_id,
    species: r.species ?? null,
    body: parsePersonaBody(r.body_json),
    voice_rules: r.voice_rules ?? null,
    sample_lines: strings(parse(r.sample_lines)),
  };
}
