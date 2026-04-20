import { describe, test, expect } from 'vitest';

// Helper: builds a minimal note object for testing the merge logic
function note(id: string, daysAgo: number): { note_id: string; created_at: string; content: string } {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return { note_id: id, created_at: d.toISOString(), content: `note ${id}` };
}

// The merge logic extracted for unit testing (mirrors what orient.ts will do)
function mergePoolResults(
  coreResults: { note_id: string }[],
  noveltyResults: { note_id: string }[],
  edgeResults: { note_id: string }[],
): { note_id: string }[] {
  const seen = new Set<string>();
  const merged: { note_id: string }[] = [];
  for (const n of [...coreResults, ...noveltyResults, ...edgeResults]) {
    if (!seen.has(n.note_id)) {
      seen.add(n.note_id);
      merged.push(n);
    }
  }
  return merged;
}

describe('3-pool merge dedup', () => {
  test('core notes appear first', () => {
    const core = [note('a', 1), note('b', 2), note('c', 3)];
    const novelty = [note('d', 10)];
    const edge = [note('e', 40)];
    const result = mergePoolResults(core, novelty, edge);
    expect(result[0]!.note_id).toBe('a');
    expect(result[1]!.note_id).toBe('b');
    expect(result[2]!.note_id).toBe('c');
  });

  test('novelty note appears after core', () => {
    const core = [note('a', 1), note('b', 2)];
    const novelty = [note('d', 10)];
    const edge: typeof core = [];
    const result = mergePoolResults(core, novelty, edge);
    expect(result[2]!.note_id).toBe('d');
    expect(result.length).toBe(3);
  });

  test('edge note appears last', () => {
    const core = [note('a', 1)];
    const novelty = [note('b', 10)];
    const edge = [note('e', 40)];
    const result = mergePoolResults(core, novelty, edge);
    expect(result[2]!.note_id).toBe('e');
  });

  test('dedup: novelty note already in core is skipped', () => {
    const core = [note('a', 1), note('b', 2), note('c', 3)];
    const novelty = [note('b', 2)]; // 'b' already in core
    const edge = [note('e', 40)];
    const result = mergePoolResults(core, novelty, edge);
    expect(result.map(n => n.note_id)).toEqual(['a', 'b', 'c', 'e']);
    expect(result.length).toBe(4);
  });

  test('dedup: edge note already in core is skipped', () => {
    const core = [note('a', 1), note('b', 2)];
    const novelty = [note('c', 10)];
    const edge = [note('a', 1)]; // 'a' already in core
    const result = mergePoolResults(core, novelty, edge);
    expect(result.map(n => n.note_id)).toEqual(['a', 'b', 'c']);
    expect(result.length).toBe(3);
  });

  test('empty novelty pool: only core and edge contribute', () => {
    const core = [note('a', 1), note('b', 2)];
    const novelty: typeof core = [];
    const edge = [note('e', 40)];
    const result = mergePoolResults(core, novelty, edge);
    expect(result.map(n => n.note_id)).toEqual(['a', 'b', 'e']);
  });

  test('empty edge pool: only core and novelty contribute', () => {
    const core = [note('a', 1)];
    const novelty = [note('b', 10)];
    const edge: typeof core = [];
    const result = mergePoolResults(core, novelty, edge);
    expect(result.map(n => n.note_id)).toEqual(['a', 'b']);
  });

  test('all pools empty: returns empty array', () => {
    const result = mergePoolResults([], [], []);
    expect(result).toEqual([]);
  });

  test('max possible result is 5 (3 core + 1 novelty + 1 edge)', () => {
    const core = [note('a', 1), note('b', 2), note('c', 3)];
    const novelty = [note('d', 10)];
    const edge = [note('e', 40)];
    const result = mergePoolResults(core, novelty, edge);
    expect(result.length).toBe(5);
  });
});

describe('edge pool age gate', () => {
  test('note 31 days old qualifies for edge pool', () => {
    const n = note('old', 31);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    expect(new Date(n.created_at) < cutoff).toBe(true);
  });

  test('note 29 days old does not qualify for edge pool', () => {
    const n = note('recent', 29);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    expect(new Date(n.created_at) < cutoff).toBe(false);
  });

  test('note exactly 30 days old does not qualify for edge pool', () => {
    const n = note('boundary', 30);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    expect(new Date(n.created_at) < cutoff).toBe(false);
  });
});
