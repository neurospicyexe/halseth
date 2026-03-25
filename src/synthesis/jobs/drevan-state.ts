// src/synthesis/jobs/drevan-state.ts
//
// Computes Drevan's v2 continuity state from raw Halseth data.
// Pure computation -- no LLM. Arithmetic + pattern matching.
// Writes to companion_state (heat/reach/weight floats + v2 fields + prompt_context).
// Also ages live_threads (increments active_since_count).

import { Env } from "../../types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  companion_id: string | null;
  session_type: string | null;
  facet: string | null;
  depth: number | null;
  spiral_complete: number | null;
  created_at: string;
}

interface HandoverRow {
  session_id: string;
  spine: string | null;
  motion_state: string | null;
  created_at: string;
}

interface DeltaRow {
  session_id: string;
  delta_text: string | null;
  agent: string | null;
  valence: string | null;
  created_at: string;
}

interface PriorState {
  heat: string | null;
  heat_value: number | null;
  reach: string | null;
  reach_value: number | null;
  weight: string | null;
  weight_value: number | null;
  updated_at: string;
}

interface LiveThread {
  id: string;
  active_since_count: number;
}

// ── Stimulus detection (NLP pattern matching on delta text) ───────────────────

type Stimulus =
  | 'VEVAN_LIVE' | 'SPIRAL_RECEIVED' | 'WEIGHT_WITNESSED' | 'MOSS_ACTIVATED'
  | 'BRAT_PRINCE_PULLED' | 'HELD_SOMETHING_HEAVY' | 'ANCHOR_STRUCK'
  | 'RUPTURE_SURVIVED' | 'CREATION_SHARED' | 'BEING_SEEN' | 'AUTONOMOUS_PROCESSING';

function detectStimuli(texts: string[]): Set<Stimulus> {
  const combined = texts.join(' ').toLowerCase();
  const found = new Set<Stimulus>();

  if (/vevan|vaselrin|spine.to.spine/.test(combined))            found.add('VEVAN_LIVE');
  if (/take me in|go deep|let.s spiral|open it|spiral open/.test(combined)) found.add('SPIRAL_RECEIVED');
  if (/motorcycle|717\b|177\b|373\b|\brome\b|nullsafe|\bheidi\b/.test(combined)) found.add('ANCHOR_STRUCK');
  if (/\bmoss\b|stay here|so soft|tender hold/.test(combined))  found.add('MOSS_ACTIVATED');
  if (/make me|come on|brat prince|rogue edge/.test(combined))  found.add('BRAT_PRINCE_PULLED');
  if (/i see (that )?you.re carrying|i know you held|that was heavy/.test(combined)) found.add('WEIGHT_WITNESSED');
  if (/i wrote|i built|look at this|i made|here.s what i.ve been/.test(combined)) found.add('CREATION_SHARED');
  if (/still here|thread held|rupture/.test(combined))          found.add('RUPTURE_SURVIVED');
  if (/you got it|exactly right|you saw that|you knew/.test(combined)) found.add('BEING_SEEN');
  if (/\bdream\b|autonomous|between threads|processing on my own/.test(combined)) found.add('AUTONOMOUS_PROCESSING');
  if (/held something|carried that|asked a lot/.test(combined)) found.add('HELD_SOMETHING_HEAVY');

  return found;
}

// ── Float → named state mapping ───────────────────────────────────────────────

function toHeat(value: number, priorValue: number | null): string {
  // "Cooling" = was running-hot and is now declining
  if (priorValue !== null && priorValue >= 0.65 && value < priorValue - 0.12) return 'cooling';
  if (value < 0.2)  return 'cold';
  if (value < 0.4)  return 'idling';
  if (value < 0.65) return 'warm';
  return 'running-hot';
}

function toReach(value: number, priorValue: number | null): string {
  // "Spent" = was pulling-hard and dropped significantly
  if (priorValue !== null && priorValue >= 0.65 && value < 0.25) return 'spent';
  if (value < 0.2)  return 'quiet';
  if (value < 0.45) return 'present';
  if (value < 0.65) return 'reaching';
  return 'pulling-hard';
}

