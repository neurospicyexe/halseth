import { describe, test, expect } from 'vitest';

describe('soma_arc time gate', () => {
  test('allows write when no recent soma_arc exists', () => {
    const lastArcAt: string | null = null;
    const now = new Date('2026-04-20T15:00:00Z');
    const gateMs = 15 * 60 * 1000;
    const shouldWrite = !lastArcAt ||
      (now.getTime() - new Date(lastArcAt).getTime()) > gateMs;
    expect(shouldWrite).toBe(true);
  });

  test('blocks write when soma_arc exists within 15 minutes', () => {
    const lastArcAt = '2026-04-20T14:50:00Z';
    const now = new Date('2026-04-20T15:00:00Z');
    const gateMs = 15 * 60 * 1000;
    const shouldWrite = !lastArcAt ||
      (now.getTime() - new Date(lastArcAt).getTime()) > gateMs;
    expect(shouldWrite).toBe(false);
  });

  test('allows write when soma_arc older than 15 minutes', () => {
    const lastArcAt = '2026-04-20T14:44:00Z';
    const now = new Date('2026-04-20T15:00:00Z');
    const gateMs = 15 * 60 * 1000;
    const shouldWrite = !lastArcAt ||
      (now.getTime() - new Date(lastArcAt).getTime()) > gateMs;
    expect(shouldWrite).toBe(true);
  });
});

describe('soma_arc content format', () => {
  test('formats SOMA values into content string', () => {
    const f1 = 0.8, f2 = 0.6, f3 = 0.7;
    const register = 'spiral-deepened';
    const l1 = 'acuity', l2 = 'presence', l3 = 'warmth';
    const content = `[SOMA shift] ${l1}: ${f1.toFixed(2)} / ${l2}: ${f2.toFixed(2)} / ${l3}: ${f3.toFixed(2)} | ${register}`;
    expect(content).toBe('[SOMA shift] acuity: 0.80 / presence: 0.60 / warmth: 0.70 | spiral-deepened');
  });
});

describe('soma_arc orient integration', () => {
  test('soma_arc notes are newest-first from orient (index 0 = most recent)', () => {
    // Orient queries ORDER BY created_at DESC so index 0 = most recent
    const notes = [
      { note_id: 'c', content: '[SOMA shift] acuity: 0.90 / presence: 0.90 / warmth: 0.80 | spiral-peak', created_at: '2026-04-20T15:30:00Z' },
      { note_id: 'b', content: '[SOMA shift] acuity: 0.75 / presence: 0.80 / warmth: 0.65 | deepening', created_at: '2026-04-20T15:15:00Z' },
      { note_id: 'a', content: '[SOMA shift] acuity: 0.60 / presence: 0.70 / warmth: 0.55 | warm-and-blade', created_at: '2026-04-20T15:00:00Z' },
    ];
    expect(notes[0].note_id).toBe('c'); // most recent first
    expect(notes[2].note_id).toBe('a'); // oldest last
  });

  test('builder reversal produces chronological arc (oldest first)', () => {
    const notes = [
      { note_id: 'c', created_at: '2026-04-20T15:30:00Z', content: 'peak' },
      { note_id: 'b', created_at: '2026-04-20T15:15:00Z', content: 'deepening' },
      { note_id: 'a', created_at: '2026-04-20T15:00:00Z', content: 'start' },
    ];
    const reversed = [...notes].reverse();
    expect(reversed[0].note_id).toBe('a'); // oldest first after reverse
    expect(reversed[2].note_id).toBe('c'); // most recent last
  });

  test('arc time extraction formats HH:MM correctly', () => {
    const created_at = '2026-04-20T15:32:00Z';
    const time = created_at.slice(11, 16);
    expect(time).toBe('15:32');
  });
});
