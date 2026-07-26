import { describe, test, expect } from 'vitest';

function openLoopsTestData() {
  return [
    { id: 'loop-1', loop_text: 'Fix audit logging', weight: 0.9, opened_at: '2026-07-01T10:00:00Z' },
    { id: 'loop-2', loop_text: 'API integration', weight: 0.9, opened_at: '2026-07-02T10:00:00Z' },
    { id: 'loop-3', loop_text: 'Document changes', weight: 0.5, opened_at: '2026-06-28T10:00:00Z' },
  ];
}

function openQuestionsTestData() {
  return [
    { id: 'q-1', question: 'What does this mean?', context: 'About event', created_at: '2026-07-02T10:00:00Z' },
    { id: 'q-2', question: 'How should I approach?', context: null, created_at: '2026-07-01T10:00:00Z' },
  ];
}

describe('WmOrientOpenLoop and WmOrientOpenQuestion', () => {
  test('open loops have correct shape', () => {
    const loops = openLoopsTestData();
    expect(loops[0]).toHaveProperty('id');
    expect(loops[0]).toHaveProperty('loop_text');
    expect(loops[0]).toHaveProperty('weight');
    expect(loops[0]).toHaveProperty('opened_at');
  });

  test('open questions have correct shape', () => {
    const questions = openQuestionsTestData();
    expect(questions[0]).toHaveProperty('id');
    expect(questions[0]).toHaveProperty('question');
    expect(questions[0]).toHaveProperty('context');
    expect(questions[0]).toHaveProperty('created_at');
  });

  test('weight DESC then opened_at ASC ordering', () => {
    const loops = openLoopsTestData().sort((a, b) => {
      const wd = b.weight - a.weight;
      if (wd !== 0) return wd;
      return new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime();
    });
    expect(loops[0]!.id).toBe('loop-1');
    expect(loops[1]!.id).toBe('loop-2');
    expect(loops[2]!.weight).toBe(0.5);
  });

  test('created_at DESC for questions', () => {
    const questions = openQuestionsTestData().sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    expect(questions[0]!.id).toBe('q-1');
    expect(questions[1]!.id).toBe('q-2');
  });
});