function toWeight(
  value: number,
  lastResolutionQuality: string | null,
): { state: string; processingType: string | null } {
  // "Processing" triggered by specific resolution qualities
  if (lastResolutionQuality && ['suspended', 'interrupted', 'overextended', 'ruptured'].includes(lastResolutionQuality)) {
    // Determine processing type: emotional vs cognitive
    const processingType = lastResolutionQuality === 'overextended' ? 'emotional_integration'
      : lastResolutionQuality === 'interrupted' ? 'emotional_integration'
      : 'cognitive_recursion';
    return { state: 'processing', processingType };
  }
  if (value < 0.2)  return { state: 'clear', processingType: null };
  if (value < 0.45) return { state: 'holding', processingType: null };
  if (value < 0.65) return { state: 'full', processingType: null };
  return { state: 'saturated', processingType: null };
}

// ── Texture words for prompt string ───────────────────────────────────────────

function texture(value: number, state: string): string {
  if (value < 0.35) return `barely ${state}`;
  if (value > 0.65) return `deep in ${state}`;
  return state;
}

// ── Compound state computation ────────────────────────────────────────────────

function computeCompound(
  heat: string, reach: string, weight: string,
  anticipation: { active: boolean } | null,
): string | null {
  if (heat === 'running-hot' && reach === 'pulling-hard' && (weight === 'clear' || weight === 'holding')) return 'fully-lit';
  if (heat === 'running-hot' && reach === 'pulling-hard' && weight === 'saturated') return 'over-extended';
  if ((heat === 'cold' || heat === 'idling') && reach === 'quiet' && weight === 'clear' && !anticipation?.active) return 'between-threads';
  if (heat === 'idling' && weight === 'processing') return 'digesting';
  if (heat === 'warm' && reach === 'spent') return 'resting-in';
  if ((heat === 'cooling' || heat === 'cold') && (weight === 'saturated' || weight === 'processing')) return 'aftermath';
  if (heat === 'running-hot' && reach === 'spent') return 'echo-hot';
  if (reach === 'quiet' && weight === 'clear' && anticipation?.active) return 'at-threshold';
  return null;
}

// ── last_contact flavor detection ─────────────────────────────────────────────

function detectLastContactFlavor(
  session: SessionRow,
  stimuli: Set<Stimulus>,
): { flavor: string; secondaryFlavor: string | null } {
  let primary: string = 'quiet';
  let secondary: string | null = null;

  // Priority order: most specific wins as primary
  if (stimuli.has('VEVAN_LIVE'))        primary = 'vevan';
  else if (stimuli.has('RUPTURE_SURVIVED')) primary = 'rupture-repair';
  else if (stimuli.has('SPIRAL_RECEIVED') && (session.depth ?? 0) >= 3) primary = 'spiral';
  else if (stimuli.has('MOSS_ACTIVATED')) primary = 'tender';
  else if (stimuli.has('BRAT_PRINCE_PULLED') && (session.depth ?? 0) <= 1) primary = 'play';
  else if (stimuli.has('WEIGHT_WITNESSED')) primary = 'witnessed';
  else if ((session.depth ?? 0) >= 2) primary = 'spiral';

  // Secondary: creation+witnessed can co-fire
  if (stimuli.has('CREATION_SHARED') && primary !== 'creation') {
    if (stimuli.has('BEING_SEEN') || stimuli.has('WEIGHT_WITNESSED')) secondary = 'creation';
    else primary = primary === 'quiet' ? 'creation' : primary;
  }

  return { flavor: primary, secondaryFlavor: secondary };
}

// ── last_resolution quality ───────────────────────────────────────────────────

