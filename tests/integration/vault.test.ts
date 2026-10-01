import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkEmptyRemote,
  mkTempDir,
  mkYanHome,
  runYan,
} from '../helpers/fixtures.js';

/**
 * `yan vault`, and which vault answers: an env override that only counts when
 * it really is a vault, an `active` entry pointing at nothing, a name already
 * taken. The happy path is one test; the ways to be wrong are the rest.
 *
 * Real git against a local bare remote. Nothing here touches the network, and
 * `$YAN_MACHINE_DIR` keeps every registration inside the temp directory.
 */

afterAll(cleanupTempDirs);

let home = '';
let tmp = '';

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

    // The layout.
    for (const rel of ['vault.json', 'config.json', '.gitignore', 'README.md', 'tasks', 'learnings']) {
      expect(existsSync(join(dir, rel)), rel).toBe(true);
    }
    for (const gone of ['repos.json', 'mem', 'skills']) expect(existsSync(join(dir, gone)), gone).toBe(false);
    const identityJson = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as Record<string, unknown>;
    expect(identityJson.name).toBe('personal');
    expect(identityJson.version).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toMatchObject({ cli: 'claude' });

    // Pushed, and the remote really has it.
    const remoteFiles = await fxGit(['-C', bare, 'ls-tree', '--name-only', 'main']);
    expect(remoteFiles.stdout).toContain('vault.json');

    // Registered and active.
    const config = machineConfig('init');
    expect(config.active).toBe('personal');
    expect((config.vaults as Record<string, string>).personal.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'));
    expect(config.clone_root).toBeUndefined();
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

  // No terminal to ask on: the refusal names exactly the values still missing.
  it('refuses without a terminal, naming what to pass', async () => {
    const env = isolated('no-tty');
    const both = await runYan(home, ['vault', 'init'], env);
    expect(both.code).toBe(2);
    expect(both.out).toContain('missing required options; pass:');
    expect(both.out).toContain('<name> <value>');
    expect(both.out).toContain('--remote <value>');

    const remoteOnly = await runYan(home, ['vault', 'init', 'named'], env);
    expect(remoteOnly.code).toBe(2);
    expect(remoteOnly.out).toContain('missing required option; pass:');
    expect(remoteOnly.out).not.toContain('<name> <value>');

    const clone = await runYan(home, ['vault', 'clone'], env);
    expect(clone.code).toBe(2);
    expect(clone.out).toContain('<url> <value>');
    expect(machineConfig('no-tty').vaults).toBeUndefined();
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

  it('refuses a version 1 vault and names the migration', async () => {
    const bare = await mkEmptyRemote(join(tmp, 'old.git'));
    const env = { ...isolated('old'), ...identity };
    const dir = join(tmp, 'vaults', 'old');
    await runYan(home, ['vault', 'init', 'old', '--remote', bare, '--path', dir], env);

    writeFileSync(join(dir, 'vault.json'), `${JSON.stringify({ version: 1, name: 'old' }, null, 2)}\n`);
    const r = await runYan(home, ['ls'], env);
    expect(r.code).toBe(1);
    expect(r.out).toContain('migrate-v4.mjs');
  });
});

describe('pull and push', () => {
  /** Two machines on one vault: the pair `yan vault pull` exists for. */
  async function twoMachines(name: string): Promise<{ a: string; b: string; env: Record<string, string | undefined> }> {
    const bare = await mkEmptyRemote(join(tmp, `${name}.git`));
    const env = { ...isolated(name), ...identity };
    const a = join(tmp, 'vaults', `${name}-a`);
    await runYan(home, ['vault', 'init', name, '--remote', bare, '--path', a], env);

    const second = { ...isolated(`${name}-b`), ...identity };
    const b = join(tmp, 'vaults', `${name}-b`);
    await runYan(home, ['vault', 'clone', bare, '--path', b], second);
    return { a, b, env: second };
  }

  it('push commits what changed under a message made of task ids, and pull brings it to the other machine', async () => {
    const { a, b, env } = await twoMachines('shared-work');
    const onA = { ...isolated('shared-work'), ...identity };

    mkdirSync(join(a, 'tasks', 't042'), { recursive: true });
    writeFileSync(join(a, 'tasks', 't042', 'task.json'), '{"version":2,"id":"t042","title":"x","state":"open","nextDeliverable":1,"deliverables":[]}\n');
    writeFileSync(join(a, 'tasks', 't042', 'log.md'), '- 10-01  agreed   x\n');

    const pushed = await runYan(home, ['vault', 'push'], { ...onA, YAN_VAULT: a });
    expect(pushed.code, pushed.out).toBe(0);
    expect(pushed.stdout).toContain('committed 2 change(s)');

    const subject = (await fxGit(['-C', a, 'log', '-1', '--pretty=%s'])).stdout.trim();
    expect(subject, 'the ids are what a person scans the history for').toBe('t042');

    const pulled = await runYan(home, ['vault', 'pull'], { ...env, YAN_VAULT: b });
    expect(pulled.code, pulled.out).toBe(0);
    expect(pulled.stdout).toContain('caught up');
    expect(existsSync(join(b, 'tasks', 't042', 'task.json'))).toBe(true);

    // Twice is a no-op, and says so rather than inventing a commit.
    const again = await runYan(home, ['vault', 'pull'], { ...env, YAN_VAULT: b });
    expect(again.stdout).toContain('already up to date');
  });

  it('refuses to rebase a dirty vault, and names what is dirty', async () => {
    const { b, env } = await twoMachines('dirty');
    writeFileSync(join(b, 'tasks', 'scratch.md'), 'half-written\n');

    const r = await runYan(home, ['vault', 'pull'], { ...env, YAN_VAULT: b });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain('uncommitted changes');
    expect(r.stdout, 'which file, so the reader does not have to go looking').toContain('scratch.md');
  });
});

describe('clone, ls and use', () => {
  it('clones a vault, takes its own name, and makes it active', async () => {
    const bare = await mkEmptyRemote(join(tmp, 'shared.git'));
    const first = { ...isolated('machine-a'), ...identity };
    await runYan(home, ['vault', 'init', 'shared', '--remote', bare, '--path', join(tmp, 'vaults', 'shared-a')], first);

    const second = { ...isolated('machine-b'), ...identity };
    const dir = join(tmp, 'vaults', 'shared-b');
    const r = await runYan(home, ['vault', 'clone', bare, '--path', dir], second);
    expect(r.code).toBe(0);
    expect(r.out).toContain('(active)');
    expect(machineConfig('machine-b').active).toBe('shared');
    expect(existsSync(join(dir, 'vault.json'))).toBe(true);
  });

  it('switches with `yan vault use`, and refuses a name it does not know', async () => {
    const env = { ...isolated('switch'), ...identity };
    await runYan(home, ['vault', 'init', 'one', '--remote', await mkEmptyRemote(join(tmp, 'one.git')), '--path', join(tmp, 'vaults', 'one')], env);
    await runYan(home, ['vault', 'init', 'two', '--remote', await mkEmptyRemote(join(tmp, 'two.git')), '--path', join(tmp, 'vaults', 'two')], env);
    expect(machineConfig('switch').active).toBe('two');

    const back = await runYan(home, ['vault', 'use', 'one'], env);
    expect(back.code).toBe(0);
    expect(machineConfig('switch').active).toBe('one');

    const listed = await runYan(home, ['vault', 'ls'], env);
    expect(listed.stdout).toContain('* one');
    expect(listed.stdout).toContain('two');

    const nope = await runYan(home, ['vault', 'use', 'three'], env);
    expect(nope.code).not.toBe(0);
    expect(nope.out).toContain('no such vault: three');
    expect(nope.out).toContain('one, two');
  });
});
