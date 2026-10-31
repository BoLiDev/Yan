import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir } from '../../tests/helpers/fixtures.js';
import { holdTerminal, letTerminalGo, machineConfigPath, readMachine, registerVault, skillDirs, terminalsOf } from './machine.js';
import { normalizePath } from './paths.js';

afterAll(cleanupTempDirs);

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.YAN_MACHINE_DIR;
  process.env.YAN_MACHINE_DIR = mkTempDir();
});
afterEach(() => {
  if (saved === undefined) delete process.env.YAN_MACHINE_DIR;
  else process.env.YAN_MACHINE_DIR = saved;
});

describe('skillDir', () => {
  it('is one folder or a list, read from the home directory as a shell would', () => {
    writeFileSync(machineConfigPath(), JSON.stringify({ version: 1, vaults: {}, clones: {}, skillDir: '~/work/skills/' }));
    expect(skillDirs()).toEqual([normalizePath(join(homedir(), 'work', 'skills'))]);

    writeFileSync(machineConfigPath(), JSON.stringify({ version: 1, vaults: {}, clones: {}, skillDir: ['/opt/skills', 'more', '', 3] }));
    expect(skillDirs()).toEqual(['/opt/skills', normalizePath(join(homedir(), 'more'))]);
  });

  it('is nothing when the file has none', () => {
    expect(skillDirs()).toEqual([]);
  });

  it('survives yan rewriting the file, as it was written', () => {
    writeFileSync(machineConfigPath(), JSON.stringify({ version: 1, vaults: {}, clones: {}, skillDir: '~/work/skills' }));
    registerVault('personal', '/vaults/personal');
    expect(readMachine().active).toBe('personal');
    expect((JSON.parse(readFileSync(machineConfigPath(), 'utf8')) as { skillDir: unknown }).skillDir).toBe('~/work/skills');
  });
});

describe('terminals', () => {
  const held = (task: string, pane: string, vault = '/vaults/personal') => ({ vault, task, pane, socket: '/run/herdr.sock', bin: 'herdr', cli: 'claude', since: '2026-10-31T09:00:00Z' });

  it('keeps one agent a task, the last started, by vault, and forgets it once its pane is let go', () => {
    holdTerminal(held('t001', 'w1:p1'));
    holdTerminal(held('t002', 'w1:p2'));
    holdTerminal(held('t001', 'w1:p3'));
    holdTerminal(held('t001', 'w1:p1', '/vaults/work'));
    expect(terminalsOf('/vaults/personal').map((t) => `${t.task} ${t.pane}`)).toEqual(['t002 w1:p2', 't001 w1:p3']);

    letTerminalGo('/vaults/personal', 't001', 'w1:p1');
    expect(terminalsOf('/vaults/personal').length, 'an agent started since in another pane stays').toBe(2);
    letTerminalGo('/vaults/personal', 't001', 'w1:p3');
    letTerminalGo('/vaults/personal', 't002', 'w1:p2');
    expect(terminalsOf('/vaults/personal')).toEqual([]);
    expect(terminalsOf('/vaults/work')).toHaveLength(1);
  });

  it('survives yan rewriting the file for something else', () => {
    holdTerminal(held('t001', 'w1:p1'));
    registerVault('personal', '/vaults/personal');
    expect(terminalsOf('/vaults/personal')).toEqual([held('t001', 'w1:p1')]);
  });
});
