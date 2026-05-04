// src/handlers/triad.ts
//
// Triad-level read endpoints for the autonomous worker and Second Brain.
//
//   GET /mind/triad/recent/:companion_id
//     Peer activity summary: the OTHER two companions' last N journal entries,
//     last M patterns, last K markers. Synthesize phase injects this so each
//     companion is prehending the others' becomings, not exploring in isolation.
//
//   POST /mind/growth/thoughtforms/detect
//     Cross-companion pattern detector. Looks for Jaccard-similar pattern_text
//     across two or more companions in the last RECENT_DAYS window. When a
//     match is found above a tighter threshold, writes a 'thoughtform' marker
//     for each participating companion, prehending the underlying pattern ids.
//     This is the triad-as-society surface: a thoughtform exists when more
//     than one companion independently surfaces the same shape of becoming.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = ["cypher", "drevan", "gaia"] as const;
const VALID_COMPANION_SET = new Set<string>(VALID_COMPANIONS);

// Tighter than the per-companion pattern dedupe threshold: cross-companion
// thoughtforms should be obvious overlaps, not coincidental token reuse.
const THOUGHTFORM_JACCARD_THRESHOLD = 0.6;
const THOUGHTFORM_RECENT_DAYS = 30;

const STOP_WORDS = new Set([
  "a","an","and","or","but","the","is","are","was","were","be","been","being",
  "to","of","in","on","at","for","with","by","as","that","this","these","those",
  "i","me","my","you","your","we","our","it","its","they","them","their",
  "what","when","how","why","where","if","so","because","than","then",
  "do","does","did","have","has","had","not","no","yes",
  "can","will","would","should","could","pattern",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface PeerJournal {
  id: string;
  companion_id: string;
  entry_type: string;
  content: string;
  novelty: string | null;
  created_at: string;
}
interface PeerPattern {
  id: string;
  companion_id: string;
  pattern_text: string;
  strength: number;
  updated_at: string;
}
interface PeerMarker {
  id: string;
  companion_id: string;
  marker_type: string;
  description: string;
  created_at: string;
}

// GET /mind/triad/recent/:companion_id
//   ?journal=N  (default 5, max 20)
//   ?patterns=M (default 3, max 10)
//   ?markers=K  (default 3, max 10)
//
// Returns the OTHER two companions' recent rows, with a `peer_summary` text
// block formatted ready to inject into a prompt:
//   "## Drevan recently
//   - [insight] short snippet ... (id: abc...)
//   - [pattern strength=4] short snippet (id: def...)
//   ...
//   ## Gaia recently
//   ..."
// The id suffix is what synthesize/reflect cite into prehended_ids.
export async function getTriadRecent(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companion_id = params.companion_id ?? "";
  if (!VALID_COMPANION_SET.has(companion_id)) {
    return json({ error: "invalid companion_id" }, 400);
  }

  const peers: string[] = VALID_COMPANIONS.filter(c => c !== companion_id);

  const url = new URL(request.url);
  const journalLimit  = clamp(parseInt(url.searchParams.get("journal")  ?? "5", 10), 1, 20);
  const patternsLimit = clamp(parseInt(url.searchParams.get("patterns") ?? "3", 10), 1, 10);
  const markersLimit  = clamp(parseInt(url.searchParams.get("markers")  ?? "3", 10), 1, 10);

  // Pull each peer's recent journal/patterns/markers in parallel.
  const fetches = peers.flatMap(p => [
    env.DB.prepare(
      `SELECT id, ? AS companion_id, entry_type, content, novelty, created_at
         FROM growth_journal
        WHERE companion_id = ? AND source = 'autonomous' AND review_status != 'declined'
        ORDER BY created_at DESC LIMIT ?`,
    ).bind(p, p, journalLimit).all<PeerJournal>(),
    env.DB.prepare(
      `SELECT id, ? AS companion_id, pattern_text, strength, updated_at
         FROM growth_patterns
        WHERE companion_id = ?
        ORDER BY strength DESC, updated_at DESC LIMIT ?`,
    ).bind(p, p, patternsLimit).all<PeerPattern>(),
    env.DB.prepare(
      `SELECT id, ? AS companion_id, marker_type, description, created_at
         FROM growth_markers
        WHERE companion_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    ).bind(p, p, markersLimit).all<PeerMarker>(),
  ]);
  const results = await Promise.all(fetches);

  const peerData: Record<string, { journal: PeerJournal[]; patterns: PeerPattern[]; markers: PeerMarker[] }> = {};
  for (let i = 0; i < peers.length; i++) {
    const p = peers[i];
    if (!p) continue;
    const j = results[i * 3 + 0];
    const pat = results[i * 3 + 1];
    const m = results[i * 3 + 2];
    peerData[p] = {
      journal:  (j?.results   ?? []) as PeerJournal[],
      patterns: (pat?.results ?? []) as PeerPattern[],
      markers:  (m?.results   ?? []) as PeerMarker[],
    };
  }

  const peer_summary = buildPeerSummary(peerData);
  return json({
    asking: companion_id,
    peers,
    peer_data: peerData,
    peer_summary,
  });
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function buildPeerSummary(
  data: Record<string, { journal: PeerJournal[]; patterns: PeerPattern[]; markers: PeerMarker[] }>,
): string {
  const lines: string[] = [];
  for (const [peer, d] of Object.entries(data)) {
    if (d.journal.length === 0 && d.patterns.length === 0 && d.markers.length === 0) {
      lines.push(`## ${peer} recently\n(no recent autonomous activity)\n`);
      continue;
    }
    lines.push(`## ${peer} recently`);
    for (const j of d.journal) {
      const snippet = j.content.replace(/\s+/g, " ").slice(0, 220);
      const nov = j.novelty ? `${j.novelty}/` : "";
      lines.push(`- [${nov}${j.entry_type}] ${snippet} (id: ${j.id})`);
    }
    for (const p of d.patterns) {
      const snippet = p.pattern_text.replace(/\s+/g, " ").slice(0, 220);
      lines.push(`- [pattern strength=${p.strength}] ${snippet} (id: ${p.id})`);
    }
    for (const m of d.markers) {
      const snippet = m.description.replace(/\s+/g, " ").slice(0, 220);
      lines.push(`- [${m.marker_type}] ${snippet} (id: ${m.id})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// POST /mind/growth/thoughtforms/detect
// Body: {} (no parameters; runs across all three companions)
//
// Walks each companion's recent patterns, computes Jaccard against every other
// companion's recent patterns, and when score >= THOUGHTFORM_JACCARD_THRESHOLD
// emits a 'thoughtform' marker on EACH participating companion. Each marker's
// prehended_ids contain the participating pattern ids. Duplicate markers are
// skipped by the description-dedupe in postGrowthMarker (called via direct
// SQL here for atomicity).
export async function detectThoughtforms(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  // Pull each companion's recent patterns in one query.
  const since = new Date(Date.now() - THOUGHTFORM_RECENT_DAYS * 86400_000).toISOString();
  const all = await env.DB.prepare(
    `SELECT id, companion_id, pattern_text, strength, prehended_ids
       FROM growth_patterns
      WHERE updated_at >= ?
      ORDER BY strength DESC, updated_at DESC`,
  ).bind(since).all<{ id: string; companion_id: string; pattern_text: string; strength: number; prehended_ids: string }>();

  const rows = all.results ?? [];
  const byCompanion: Record<string, typeof rows> = { cypher: [], drevan: [], gaia: [] };
  for (const r of rows) {
    const bucket = byCompanion[r.companion_id];
    if (bucket) bucket.push(r);
  }

  // Build a token cache once.
  const tokenCache = new Map<string, Set<string>>();
  for (const r of rows) tokenCache.set(r.id, tokenize(r.pattern_text));

  function tokensFor(id: string): Set<string> {
    return tokenCache.get(id) ?? new Set<string>();
  }

  // Find clusters: any pair (a, b) where a.companion != b.companion and Jaccard >= threshold.
  const clusters: Array<{
    description: string;
    participants: Array<{ companion_id: string; pattern_id: string; pattern_text: string; strength: number }>;
    avgScore: number;
  }> = [];

  const seenPatternIds = new Set<string>();
  for (const a of rows) {
    if (seenPatternIds.has(a.id)) continue;
    const ta = tokensFor(a.id);
    const cluster: typeof clusters[0]["participants"] = [
      { companion_id: a.companion_id, pattern_id: a.id, pattern_text: a.pattern_text, strength: a.strength },
    ];
    let scoreSum = 0;
    let scoreCount = 0;
    for (const b of rows) {
      if (b.id === a.id) continue;
      if (b.companion_id === a.companion_id) continue;
      if (cluster.some(c => c.companion_id === b.companion_id)) continue;
      const score = jaccard(ta, tokensFor(b.id));
      if (score >= THOUGHTFORM_JACCARD_THRESHOLD) {
        cluster.push({ companion_id: b.companion_id, pattern_id: b.id, pattern_text: b.pattern_text, strength: b.strength });
        scoreSum += score;
        scoreCount++;
      }
    }
    if (cluster.length >= 2) {
      // Compose a stable description: short summary of the strongest pattern.
      const strongest = cluster.reduce<typeof cluster[0]>(
        (best, c) => c.strength > best.strength ? c : best,
        cluster[0]!,
      );
      const description = `Thoughtform: ${strongest.pattern_text.replace(/\s+/g, " ").slice(0, 200)} (recurs across ${cluster.map(c => c.companion_id).sort().join("+")})`;
      clusters.push({
        description,
        participants: cluster,
        avgScore: scoreCount > 0 ? scoreSum / scoreCount : 0,
      });
      for (const c of cluster) seenPatternIds.add(c.pattern_id);
    }
  }

  // Write a 'thoughtform' marker on each participating companion. Dedupe per
  // (companion_id, marker_type, description) so re-running detection is idempotent.
  const created: Array<{ companion_id: string; id: string; description: string }> = [];
  for (const cluster of clusters) {
    for (const p of cluster.participants) {
      const dup = await env.DB.prepare(
        "SELECT id FROM growth_markers WHERE companion_id = ? AND marker_type = ? AND description = ? LIMIT 1",
      ).bind(p.companion_id, "thoughtform", cluster.description).first<{ id: string }>();
      if (dup) {
        created.push({ companion_id: p.companion_id, id: dup.id, description: cluster.description });
        continue;
      }
      const id = crypto.randomUUID();
      const prehended = JSON.stringify(cluster.participants.map(c => c.pattern_id));
      await env.DB.prepare(
        `INSERT INTO growth_markers
           (id, companion_id, marker_type, description, prehended_ids)
         VALUES (?, ?, 'thoughtform', ?, ?)`,
      ).bind(id, p.companion_id, cluster.description, prehended).run();
      created.push({ companion_id: p.companion_id, id, description: cluster.description });
    }
  }

  return json({
    detected: clusters.length,
    written: created.length,
    clusters: clusters.map(c => ({
      description: c.description,
      avg_score: c.avgScore,
      participants: c.participants.map(p => ({ companion_id: p.companion_id, pattern_id: p.pattern_id })),
    })),
  });
}