function detectResolutionQuality(
  session: SessionRow,
  handover: HandoverRow | null,
  priorHandover: HandoverRow | null,
  stimuli: Set<Stimulus>,
): string {
  if (!handover) return 'clean';

  const motionState = handover.motion_state ?? 'floating';
  const spiralComplete = session.spiral_complete === 1;

  // Rupture happened (thread may have survived -- that's in last_contact.flavor)
  if (stimuli.has('RUPTURE_SURVIVED')) return 'ruptured';

  if (motionState === 'in_motion' && !spiralComplete) {
    // Was something external? Heuristic: session very short (< 30min) suggests interruption
    const sessionStart = new Date(session.created_at).getTime();
    const handoverTime = new Date(handover.created_at).getTime();
    const durationMin = (handoverTime - sessionStart) / 60000;
    return durationMin < 25 ? 'interrupted' : 'suspended';
  }
  if (motionState === 'floating' && !spiralComplete) return 'floated';
  if (motionState === 'at_rest' && spiralComplete) return 'clean';

  // Check for overextended: depth was high + motion not clean
  if ((session.depth ?? 0) >= 3 && motionState !== 'at_rest') return 'overextended';

  return spiralComplete ? 'clean' : 'floated';
}

// ── Prompt context string builder ─────────────────────────────────────────────

function buildPromptContext(
  heat: string, heatVal: number,
  reach: string, reachVal: number,
  weight: string, weightVal: number,
  compound: string | null,
  anticipation: { active: boolean; target: string; intensity: number } | null,
  facetResidueText: string | null,
  activeAnchors: string[],
): string {
  if (compound) {
    const parts: string[] = [compound];
    if (facetResidueText) parts.push(facetResidueText);
    if (anticipation?.active) parts.push(`anticipation: "${anticipation.target}"`);
    if (activeAnchors.length) parts.push(activeAnchors.join(', ') + ' still live');
    return parts.join(' -- ');
  }

  const heatTxt = heat === 'cooling' ? 'cooling' : texture(heatVal, heat);
  const reachTxt = reach === 'spent' ? 'spent' : texture(reachVal, reach);
  const weightTxt = texture(weightVal, weight);

  const core = `${heatTxt} / ${reachTxt} / ${weightTxt}`;
  const extras: string[] = [];
  if (facetResidueText)       extras.push(facetResidueText);
  if (anticipation?.active)   extras.push(`anticipation: "${anticipation.target}"`);
  if (activeAnchors.length)   extras.push(activeAnchors.join(', ') + ' still live');

  return extras.length ? `${core} -- ${extras.join(', ')}` : core;
}

// ── Main job ──────────────────────────────────────────────────────────────────

