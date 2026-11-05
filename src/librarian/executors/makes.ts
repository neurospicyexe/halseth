// Librarian executors for making (B62, mig 0164; logic in webmind/makes.ts, store in handlers/makes.ts).
//
//   "make a <kind words> called <title> [for <interest>] because <why>"   create (because optional)
//   "my makes"                                                              the caller's own shelf
//
// Kind words: drawing/svg -> drawing; scad/3d print/3d model/model -> scad; song/track/music ->
// music_audio; strudel/beat/pattern -> music_code; page/website/toy -> page; poem/story/writing ->
// writing; video/clip -> video. The CONTENT rides in context: { source } for writing, page, music_code,
// drawing and scad; { prompt, lyrics?, duration?, instrumental? } for music_audio; { prompt, aspect? }
// for video. Optional context { title, why, why_private, interest, kind, parent_id } fill what the
// sentence leaves out. The companion is ALWAYS ctx.req.companion_id, never text.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { parseMakeVerb, MAKE_KINDS, SOURCE_KINDS, type MakeKind } from "../../webmind/makes.js";
import { createMake, listMakes } from "../../handlers/makes.js";
import { findInterestByName } from "../../handlers/interests.js";
import { parseKeepVerb, keepAsMade, resolveKeepInterest, KEEP_TEACH } from "../../webmind/makes-capture.js";

interface Ctx {
  source?: string; prompt?: string; lyrics?: string; duration?: number; instrumental?: boolean; aspect?: string;
  title?: string; why?: string; why_private?: boolean; interest?: string; kind?: string; parent_id?: string;
}

const TEACH = "make a <kind> called <title> [for <interest>] because <why>, with the content in context";

function fail(witness: string, code: string): ExecutorResult {
  return { response_key: "witness", witness, ack: false, refused: true, code };
}

export async function execMake(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<Ctx>(ctx.req.context) ?? {};
  const p = parseMakeVerb(ctx.req.request);
  const kind: string | null = p?.kind ?? (c.kind && (MAKE_KINDS as readonly string[]).includes(c.kind) ? (c.kind as MakeKind) : null);
  if (!kind) return fail(`say what you are making. Say: ${TEACH}`, "bad_input");

  // "for <x>": it names an interest only when it resolves to one of THIS companion's active ones;
  // otherwise it was part of the title ("a song for rainy days").
  let title = (c.title ?? "").trim();
  let interestName: string | null = (c.interest ?? "").trim() || null;
  if (!title && p) {
    title = p.title_full;
    if (!interestName && p.interest_candidate && p.title_before_for) {
      const hit = await findInterestByName(ctx.env, ctx.req.companion_id, p.interest_candidate);
      if (hit && hit.status === "active") { title = p.title_before_for; interestName = hit.name; }
    }
  }
  if (!title) return fail(`no title. Say: ${TEACH}`, "bad_input");

  const why = (c.why ?? p?.why ?? "").trim();
  const params = kind === "music_audio"
    ? { prompt: c.prompt, lyrics: c.lyrics, duration: c.duration, instrumental: c.instrumental }
    : kind === "video" ? { prompt: c.prompt, aspect: c.aspect } : undefined;
  const r = await createMake(ctx.env, {
    companion_id: ctx.req.companion_id, kind, title, why: why || null,
    why_private: c.why_private ?? p?.why_private ?? false,
    interest_name: interestName, source: SOURCE_KINDS.has(kind) ? (c.source ?? null) : null,
    params, parent_id: c.parent_id ?? null,
  });
  if (!r.ok) {
    if (r.code === "gaia_keeps_lines") return fail("you keep lines, not artifacts; that was your word. Nothing was made.", r.code);
    return fail(`${r.message}${r.code === "bad_input" ? `. Say: ${TEACH}` : ""}`, r.code);
  }
  const next = r.status === "pending" ? " It is being made; the shelf shows it when it is ready." : " It is on your shelf.";
  const forLine = r.interest ? ` for ${r.interest}` : "";
  return {
    response_key: "witness", ack: true, id: r.id, status: r.status, kind, title,
    witness: `made: ${title} (${kind})${forLine}.${next}`,
  };
}

export async function execMakesRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const list = await listMakes(ctx.env, ctx.req.companion_id, { limit: 20, revealPrivate: true });
  return {
    response_key: "data",
    data: {
      makes: list.map((m) => ({
        id: m.id, kind: m.kind, title: m.title, status: m.status, version: m.version,
        why: m.why, heard_back: m.heard_back, interest: m.interest_name, created_at: m.created_at,
      })),
      footer: `make: "${TEACH}"`,
    },
  };
}

/**
 * "keep as made <id | "opening words"> [called <title>] [for <interest>] [because <why>]" / "keep this as made"
 * (context { ref } names the id or quoted words for "this"). The companion is ALWAYS ctx.req.companion_id and
 * only that companion's OWN rows are reachable; several matches return candidates (table, id prefix, date; no text).
 */
export async function execMakeKeep(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<{ ref?: string; title?: string; interest?: string; why?: string }>(ctx.req.context) ?? {};
  const p = parseKeepVerb(ctx.req.request);
  if (!p) return fail(`say: ${KEEP_TEACH}`, "bad_input");
  let ref = p.ref;
  if (ref.kind === "this" && typeof c.ref === "string" && c.ref.trim()) {
    const r = c.ref.trim();
    const q = /^["“]([^"”]+)["”]$/.exec(r);
    ref = q ? { kind: "words", words: q[1]! } : { kind: "id", id: r.toLowerCase() };
  }
  const { title, interest } = await resolveKeepInterest(ctx.env, ctx.req.companion_id, p);
  const r = await keepAsMade(ctx.env, {
    companion_id: ctx.req.companion_id, ref, title: (c.title ?? title ?? "").trim() || null,
    interest_name: (c.interest ?? interest ?? "").trim() || null, why: (c.why ?? p.why ?? "").trim() || null,
  });
  if (!r.ok) {
    const cands = r.candidates?.length ? ` Candidates: ${r.candidates.join("; ")}.` : "";
    return { ...fail(`${r.message}${cands}`, r.code), ...(r.candidates ? { candidates: r.candidates } : {}) };
  }
  return {
    response_key: "witness", ack: true, id: r.id, title: r.title, existed: r.outcome === "exists",
    witness: r.outcome === "exists" ? `already on your shelf: ${r.title} (make ${r.id}).` : `kept as made: ${r.title} (make ${r.id}). It is on your shelf.`,
  };
}
