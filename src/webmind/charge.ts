// src/webmind/charge.ts
//
// Charge-phase memory lifecycle (muse-brain; inspo-takes-2026-06-13 take 2).
// A memory "earns depth through attention": it metabolizes along a fixed ladder
// as the system intentionally engages it. Phase is stored on growth_journal and
// advanced at the ratification chokepoint -- never auto-decays, never regresses.
//
//   fresh -> active -> processing -> metabolized
//
// Signals:
//   surfaced       passive recall -- nudges fresh -> active only (no deeper).
//   ratified       human-present accept -- advances exactly one step.
//   reconsolidated an accepted entry that supersedes another -- a burning paradox;
//                  jumps to at least 'processing' (it has been actively reworked).

export const CHARGE_PHASES = ["fresh", "active", "processing", "metabolized"] as const;
export type ChargePhase = (typeof CHARGE_PHASES)[number];

export type ChargeSignal = "surfaced" | "ratified" | "reconsolidated";

function indexOfPhase(phase: string): number {
  const i = (CHARGE_PHASES as readonly string[]).indexOf(phase);
  return i < 0 ? 0 : i; // unknown/null -> treat as fresh
}

/** Compute the next phase for a signal. Monotonic: never regresses below current. */
export function nextPhase(current: ChargePhase | string | null | undefined, signal: ChargeSignal): ChargePhase {
  const idx = indexOfPhase(current ?? "fresh");
  const last = CHARGE_PHASES.length - 1;
  switch (signal) {
    case "surfaced":
      return idx < 1 ? "active" : CHARGE_PHASES[idx]!;
    case "ratified":
      return CHARGE_PHASES[Math.min(idx + 1, last)]!;
    case "reconsolidated":
      return CHARGE_PHASES[Math.max(idx, indexOfPhase("processing"))]!;
  }
}

/** True when the signal would actually move the phase (so callers skip a no-op UPDATE). */
export function phaseAdvances(current: ChargePhase | string | null | undefined, signal: ChargeSignal): boolean {
  return nextPhase(current, signal) !== (current ?? "fresh");
}

/** UPDATE template that sets charge_phase + stamps charge_advanced_at. Bind: [phase, id]. */
export function advanceChargeSql(): string {
  return `UPDATE growth_journal SET charge_phase = ?, charge_advanced_at = datetime('now') WHERE id = ?`;
}
