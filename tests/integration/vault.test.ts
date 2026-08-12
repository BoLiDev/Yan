import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkEmptyRemote,
  mkTempDir,
  mkYanHome,
  runYan,
} from '../helpers/fixtures.js';

/**
 * `yan vault` — the three layers, and the resolution rules between them
 * (v3 td vault.md, plan Phase 1).
 *
 * The whole point of this phase is that a machine can hold two contexts and
 * never mix them, so the tests that matter are about *which* vault answers:
 * an env override that only counts when it is really a vault, an `active`
 * entry that points at nothing, a name that is already taken. The happy path
 * is one test; the ways to be wrong are the rest of the file.
 *
 * Real git against a local bare remote. Nothing here touches the network, and
 * `$YAN_MACHINE_DIR` keeps every registration inside the temp directory.
 */

afterAll(cleanupTempDirs);

let home = '';
let tmp = '';
let machine = '';

/** A fresh machine layer per test, so registrations never leak between them. */
function isolated(name: string): Record<string, string | undefined> {
  return { YAN_MACHINE_DIR: join(tmp, 'machines', name), YAN_VAULT: undefined };
}

function machineConfig(name: string): Record<string, unknown> {
  const file = join(tmp, 'machines', name, 'config.json');
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** git commits in these tests run with no repository identity configured. */
const identity = {
  GIT_AUTHOR_NAME: 'yan tests',
  GIT_AUTHOR_EMAIL: 'yan-tests@localhost',
  GIT_COMMITTER_NAME: 'yan tests',
  GIT_COMMITTER_EMAIL: 'yan-tests@localhost',
};

beforeAll(async () => {
  tmp = mkTempDir('yan-vault-');
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  machine = join(tmp, 'machines');
  await Promise.resolve();
});

describe('vault init', () => {
  it('creates the skeleton, pushes it, and makes it active', async () => {
    const bare = await mkEmptyRemote(join(tmp, 'personal.git'));
    const dir = join(tmp, 'vaults', 'personal');

    const r = await runYan(home, ['vault', 'init', 'personal', '--remote', bare, '--path', dir], {
      ...isolated('init'),
      ...identity,
    });
    expect(r.code).toBe(0);

    // The layout, as vault.md §2 declares it.
    for (const rel of ['vault.json', 'config.json', 'repos.json', '.gitignore', 'README.md', 'tasks', 'mem/learnings']) {
      expect(existsSync(join(dir, rel)), rel).toBe(true);
    }
    const identityJson = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as Record<string, unknown>;
    expect(identityJson.name).toBe('personal');
    expect(identityJson.version).toBe(1);

    // Pushed, and the remote really has it.
    const remoteFiles = await fxGit(['-C', bare, 'ls-tree', '--name-only', 'main']);
    expect(remoteFiles.stdout).toContain('vault.json');

    // Registered and active, with a clone_root defaulted beside the mechanics.
    const config = machineConfig('init');
    expect(config.active).toBe('personal');
    expect((config.vaults as Record<string, string>).personal.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'));
    expect(typeof config.clone_root).toBe('string');
  });

  it('refuses a name that is already registered, and a directory that is not empty', async () => {
    const bare = await mkEmptyRemote(join(tmp, 'twice.git'));
    const env = { ...isolated('twice'), ...identity };
    const first = await runYan(home, ['vault', 'init', 'work', '--remote', bare, '--path', join(tmp, 'vaults', 'work')], env);
    expect(first.code).toBe(0);

    const again = await runYan(home, ['vault', 'init', 'work', '--remote', bare, '--path', join(tmp, 'vaults', 'work2')], env);
    expect(again.code).not.toBe(0);
    expect(again.out).toContain('already registered');

    const occupied = join(tmp, 'vaults', 'occupied');
    writeFileSync(join(mkTempDir('yan-occupied-'), 'x'), 'x');
    const dir = mkTempDir('yan-occupied-dir-');
    writeFileSync(join(dir, 'something'), 'in the way\n');
    const taken = await runYan(home, ['vault', 'init', 'other', '--remote', bare, '--path', dir], env);
    expect(taken.code).not.toBe(0);
    expect(taken.out).toContain('not empty');
    expect(existsSync(join(occupied, 'vault.json'))).toBe(false);
  });
});

describe('resolution', () => {
  it('every data command refuses, by name, when no vault is registered', async () => {
    const r = await runYan(home, ['vault', 'where'], isolated('empty'));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('yan vault init');
  });

  it('$YAN_VAULT wins, but only when it really is a vault', async () => {
    const bare = await mkEmptyRemote(join(tmp, 'env.git'));
    const env = { ...isolated('env'), ...identity };
    const dir = join(tmp, 'vaults', 'env-active');
    await runYan(home, ['vault', 'init', 'env-active', '--remote', bare, '--path', dir], env);

    const notAVault = mkTempDir('yan-not-a-vault-');
    const ignored = await runYan(home, ['vault', 'where'], { ...env, YAN_VAULT: notAVault });
    expect(ignored.code).toBe(0);
    expect(ignored.stdout.trim().replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'));

    const other = join(tmp, 'vaults', 'env-override');
    await runYan(home, ['vault', 'init', 'env-override', '--remote', await mkEmptyRemote(join(tmp, 'env2.git')), '--path', other], env);
    const overridden = await runYan(home, ['vault', 'where'], { ...env, YAN_VAULT: dir });
    expect(overridden.stdout.trim().replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'));
  });

  it('says which vault moved when the active one is gone', async () => {
    const env = isolated('gone');
    mkdirSync(join(tmp, 'machines', 'gone'), { recursive: true });
    writeFileSync(
      join(tmp, 'machines', 'gone', 'config.json'),
      `${JSON.stringify({ version: 1, active: 'ghost', vaults: { ghost: join(tmp, 'nowhere') } }, null, 2)}\n`,
      { flag: 'w' },
    );
    const r = await runYan(home, ['vault', 'where'], env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('ghost');
    expect(r.out).toContain('not at');
  });

  it('refuses a vault written by a newer yan rather than downgrading it', async () => {
    const bare = await mkEmptyRemote(join(tmp, 'ahead.git'));
    const env = { ...isolated('ahead'), ...identity };
    const dir = join(tmp, 'vaults', 'ahead');
    await runYan(home, ['vault', 'init', 'ahead', '--remote', bare, '--path', dir], env);

    writeFileSync(join(dir, 'vault.json'), `${JSON.stringify({ version: 99, name: 'ahead' }, null, 2)}\n`);
    const r = await runYan(home, ['vault', 'where'], env);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('newer yan');
  });
});

describe('clone, ls and use', () => {
  it('clones a vault, takes its own name, and warns that no repository is linked yet', async () => {
    const bare = await mkEmptyRemote(join(tmp, 'shared.git'));
    const first = { ...isolated('machine-a'), ...identity };
    await runYan(home, ['vault', 'init', 'shared', '--remote', bare, '--path', join(tmp, 'vaults', 'shared-a')], first);

    const second = { ...isolated('machine-b'), ...identity };
    const dir = join(tmp, 'vaults', 'shared-b');
    const r = await runYan(home, ['vault', 'clone', bare, '--path', dir], second);
    expect(r.code).toBe(0);
    expect(r.out).toContain('yan repo add');
    expect(machineConfig('machine-b').active).toBe('shared');
    expect(existsSync(join(dir, 'vault.json'))).toBe(true);
  });

  it('switches with `yan use`, and refuses a name it does not know', async () => {
    const env = { ...isolated('switch'), ...identity };
    await runYan(home, ['vault', 'init', 'one', '--remote', await mkEmptyRemote(join(tmp, 'one.git')), '--path', join(tmp, 'vaults', 'one')], env);
    await runYan(home, ['vault', 'init', 'two', '--remote', await mkEmptyRemote(join(tmp, 'two.git')), '--path', join(tmp, 'vaults', 'two')], env);
    expect(machineConfig('switch').active).toBe('two');

    const back = await runYan(home, ['use', 'one'], env);
    expect(back.code).toBe(0);
    expect(machineConfig('switch').active).toBe('one');

    const listed = await runYan(home, ['vault', 'ls'], env);
    expect(listed.stdout).toContain('* one');
    expect(listed.stdout).toContain('two');

    const nope = await runYan(home, ['use', 'three'], env);
    expect(nope.code).not.toBe(0);
    expect(nope.out).toContain('no such vault: three');
    expect(nope.out).toContain('one, two');
  });
});
