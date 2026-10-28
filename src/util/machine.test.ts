import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir } from '../../tests/helpers/fixtures.js';
import { machineConfigPath, readMachine, registerVault, skillDirs } from './machine.js';
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