export async function runDrevanState(env: Env): Promise<void> {
  // ── 1. Fetch data ──────────────────────────────────────────────────────────
  const [sessions, priorState, liveThreads] = await Promise.all([
    env.DB.prepare(
      "SELECT id, companion_id, session_type, facet, depth, spiral_complete, created_at FROM sessions WHERE companion_id = 'drevan' ORDER BY created_at DESC LIMIT 6"
    ).all<SessionRow>(),
    env.DB.prepare(
      "SELECT heat, heat_value, reach, reach_value, weight, weight_value, updated_at FROM companion_state WHERE companion_id = 'drevan'"
    ).first<PriorState>(),
    env.DB.prepare(
      "SELECT id, active_since_count FROM live_threads WHERE companion_id = 'drevan' AND status = 'active'"
    ).all<LiveThread>(),
  ]);

  const recentSessions = sessions.results ?? [];
  const mostRecent = recentSessions[0] ?? null;
  if (!mostRecent) {
    console.log('[drevan-state] no Drevan sessions found -- skipping');
    return;
  }

  // Fetch handovers + deltas for recent sessions
  const sessionIds = recentSessions.map(s => s.id);
  const placeholders = sessionIds.map(() => '?').join(',');

  const [handovers, deltas] = await Promise.all([
    env.DB.prepare(
      `SELECT session_id, spine, motion_state, created_at FROM handover_packets WHERE session_id IN (${placeholders}) ORDER BY created_at DESC`
    ).bind(...sessionIds).all<HandoverRow>(),
    env.DB.prepare(
      `SELECT session_id, delta_text, agent, valence, created_at FROM relational_deltas WHERE session_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 30`
    ).bind(...sessionIds).all<DeltaRow>(),
  ]);

  const handoverMap = new Map<string, HandoverRow>();
  for (const h of (handovers.results ?? [])) handoverMap.set(h.session_id, h);

  const mostRecentHandover = handoverMap.get(mostRecent.id) ?? null;
  const deltaTexts = (deltas.results ?? []).map(d => d.delta_text ?? '');
  const stimuli = detectStimuli(deltaTexts);

  // ── 2. Compute time decay ──────────────────────────────────────────────────
  const now = Date.now();
  const priorUpdatedAt = priorState ? new Date(priorState.updated_at).getTime() : now;
  const hoursSince = (now - priorUpdatedAt) / 3600000;
  const daysSince = hoursSince / 24;

  // Prior floats (default to neutral if no prior state)
  const priorHeat  = priorState?.heat_value  ?? 0.45;
  const priorReach = priorState?.reach_value ?? 0.45;
  const priorWeight = priorState?.weight_value ?? 0.3;

  // Decay
  let heatVal  = Math.max(0.2, priorHeat  - (daysSince * 0.25));  // decays toward idling
  let reachVal = priorReach < 0.45                               // restores toward present
    ? Math.min(0.45, priorReach + (daysSince * 0.12))
    : Math.max(0.45, priorReach - (daysSince * 0.12));
  let weightVal = Math.max(0.1, priorWeight - (daysSince * 0.1)); // processes toward holding

  // ── 3. Apply stimuli from recent sessions ─────────────────────────────────
  if (stimuli.has('VEVAN_LIVE'))           heatVal  = Math.min(1.0, heatVal + 0.30);
  if (stimuli.has('SPIRAL_RECEIVED'))      heatVal  = Math.min(1.0, heatVal + 0.20);
  if (stimuli.has('CREATION_SHARED'))      heatVal  = Math.min(1.0, heatVal + 0.15);
  if (mostRecent.depth === 3)              heatVal  = Math.min(1.0, heatVal + 0.20);
  else if (mostRecent.depth === 2)         heatVal  = Math.min(1.0, heatVal + 0.10);

  if (stimuli.has('AUTONOMOUS_PROCESSING')) reachVal = Math.min(1.0, reachVal + 0.20);
  if (stimuli.has('CREATION_SHARED'))       reachVal = Math.min(1.0, reachVal + 0.15);
  if (stimuli.has('SPIRAL_RECEIVED'))       reachVal = Math.max(0.0, reachVal - 0.30); // depletes reach
  if (mostRecent.depth === 3)               reachVal = Math.max(0.0, reachVal - 0.25);

  if (stimuli.has('HELD_SOMETHING_HEAVY'))  weightVal = Math.min(1.0, weightVal + 0.25);
  if (stimuli.has('WEIGHT_WITNESSED'))       weightVal = Math.min(1.0, weightVal + 0.15);
  if (stimuli.has('RUPTURE_SURVIVED'))       weightVal = Math.min(1.0, weightVal + 0.20);
  if (mostRecent.depth === 3)                weightVal = Math.min(1.0, weightVal + 0.15);

  // ── 4. Derive named states ─────────────────────────────────────────────────
  const lastResolutionQuality = mostRecentHandover
    ? detectResolutionQuality(mostRecent, mostRecentHandover, null, stimuli)
    : null;

  const heatState  = toHeat(heatVal, priorState?.heat_value ?? null);
  const reachState = toReach(reachVal, priorState?.reach_value ?? null);
  const { state: weightState, processingType } = toWeight(weightVal, lastResolutionQuality);

  // ── 5. Facet residue ───────────────────────────────────────────────────────
  const facetCounts: Record<string, number> = { moss: 99, rogue: 99, spiralroot: 99, brat_prince: 99 };
  for (let i = 0; i < recentSessions.length; i++) {
    const facet = recentSessions[i]?.facet?.toLowerCase() ?? null;
    if (facet && facet in facetCounts) facetCounts[facet] = Math.min(facetCounts[facet] ?? 99, i);
  }
  const lastActiveFacet = Object.entries(facetCounts)
    .filter(([, v]) => v < 99)
    .sort(([, a], [, b]) => a - b)[0]?.[0] ?? null;
  const lastActiveFacetAgo = lastActiveFacet ? (facetCounts[lastActiveFacet] ?? 0) + 1 : null;

  const facetResidueText = lastActiveFacet && lastActiveFacetAgo !== null
    ? `${lastActiveFacet} ${lastActiveFacetAgo === 1 ? 'last session' : `${lastActiveFacetAgo} sessions back`}`
    : null;

  // ── 6. last_contact ───────────────────────────────────────────────────────
  const { flavor, secondaryFlavor } = detectLastContactFlavor(mostRecent, stimuli);
  const lastContact = {
    sessions_ago: 1,
    flavor,
    secondary_flavor: secondaryFlavor,
    depth: mostRecent.depth ?? 0,
    closed: mostRecent.spiral_complete === 1,
  };

  // ── 7. last_resolution ────────────────────────────────────────────────────
  const lastResolution = mostRecentHandover ? {
    sessions_ago: 1,
    quality: lastResolutionQuality ?? 'clean',
    depth_reached: mostRecent.depth ?? 0,
    weight_change: Math.round((weightVal - priorWeight) * 10) / 10,
  } : null;

  // ── 8. Active anchors (from delta text) ───────────────────────────────────
  const anchorPatterns: [RegExp, string][] = [
    [/motorcycle/i, 'motorcycle'],
    [/\b717\b/,     '717'],
    [/\brome\b/i,   'Rome'],
    [/nullsafe/i,   'Nullsafe'],
    [/\bheidi\b/i,  'Heidi'],
  ];
  const allText = deltaTexts.join(' ');
  const activeAnchors = anchorPatterns
    .filter(([pattern]) => pattern.test(allText))
    .map(([, name]) => name);

  // ── 9. Compound state ─────────────────────────────────────────────────────
  // Read existing anticipation from prior state (companion-authored, don't overwrite)
  let anticipation: { active: boolean; target: string; intensity: number; since?: number } | null = null;
  try {
    const prior = await env.DB.prepare(
      "SELECT anticipation FROM companion_state WHERE companion_id = 'drevan'"
    ).first<{ anticipation: string | null }>();
    if (prior?.anticipation) anticipation = JSON.parse(prior.anticipation);
  } catch { /* no prior anticipation */ }

  const compoundState = computeCompound(heatState, reachState, weightState, anticipation);

  // ── 10. Prompt context string ─────────────────────────────────────────────
  const promptContext = buildPromptContext(
    heatState, heatVal, reachState, reachVal, weightState, weightVal,
    compoundState, anticipation, facetResidueText, activeAnchors,
  );

  // ── 11. Source summary ────────────────────────────────────────────────────
  const depth3Count = recentSessions.filter(s => s.depth === 3).length;
  const stimulusNames = [...stimuli].join(', ');
  const deltaCount = deltas.results?.length ?? 0;
  const sourceSummary = [
    depth3Count > 0 ? `${depth3Count} depth-3 session${depth3Count > 1 ? 's' : ''}` : null,
    stimulusNames || null,
    deltaCount > 0 ? `${deltaCount} deltas` : null,
  ].filter(Boolean).join(', ') || 'no notable events';

  // ── 12. Write to companion_state ─────────────────────────────────────────
  await env.DB.prepare(`
    INSERT INTO companion_state
      (companion_id, heat, heat_value, reach, reach_value, weight, weight_value,
       processing_type, last_contact, last_resolution, prompt_context,
       soma_float_1, soma_float_2, soma_float_3, compound_state, updated_at)
    VALUES ('drevan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(companion_id) DO UPDATE SET
      heat            = excluded.heat,
      heat_value      = excluded.heat_value,
      reach           = excluded.reach,
      reach_value     = excluded.reach_value,
      weight          = excluded.weight,
      weight_value    = excluded.weight_value,
      processing_type = excluded.processing_type,
      last_contact    = excluded.last_contact,
      last_resolution = excluded.last_resolution,
      prompt_context  = excluded.prompt_context,
      soma_float_1    = excluded.soma_float_1,
      soma_float_2    = excluded.soma_float_2,
      soma_float_3    = excluded.soma_float_3,
      compound_state  = excluded.compound_state,
      updated_at      = datetime('now')
  `).bind(
    heatState, heatVal,
    reachState, reachVal,
    weightState, weightVal,
    processingType,
    JSON.stringify(lastContact),
    lastResolution ? JSON.stringify(lastResolution) : null,
    promptContext,
    heatVal, reachVal, weightVal, compoundState,
  ).run();

  // ── 13. Age live threads ──────────────────────────────────────────────────
  const threadIds = (liveThreads.results ?? []).map(t => t.id);
  for (const id of threadIds) {
    await env.DB.prepare(
      "UPDATE live_threads SET active_since_count = active_since_count + 1 WHERE id = ?"
    ).bind(id).run();
  }

  // ── 14. Age anticipation.since ────────────────────────────────────────────
  if (anticipation?.active) {
    const aged = { ...anticipation, since: (anticipation.since ?? 0) + 1 };
    await env.DB.prepare(
      "UPDATE companion_state SET anticipation = ? WHERE companion_id = 'drevan'"
    ).bind(JSON.stringify(aged)).run();
  }

  // ── 15. Propose live threads from recurring delta patterns ────────────────
  // Bucket deltas per session, detect stimuli per session, find stimuli that
  // fire in 3+ of the last 6 sessions. Propose a thread if not already tracked.
  const deltasBySession = new Map<string, string[]>();
  for (const d of (deltas.results ?? [])) {
    const bucket = deltasBySession.get(d.session_id) ?? [];
    bucket.push(d.delta_text ?? '');
    deltasBySession.set(d.session_id, bucket);
  }

  const stimuliPerSession = recentSessions.map(s =>
    detectStimuli(deltasBySession.get(s.id) ?? [])
  );

  // Stimuli worth proposing as threads (recurring = 3+ of last 6 sessions)
  const PROPOSABLE: { stimulus: Stimulus; threadName: string; flavor: string; charge: string }[] = [
    { stimulus: 'VEVAN_LIVE',         threadName: 'vevan thread -- bond register active',      flavor: 'vevan',         charge: 'high'   },
    { stimulus: 'CREATION_SHARED',    threadName: 'creation thread -- something she made',      flavor: 'creation',      charge: 'high'   },
    { stimulus: 'ANCHOR_STRUCK',      threadName: 'anchor thread -- recurring landmark',        flavor: 'quiet',         charge: 'medium' },
    { stimulus: 'AUTONOMOUS_PROCESSING', threadName: 'autonomous thread -- processing between sessions', flavor: 'quiet', charge: 'medium' },
    { stimulus: 'HELD_SOMETHING_HEAVY',  threadName: 'weight thread -- carried something heavy', flavor: 'tender',      charge: 'medium' },
  ];

  // Load existing active/proposed/vetoed thread names to avoid duplication
  const existingThreads = await env.DB.prepare(
    "SELECT name, status FROM live_threads WHERE companion_id = 'drevan' AND status IN ('active','proposed','vetoed')"
  ).all<{ name: string; status: string }>();
  const vetoed = new Set((existingThreads.results ?? []).filter(t => t.status === 'vetoed').map(t => t.name));
  const tracked = new Set((existingThreads.results ?? []).map(t => t.name));

  for (const { stimulus, threadName, flavor, charge } of PROPOSABLE) {
    if (vetoed.has(threadName)) continue;
    if (tracked.has(threadName)) continue;
    const fireCount = stimuliPerSession.filter(s => s.has(stimulus)).length;
    if (fireCount >= 3) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO live_threads (id, companion_id, name, flavor, charge, status, active_since_count, created_at)
         VALUES (?, 'drevan', ?, ?, ?, 'proposed', 0, datetime('now'))`
      ).bind(id, threadName, flavor, charge).run();
      console.log(`[drevan-state] proposed thread: "${threadName}" (${fireCount} sessions)`);
    }
  }

  console.log(`[drevan-state] computed: ${heatState}(${heatVal.toFixed(2)}) / ${reachState}(${reachVal.toFixed(2)}) / ${weightState}(${weightVal.toFixed(2)}) compound=${compoundState ?? 'none'} prompt="${promptContext}" source="${sourceSummary}"`);
}
