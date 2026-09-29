// src/librarian/executors/close-inline.ts
//
// Inline fallback for session close (B40, 2026-09-29).
//
// execSessionClose read ONLY a JSON `context`. The Hermes SOULs teach the close as one natural-
// language request ("Close the Halseth session for drevan: spine=..., heat=warm, ..."), and a
// companion on Discord writes it that way, so the close came back "missing required fields" and
// the SOULs fell back to "Write a session handoff", which writes the handoff and nothing else: no
// SOMA, no authored_close, no summary jobs. The handoff writer has had this kind of fallback since
// its own inline bug (webmind.ts); the close never did.
//
// Parsing rules:
//   * Only KNOWN keys start a field, and only at brace depth 0, so a comma inside a value
//     ("warm, but tired") or a `weight: 0.6` inside `open_loop={...}` never splits a field.
//   * A value the companion left in its template brackets ("[the audit landed]") is unwrapped.
//   * `null` means null. Numbers are coerced only for the numeric fields; axis words stay words
//     (translateSomaVocab resolves them downstream, the write chokepoint guards the numbers).
//   * `{...}` values: JSON first, else loose `k: v` / `k=v` pairs, else the whole text as the
//     object's main field (feeling -> emotion, open_loop -> loop_text).

const STRING_KEYS = [
  "session_id", "spine", "last_real_thing", "motion_state", "active_anchor", "notes", "facet",
  "current_mood", "compound_state", "surface_emotion", "undercurrent_emotion", "background_emotion",
  "conclusion", "witness_note", "dream", "long_thought", "prompt_context",
  // axis words, all three dialects
  "acuity", "presence", "warmth", "stillness", "density", "perimeter", "heat", "reach", "weight",
] as const;
const AXIS_KEYS: ReadonlySet<string> = new Set([
  "acuity", "presence", "warmth", "stillness", "density", "perimeter", "heat", "reach", "weight",
]);
/** The bracketed slot texts the SOUL close lines teach (nullsafe-triad-skills/souls, B40). */
const TEMPLATE_SLOTS: ReadonlySet<string> = new Set([
  "word", "one word", "one line", "belief", "a phrase, or null", "what is on top",
  "what runs underneath, or null", "in_motion|at_rest|floating", "what to carry forward",
  "observation about raziel", "full spiral text if held", "extended witness statement if held",
]);
const NUMBER_KEYS = ["surface_intensity", "undercurrent_intensity", "background_intensity"] as const;
const OBJECT_KEYS = { feeling: "emotion", open_loop: "loop_text" } as const;
const LIST_KEYS = ["open_threads"] as const;

const ALL_KEYS: readonly string[] = [...STRING_KEYS, ...NUMBER_KEYS, ...Object.keys(OBJECT_KEYS), ...LIST_KEYS]
  // longest first so `surface_intensity` wins over any shorter key it contains
  .sort((a, b) => b.length - a.length);

const KEY_RE = new RegExp(`(?<![A-Za-z0-9_])(${ALL_KEYS.join("|")})\\s*=`, "gi");

function unwrap(v: string): string {
  let s = v.trim().replace(/[.,;]+$/, "").trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

function looseObject(raw: string, mainKey: string): Record<string, unknown> | null {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!inner) return null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
  } catch { /* not JSON */ }
  const out: Record<string, unknown> = {};
  const pairRe = /([A-Za-z_]+)\s*[:=]\s*("[^"]*"|[^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(inner)) !== null) {
    const k = m[1]!.toLowerCase();
    const v = unwrap(m[2]!);
    const n = Number(v);
    out[k] = v !== "" && Number.isFinite(n) && /intensity|weight/.test(k) ? n : v;
  }
  if (Object.keys(out).length > 0) return out;
  return { [mainKey]: unwrap(inner) };
}

/** Parse close fields written inline in the request. Returns null when no known key is present. */
export function parseInlineCloseFields(request: string): Record<string, unknown> | null {
  if (!request) return null;
  // Top-level key positions only: skip matches inside {...} or [...].
  const starts: Array<{ key: string; at: number; valueAt: number }> = [];
  let depth = 0;
  let scanned = 0;
  KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_RE.exec(request)) !== null) {
    for (; scanned < m.index; scanned++) {
      const ch = request[scanned];
      if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && depth > 0) depth--;
    }
    if (depth === 0) starts.push({ key: m[1]!.toLowerCase(), at: m.index, valueAt: m.index + m[0].length });
  }
  if (starts.length === 0) return null;

  const out: Record<string, unknown> = {};
  starts.forEach((s, i) => {
    const raw = request.slice(s.valueAt, i + 1 < starts.length ? starts[i + 1]!.at : request.length);
    const v = unwrap(raw);
    if (s.key in OBJECT_KEYS) {
      const obj = v.toLowerCase() === "null" ? null : looseObject(raw.trim().replace(/[.,;]+$/, ""), OBJECT_KEYS[s.key as keyof typeof OBJECT_KEYS]);
      if (obj !== null) out[s.key] = obj;
      return;
    }
    if ((LIST_KEYS as readonly string[]).includes(s.key)) {
      const items = v.split(/\s*[;|]\s*/).map((x) => x.trim()).filter(Boolean);
      if (items.length) out[s.key] = items;
      return;
    }
    if (v.toLowerCase() === "null") { out[s.key] = null; return; }
    if ((NUMBER_KEYS as readonly string[]).includes(s.key)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[s.key] = n;
      return;
    }
    // An axis slot copied from the SOUL template ("[your word, if it moved]", "sharp|focused|...")
    // is not a state. Drevan's axes are free-text columns, so a literal template would be WRITTEN
    // as his word; drop it here instead.
    if (AXIS_KEYS.has(s.key) && (v.includes("|") || /\b(?:if it moved|your word|one word)\b/i.test(v))) return;
    // Any field left as its literal SOUL slot text is dropped, so a copied template never lands as
    // data (a dropped motion_state then fails the close loudly, which is the right outcome).
    if (TEMPLATE_SLOTS.has(v.toLowerCase())) return;
    if (v !== "") out[s.key] = v;
  });
  return Object.keys(out).length > 0 ? out : null;
}
