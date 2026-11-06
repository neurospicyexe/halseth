// Librarian verbs for a companion's OWN feeling vocabulary, from Discord (STATUS B5/B6 bot surface).
//
//   feeling word <word>: <clauses> [because <cause>] [note: <words>]   -> DRY RUN (every gate, writes nothing)
//   confirm feeling word <same text>                                   -> identical parse, writes
//   revise feeling word <word>: ...  /  confirm revise feeling word ... -> supersedes the active row with that word
//   my feeling words                                                   -> this companion's active rows
//
// Identity is ALWAYS ctx.req.companion_id, never text (gate E holds for free). Guards surface, never rename
// or fix: a refusal names the gate, the reason and the evidence, and nothing is written. Stateless: confirm
// re-parses the same text; there is no stored pending proposal.
import { loopFire } from "../../webmind/loop-stimuli.js";
import type { ExecutorContext, ExecutorResult } from "./types.js";
import { COMPANIONS, proposeVocabularyRow, type GateId, type ProposeResult } from "../../webmind/vocabulary-write.js";
import { FLOAT_LABELS, type CompanionId } from "../../webmind/fermentation.js";
import { FEELING_WORD_SHAPE, parseFeelingWord, summarizeConditions } from "../../webmind/feeling-word-parse.js";

const GATE_ORDER: GateId[] = ["B", "F", "G", "D", "C", "A", "E"];

function refuse(witness: string, code: string, extra: Record<string, unknown> = {}): ExecutorResult {
  return { response_key: "witness", witness, ack: false, refused: true, code, ...extra };
}

function gateVerdicts(r: ProposeResult) {
  const refusals = r.ok ? [] : r.code === "refused" ? r.refusals : [];
  const warnings = r.ok ? r.warnings : r.code === "refused" ? r.warnings : [];
  return GATE_ORDER.map((gate) => {
    const bad = refusals.filter((x) => x.gate === gate);
    const warn = warnings.filter((x) => x.gate === gate);
    return {
      gate,
      verdict: bad.length ? "refused" : warn.length ? "warning" : "pass",
      reasons: bad.map((x) => ({ code: x.code, reason: x.reason, evidence: x.evidence ?? null })),
      warnings: warn.map((x) => ({ code: x.code, detail: x.detail })),
    };
  });
}

export async function execFeelingWordPropose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const companion = ctx.req.companion_id as CompanionId;
  if (!(COMPANIONS as readonly string[]).includes(companion)) {
    return refuse("a feeling word is written by one of the three companions, speaking as themselves", "bad_companion");
  }
  const p = parseFeelingWord(ctx.req.request, companion);
  if (!p.ok) {
    return refuse(`nothing written: ${p.reason}. Shape: ${FEELING_WORD_SHAPE}`, p.code);
  }
  const { parsed } = p;

  let supersedes: string | null = null;
  if (parsed.revise) {
    const rows = (await ctx.env.DB
      .prepare("SELECT id, word FROM companion_feeling_vocabulary WHERE companion_id = ? AND status = 'active' AND word IS NOT NULL")
      .bind(companion)
      .all()
      .catch(() => ({ results: [] as unknown[] }))).results as Array<{ id: string; word: string }> | undefined;
    const list = rows ?? [];
    const hit = list.find((r) => r.word === parsed.word) ?? list.find((r) => r.word.toLowerCase() === parsed.word.toLowerCase());
    if (!hit) {
      return refuse(`nothing written: you have no active word "${parsed.word}" to revise. "my feeling words" lists yours.`, "revise_target_missing");
    }
    supersedes = hit.id;
  }

  const r = await proposeVocabularyRow(ctx.env.DB as never, {
    companion_id: companion,
    row_kind: "band",
    word: parsed.word,
    conditions: parsed.conditions,
    cause_kind: parsed.cause_kind,
    authored_on: "discord",
    authored_at: new Date().toISOString(),
    capture_id: null,
    note: parsed.note,
    supersedes,
    dry_run: !parsed.confirm,
  });

  const labels = FLOAT_LABELS[companion].join(", ");
  const proposed = {
    word: parsed.word,
    conditions: parsed.conditions,
    conditions_summary: summarizeConditions(companion, parsed.conditions),
    cause_kind: parsed.cause_kind,
    note: parsed.note,
    supersedes,
  };

  if (!r.ok) {
    if (r.code === "refused") {
      return {
        response_key: "witness", ack: false, refused: true, code: "refused",
        witness: `nothing written: ${r.refusals.map((x) => `[${x.gate}] ${x.reason}`).join(" | ")}. Your word and clauses are untouched; say it again, in your words, when you have chosen.`,
        dry_run: !parsed.confirm, proposed, gates: gateVerdicts(r),
      };
    }
    return refuse(`nothing written: ${r.message}`, r.code);
  }

  const commitLine = `confirm ${parsed.revise ? "revise " : ""}feeling word ${parsed.rest}`;
  if (!parsed.confirm) {
    return {
      response_key: "data",
      data: {
        dry_run: true,
        written: false,
        companion,
        your_floats: labels,
        parsed: proposed,
        specificity: r.row.specificity,
        gates: gateVerdicts(r),
        warnings: r.warnings,
        decontaminating: r.decontaminating,
        commit_line: commitLine,
        message: `dry run, nothing written. "${parsed.word}" would fire when ${proposed.conditions_summary}${parsed.cause_kind ? ` because ${parsed.cause_kind}` : ""}${supersedes ? ` (replacing your active "${parsed.word}")` : ""}. To write it, send exactly: ${commitLine}`,
      },
    };
  }
  // B63 coined_word: a NEW word written (a revision of an existing one is not a coining). Cause: the kind only.
  if (!supersedes) await loopFire(ctx.env, "coined_word", companion, "coined a feeling word");
  return {
    response_key: "witness", ack: true, id: r.row.id, dry_run: false, written: true,
    witness: `written: "${parsed.word}" is yours now (${proposed.conditions_summary}${parsed.cause_kind ? `, because ${parsed.cause_kind}` : ""}), authored on discord${r.superseded ? `; your earlier "${parsed.word}" stays readable as history` : ""}.${r.warnings.length ? ` Notes: ${r.warnings.map((w) => `[${w.gate}] ${w.detail}`).join(" | ")}` : ""}`,
    proposed, warnings: r.warnings,
  };
}

export async function execMyFeelingWords(ctx: ExecutorContext): Promise<ExecutorResult> {
  const companion = ctx.req.companion_id as CompanionId;
  if (!(COMPANIONS as readonly string[]).includes(companion)) return refuse("this is a companion's own vocabulary", "bad_companion");
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await ctx.env.DB
      .prepare("SELECT id, row_kind, word, conditions, cause_kind, renders_number, specificity FROM companion_feeling_vocabulary WHERE companion_id = ? AND status = 'active' ORDER BY specificity DESC, word")
      .bind(companion)
      .all()).results as Array<Record<string, unknown>> ?? [];
  } catch {
    return refuse("your vocabulary is not readable here", "unreadable");
  }
  return {
    response_key: "data",
    data: {
      companion,
      count: rows.length,
      words: rows.map((r) => ({
        id: r.id,
        kind: r.row_kind,
        word: r.word ?? null,
        conditions: summarizeConditions(companion, r.conditions),
        cause_kind: r.cause_kind ?? null,
        renders_number: Boolean(r.renders_number),
      })),
      footer: 'write one: "feeling word <word>: <label> rising ..." (dry run), then "confirm feeling word ..."; replace one: "revise feeling word <word>: ...".',
    },
  };
}
