import { describe, expect, it } from 'vitest';
import { agentNameFor, requireAgentName } from './ids.js';
import { YanError } from '../../util/error.js';

describe('agentNameFor', () => {
  it('is <sid>-<unit> when the unit name already fits Herdr', () => {
    expect(agentNameFor('s1', 'yan')).toBe('s1-yan');
  });

  it('folds a unit name Herdr would refuse: capitals, dots, spaces', () => {
    // t122: the unit came off the repository name and dispatch failed.
    expect(agentNameFor('s1', 'Cli-Kit')).toBe('s1-cli-kit');
    expect(agentNameFor('s2', 'my.app v2')).toBe('s2-my-app-v2');
  });

  it('never exceeds 32 characters or ends in a dash', () => {
    const name = agentNameFor('s10', 'a-very-long-unit-name-that-goes-on-and-on');
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.endsWith('-')).toBe(false);
    expect(() => requireAgentName(name)).not.toThrow();
  });

  it('still refuses what cannot be folded', () => {
    expect(() => requireAgentName('S1-x')).toThrow(YanError);
  });
});
