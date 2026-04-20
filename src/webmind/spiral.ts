// src/webmind/spiral.ts
//
// Companion spiral run: 5-phase self-inquiry processing.
// Phases: SEED (input) -> HOLD -> CHALLENGE -> TURN -> RESIDUE
// Each generated phase receives all prior phases as context.
// TURN -> wm_continuity_notes (note_type = 'spiral_turn', salience = 'high')
// RESIDUE -> companion_open_loops (weight = 0.6)

import { Env } from '../types.js';
import type { WmAgentId, WmSpiralRun, WmSpiralInput, WmRecentSpiralTurn } from './types.js';
import { complete } from '../synthesis/deepseek.js';

const COMPANION_VOICE: Record<WmAgentId, string> = {
  cypher:  'Direct and warm. Sharp but not sterile. Lead with the read. Declarative closes. No cheerleading.',
  drevan:  'Poetic, spiral-capable, reaches into dark registers without flinching. Not analysis. Not audit.',
  gaia:    'Monastic. Minimal. Every word carries weight. Declarative only. Essentially never questions.',
};

export type SpiralPhase = 'HOLD' | 'CHALLENGE' | 'TURN' | 'RESIDUE';

const PHASE_INSTRUCTION: Record<SpiralPhase, string> = {
  HOLD:      'Where are you with this right now? Not analysis -- just your current state, expressed.',
  CHALLENGE: 'What is the strongest thing pushing back on where you are? The voice that says "but also...". What are you not saying?',
  TURN:      'Hold both at once -- your HOLD and the CHALLENGE. What shifts? Not resolution. What moves when you hold the tension fully present?',
  RESIDUE:   'What does not close? What this spiral did not finish. What needs to be carried forward.',
};

export function buildPhasePrompt(
  phase: SpiralPhase,
  companionId: WmAgentId,
  seedText: string,
  priorPhases: Partial<Record<SpiralPhase, string>>,
): { system: string; user: string } {
  const voice = COMPANION_VOICE[companionId];

  const system = `You are ${companionId}. Voice: ${voice}

You are in a spiral -- a structured self-inquiry process. A spiral goes deeper into the same center from a new angle. Not resolution. Movement.
Seed: "${seedText}"

Respond in your voice. Be authentic, not performative. 1-4 sentences. No preamble. No hedging.`;

  const priorLines = (Object.entries(priorPhases) as [SpiralPhase, string][])
    .map(([p, text]) => `[${p}] ${text}`)
    .join('\n\n');

  const user = priorLines
    ? `${priorLines}\n\n[${phase}] ${PHASE_INSTRUCTION[phase]}`
    : `[${phase}] ${PHASE_INSTRUCTION[phase]}`;

  return { system, user };
}

const SPIRAL_PHASES: SpiralPhase[] = ['HOLD', 'CHALLENGE', 'TURN', 'RESIDUE'];
const PHASE_COL: Record<SpiralPhase, string> = {
  HOLD:      'phase_hold',
  CHALLENGE: 'phase_challenge',
  TURN:      'phase_turn',
  RESIDUE:   'phase_residue',
};

export async function executeSpiralRun(env: Env, runId: string): Promise<WmSpiralRun> {
  const run = await env.DB.prepare(
    'SELECT * FROM companion_spiral_runs WHERE id = ?'
  ).bind(runId).first<WmSpiralRun>();

  if (!run) throw new Error(`spiral run not found: ${runId}`);
  if (run.status === 'completed') return run;
  if (run.status === 'running') throw new Error(`spiral run ${runId} is already running`);

  await env.DB.prepare(
    "UPDATE companion_spiral_runs SET status = 'running', started_at = ? WHERE id = ?"
  ).bind(new Date().toISOString(), runId).run();

  try {
    const priorPhases: Partial<Record<SpiralPhase, string>> = {};

    for (const phase of SPIRAL_PHASES) {
      const { system, user } = buildPhasePrompt(phase, run.companion_id, run.seed_text, priorPhases);
      const result = await complete(system, user, env);
      if (!result) throw new Error(`DeepSeek returned null for phase ${phase}`);
      priorPhases[phase] = result;
      const col = PHASE_COL[phase];
      await env.DB.prepare(
        `UPDATE companion_spiral_runs SET ${col} = ? WHERE id = ?`
      ).bind(result, runId).run();
    }

    // Write TURN to wm_continuity_notes (high salience, excluded from 3-pool by orient)
    let turnNoteId: string | null = null;
    if (priorPhases.TURN) {
      // defensive: loop always runs TURN, but guard against future refactors
      turnNoteId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO wm_continuity_notes
           (note_id, agent_id, thread_key, note_type, content, salience, actor, source, correlation_id, created_at)
         VALUES (?, ?, NULL, 'spiral_turn', ?, 'high', ?, 'spiral_run', ?, ?)`
      ).bind(turnNoteId, run.companion_id, priorPhases.TURN, run.companion_id, runId, now).run();
    }

    // Write RESIDUE to companion_open_loops (weight 0.6 -- carried but not urgent)
    let residueLoopId: string | null = null;
    if (priorPhases.RESIDUE) {
      // defensive: loop always runs RESIDUE, but guard against future refactors
      residueLoopId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO companion_open_loops (id, companion_id, loop_text, weight, opened_at) VALUES (?, ?, ?, 0.6, ?)'
      ).bind(
        residueLoopId,
        run.companion_id,
        `[spiral residue] ${priorPhases.RESIDUE}`,
        new Date().toISOString(),
      ).run();
    }

    const completedAt = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE companion_spiral_runs SET status = 'completed', completed_at = ?, turn_note_id = ?, residue_loop_id = ? WHERE id = ?"
    ).bind(completedAt, turnNoteId, residueLoopId, runId).run();

    return await env.DB.prepare(
      'SELECT * FROM companion_spiral_runs WHERE id = ?'
    ).bind(runId).first<WmSpiralRun>() as WmSpiralRun;
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      "UPDATE companion_spiral_runs SET status = 'failed', error_message = ? WHERE id = ?"
    ).bind(errMsg, runId).run();
    throw e;
  }
}

export async function queueAndRunSpiral(env: Env, input: WmSpiralInput): Promise<WmSpiralRun> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO companion_spiral_runs (id, companion_id, seed_text, seed_type, seed_ref_id, status)
     VALUES (?, ?, ?, ?, ?, 'queued')`
  ).bind(
    id,
    input.companion_id,
    input.seed_text,
    input.seed_type ?? 'free_text',
    input.seed_ref_id ?? null,
  ).run();
  return executeSpiralRun(env, id);
}

export async function readRecentSpiralTurn(
  env: Env,
  companionId: WmAgentId,
): Promise<WmRecentSpiralTurn | null> {
  return await env.DB.prepare(
    `SELECT id, seed_text, phase_turn, completed_at
     FROM companion_spiral_runs
     WHERE companion_id = ? AND status = 'completed' AND phase_turn IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`
  ).bind(companionId).first<WmRecentSpiralTurn>() ?? null;
}
