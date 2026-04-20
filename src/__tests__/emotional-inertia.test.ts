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
