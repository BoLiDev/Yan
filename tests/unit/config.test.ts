import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../helpers/fixtures.js';
import {
  agentSpecFor,
  modelFlags,
  readScenarios,
  resolveShift,
} from '../../src/cli/shared/config.js';

/**
 * `agents.*` and `scenarios`: what a role runs by default, and the only ways a
 * dispatch may run anything else.
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;
let previousVault: string | undefined;

function config(body: Record<string, unknown>): void {
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(body, null, 2)}\n`);
}

const SCENARIOS = {
  explore: {
    default: 'normal',
    tiers: {
      light: { description: 'find it', model: 'sonnet', effort: 'medium' },
      normal: { description: 'trace it' },
    },
  },
  coding: {
    default: 'normal',
    tiers: {
      normal: {},
      heavy: { effort: 'max' },
      elsewhere: { cli: 'codex', model: 'gpt-5' },
    },
  },
  uix: { tiers: { only: { cli: 'agy', model: 'gemini-3.1-pro-high', skills: ['/design', 'grilling'] } } },
};

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  previousVault = process.env.YAN_VAULT;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  if (previousVault === undefined) delete process.env.YAN_VAULT;
  else process.env.YAN_VAULT = previousVault;
});

describe('agents.<role>', () => {
  it('takes a bare string as the CLI alone', () => {
    config({ version: 1, agents: { yan: 'claude', shift: 'codex' } });
    expect(agentSpecFor('shift')).toEqual({ cli: 'codex', model: '', effort: '' });
    expect(agentSpecFor('yan')).toEqual({ cli: 'claude', model: '', effort: '' });
  });

  it('takes an object with a model and an effort', () => {
    config({ version: 1, agents: { yan: { cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' } } });
    expect(agentSpecFor('yan')).toEqual({ cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' });
    expect(agentSpecFor('shift')).toEqual({ cli: '', model: '', effort: '' });
  });
});

describe('resolveShift', () => {
  beforeEach(() => {
    config({ version: 1, agents: { shift: { cli: 'claude', model: 'opus', effort: 'high' } }, scenarios: SCENARIOS });
  });

  it('uses the default tier when none is named, inheriting what the tier leaves out', () => {
    expect(resolveShift('t', 'explore', undefined)).toEqual({
      scenario: 'explore', tier: 'normal', cli: 'claude', model: 'opus', effort: 'high', skills: [],
    });
  });

  it('overrides field by field', () => {
    expect(resolveShift('t', 'explore', 'light')).toMatchObject({ cli: 'claude', model: 'sonnet', effort: 'medium' });
    expect(resolveShift('t', 'coding', 'heavy')).toMatchObject({ cli: 'claude', model: 'opus', effort: 'max' });
  });

  it('does not carry a model meant for another CLI', () => {
    expect(resolveShift('t', 'coding', 'elsewhere')).toMatchObject({ cli: 'codex', model: 'gpt-5', effort: '' });
  });

  it("takes a lone tier as the scenario's default", () => {
    expect(resolveShift('t', 'uix', undefined)).toMatchObject({ tier: 'only', cli: 'agy' });
  });

  it('requires a scenario, and only one of the three', () => {
    expect(() => resolveShift('t', undefined, undefined)).toThrow(/--scenario is required - one of: explore coding uix/);
    expect(() => resolveShift('t', 'design', undefined)).toThrow(/'design' is not a scenario/);
  });

  it('refuses a tier the scenario does not have, and lists the ones it does', () => {
    expect(() => resolveShift('t', 'coding', 'max')).toThrow(/'max' is not a tier of coding - one of: normal heavy elsewhere/);
  });

  it('refuses a scenario the configuration cannot supply', () => {
    config({ version: 1, agents: { shift: 'claude' }, scenarios: { explore: SCENARIOS.explore } });
    expect(() => resolveShift('t', 'coding', undefined)).toThrow(/scenarios\.coding is missing/);
    config({ version: 1, agents: { shift: 'claude' } });
    expect(() => resolveShift('t', 'explore', undefined)).toThrow(/no scenarios configured/);
  });
});

describe('skills', () => {
  it('belong to the tier alone, with a leading slash taken off', () => {
    config({ version: 1, agents: { shift: 'claude' }, scenarios: SCENARIOS });
    expect(resolveShift('t', 'uix', undefined).skills).toEqual(['design', 'grilling']);
    expect(resolveShift('t', 'coding', undefined).skills).toEqual([]);
  });

  it('names a list that is not one, and loads nothing from it', () => {
    config({ version: 1, agents: { shift: 'claude' }, scenarios: { ...SCENARIOS, uix: { tiers: { only: { skills: 'design' } } } } });
    expect(readScenarios().problems.join('\n')).toContain('scenarios.uix.tiers.only.skills is not a list');
    expect(resolveShift('t', 'uix', undefined).skills).toEqual([]);
  });
});

describe('readScenarios', () => {
  it('names every problem instead of throwing', () => {
    config({
      version: 1,
      scenarios: {
        explore: { tiers: {} },
        coding: { default: 'huge', tiers: { normal: {}, heavy: {} } },
        uix: { tiers: { a: {}, b: {} } },
        design: { tiers: { normal: {} } },
      },
    });
    const { scenarios, problems } = readScenarios();
    expect(scenarios).toEqual([]);
    expect(problems.join('\n')).toContain('scenarios.design is not a scenario');
    expect(problems.join('\n')).toContain('scenarios.explore has no tiers');
    expect(problems.join('\n')).toContain("scenarios.coding.default 'huge' is not one of its tiers");
    expect(problems.join('\n')).toContain('scenarios.uix.default is not set');
  });
});

describe('modelFlags', () => {
  const spec = { model: 'm', effort: 'e' };

  it("speaks each CLI's spelling", () => {
    expect(modelFlags('claude', spec)).toEqual(['--model', 'm', '--effort', 'e']);
    expect(modelFlags('C:/tools/agy.exe', spec)).toEqual(['--model', 'm', '--effort', 'e']);
    expect(modelFlags('codex', spec)).toEqual(['-m', 'm', '-c', 'model_reasoning_effort=e']);
  });

  it('passes nothing that was not configured, and nothing to a CLI it does not know', () => {
    expect(modelFlags('claude', { model: '', effort: '' })).toEqual([]);
    expect(modelFlags('codex', { model: '', effort: 'high' })).toEqual(['-c', 'model_reasoning_effort=high']);
    expect(modelFlags('node', spec)).toEqual([]);
  });
});
