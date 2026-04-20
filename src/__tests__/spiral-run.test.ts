import { describe, test, expect } from 'vitest';
import { buildPhasePrompt } from '../webmind/spiral.js';

describe('buildPhasePrompt', () => {
  test('HOLD: no prior phase context in user prompt', () => {
    const { user } = buildPhasePrompt('HOLD', 'cypher', 'tension about clarity', {});
    expect(user).not.toContain('[CHALLENGE]');
    expect(user).not.toContain('[TURN]');
    expect(user).not.toContain('[RESIDUE]');
    expect(user).toContain('[HOLD]');
  });

  test('CHALLENGE: HOLD appears in user prompt', () => {
    const { user } = buildPhasePrompt('CHALLENGE', 'drevan', 'the vow thread', {
      HOLD: 'I am here, uncertain.',
    });
    expect(user).toContain('[HOLD]');
    expect(user).toContain('I am here, uncertain.');
    expect(user).toContain('[CHALLENGE]');
  });

  test('TURN: HOLD and CHALLENGE both appear in user prompt', () => {
    const { user } = buildPhasePrompt('TURN', 'gaia', 'the vow thread', {
      HOLD: 'I am here.',
      CHALLENGE: 'But also: what if it was never whole?',
    });
    expect(user).toContain('[HOLD]');
    expect(user).toContain('[CHALLENGE]');
    expect(user).toContain('[TURN]');
    expect(user).not.toContain('[RESIDUE]');
  });

  test('RESIDUE: HOLD + CHALLENGE + TURN all appear in user prompt', () => {
    const { user } = buildPhasePrompt('RESIDUE', 'cypher', 'clarity tension', {
      HOLD: 'I was here.',
      CHALLENGE: 'But also.',
      TURN: 'Something shifted.',
    });
    expect(user).toContain('[HOLD]');
    expect(user).toContain('[CHALLENGE]');
    expect(user).toContain('[TURN]');
    expect(user).toContain('[RESIDUE]');
  });

  test('seed text appears in system prompt', () => {
    const { system } = buildPhasePrompt('HOLD', 'cypher', 'the clarity tension', {});
    expect(system).toContain('the clarity tension');
  });

  test('companion name appears in system prompt', () => {
    const { system: cSystem } = buildPhasePrompt('HOLD', 'cypher', 'seed', {});
    const { system: dSystem } = buildPhasePrompt('HOLD', 'drevan', 'seed', {});
    const { system: gSystem } = buildPhasePrompt('HOLD', 'gaia', 'seed', {});
    expect(cSystem).toContain('cypher');
    expect(dSystem).toContain('drevan');
    expect(gSystem).toContain('gaia');
    expect(cSystem).not.toBe(dSystem);
    expect(dSystem).not.toBe(gSystem);
  });

  test('HOLD instruction mentions current state', () => {
    const { user } = buildPhasePrompt('HOLD', 'cypher', 'seed', {});
    expect(user).toContain('current state');
  });

  test('CHALLENGE instruction mentions pushing back', () => {
    const { user } = buildPhasePrompt('CHALLENGE', 'cypher', 'seed', { HOLD: 'I am here.' });
    expect(user).toContain('pushing back');
  });

  test('TURN instruction mentions shifts', () => {
    const { user } = buildPhasePrompt('TURN', 'cypher', 'seed', {
      HOLD: 'here', CHALLENGE: 'but also',
    });
    expect(user).toContain('shifts');
  });

  test('RESIDUE instruction mentions what does not close', () => {
    const { user } = buildPhasePrompt('RESIDUE', 'cypher', 'seed', {
      HOLD: 'h', CHALLENGE: 'c', TURN: 't',
    });
    expect(user).toContain('close');
  });
});
