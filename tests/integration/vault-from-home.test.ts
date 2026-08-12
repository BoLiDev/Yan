import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkEmptyRemote,
  mkTempDir,
  mkYanHome,
  runYan,
} from '../helpers/fixtures.js';

/**
 * `yan vault init --from-home` (v3 td migration.md).
 *
 * The migration is a command because it is the test: V3 claims the three
 * layers separate cleanly, and moving real tasks, a real registry, a real
 * config and a real clone out of a real home is the only honest way to find
 * out. What is checked here is what a person would check — the tasks arrive,
 * the registry splits, the clone moves, and the old copy is still there until
 * someone says otherwise — plus the two refusals that exist so nobody has to
 * check anything afterwards.
 */

afterEach(cleanupTempDirs);

let tmp = '';
let home = '';

const identity = {
  GIT_AUTHOR_NAME: 'yan tests',
  GIT_AUTHOR_EMAIL: 'yan-tests@localhost',
  GIT_COMMITTER_NAME: 'yan tests',
  GIT_COMMITTER_EMAIL: 'yan-tests@localhost',
};

/** A pre-V3 home: tasks under tasks/, a registry in mem/, clones in repos/. */
async function legacyHome(): Promise<{ clone: string; bare: string }> {
  const bare = await mkBareRemote(join(tmp, 'demo.git'));
  const clone = await mkClone(bare, join(home, 'repos', 'demo'));

  writeFileSync(
    join(home, 'mem', 'repos.json'),
    `${JSON.stringify({ version: 1, demo: { url: bare, mode_default: 'branch', pool_size: 3 } }, null, 2)}\n`,
  );
  writeFileSync(join(home, 'mem', 'user.md'), 'prefers short briefs\n');

  for (const [id, title] of [['t001', 'the first one'], ['t002', 'the second']]) {
    const dir = join(home, 'tasks', id);
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    mkdirSync(join(dir, 'shifts', 's1'), { recursive: true });
    writeFileSync(
      join(dir, 'task.json'),
      `${JSON.stringify({ version: 1, id, title, complete: false, units: [{ name: 'u', repo: 'demo', scope: [], needs: [], branch: `yan/${id}-u-r1`, target: 'main', mode: 'mr', mr: null, history: [] }] }, null, 2)}\n`,
    );
    writeFileSync(join(dir, 'log.md'), `# ${id} ${title}\n`);
    writeFileSync(join(dir, 'brief.md'), 'the contract\n');
    writeFileSync(join(dir, 'artifacts', 'note.md'), 'a thing a person looks at\n');
    writeFileSync(join(dir, 'shifts', 's1', 'outcome.md'), 'what was tried\n');
  }
  return { clone, bare };
}

/** The state that must survive: a run/ directory nobody should carry over. */
function staleRun(id: string): void {
  const run = join(home, 'tasks', id, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'beacon'), 'stale\n');
}

beforeEach(() => {
  tmp = mkTempDir('yan-migrate-');
  home = mkYanHome(join(tmp, 'home'), { withDist: true, activate: false });
  // The fixture builds a V3 home; this test needs the V2 one it replaced.
  writeFileSync(join(home, 'vault.json'), '');
});

async function init(extra: readonly string[] = []): Promise<{ code: number; out: string; vault: string; cloneRoot: string }> {
  const remote = await mkEmptyRemote(join(tmp, 'vault.git'));
  const vault = join(tmp, 'vault');
  const cloneRoot = join(tmp, 'code');
  const r = await runYan(
    home,
    ['vault', 'init', 'personal', '--remote', remote, '--path', vault, '--clone-root', cloneRoot, '--from-home', ...extra],
    { ...identity, YAN_VAULT: undefined, YAN_MACHINE_DIR: join(tmp, 'machine') },
  );
  return { code: r.code, out: r.out, vault, cloneRoot };
}

describe('what comes across', () => {
  it('moves the tasks, splits the registry, and moves the clone', async () => {
    await legacyHome();
    staleRun('t001');

    const { code, out, vault, cloneRoot } = await init();
    expect(code, out).toBe(0);

    // Tasks, with everything a task carries.
    for (const id of ['t001', 't002']) {
      expect(existsSync(join(vault, 'tasks', id, 'task.json')), id).toBe(true);
      expect(existsSync(join(vault, 'tasks', id, 'log.md'))).toBe(true);
      expect(existsSync(join(vault, 'tasks', id, 'artifacts', 'note.md'))).toBe(true);
      // The asset V3 exists to keep: what a shift found.
      expect(existsSync(join(vault, 'tasks', id, 'shifts', 's1', 'outcome.md'))).toBe(true);
    }
    // …but not the throwaway layer. Committing pane ids would make one
    // machine's session state look authoritative on another.
    expect(existsSync(join(vault, 'tasks', 't001', 'run'))).toBe(false);

    expect(readFileSync(join(vault, 'mem', 'user.md'), 'utf8')).toContain('short briefs');
    expect(existsSync(join(vault, 'mem', 'repos.json')), 'the old registry does not travel whole').toBe(false);

    // The registry, in two halves that mean different things.
    const portable = JSON.parse(readFileSync(join(vault, 'repos.json'), 'utf8')) as Record<string, { pool_size?: number; mode_default?: string }>;
    expect(portable.demo?.pool_size, 'tuning follows the repository').toBe(3);
    expect(portable.demo?.mode_default).toBe('branch');
    expect(JSON.stringify(portable)).not.toContain('path');

    const local = JSON.parse(readFileSync(join(vault, '.local', 'repos.json'), 'utf8')) as Record<string, { path?: string }>;
    expect(local.demo?.path?.toLowerCase()).toBe(join(cloneRoot, 'demo').replace(/\\/g, '/').toLowerCase());

    // The clone really moved, and it is still a clone.
    expect(existsSync(join(cloneRoot, 'demo', '.git'))).toBe(true);
    expect(existsSync(join(home, 'repos', 'demo'))).toBe(false);

    // The config followed the context.
    const config = JSON.parse(readFileSync(join(vault, 'config.json'), 'utf8')) as { remote_git?: { kind?: string } };
    expect(config.remote_git?.kind).toBe('github');
  });

  it('leaves the old home alone until it is told otherwise, and yan reads the vault', async () => {
    await legacyHome();
    const { code, out, vault } = await init();
    expect(code, out).toBe(0);

    // Additive: the migration is undone by deleting one directory.
    expect(existsSync(join(home, 'tasks', 't001', 'task.json'))).toBe(true);
    expect(out).toContain('--drop-home');

    // And the tasks yan now lists are the vault's.
    const listed = await runYan(home, ['ls'], { YAN_VAULT: vault, YAN_MACHINE_DIR: join(tmp, 'machine') });
    expect(listed.code, listed.out).toBe(0);
    expect(listed.stdout).toContain('t001');
    expect(listed.stdout).toContain('t002');
  });

  it('drop-home runs afterwards too, and refuses while anything is only in the home', async () => {
    await legacyHome();
    const { code, out, vault } = await init();
    expect(code, out).toBe(0);
    const env = { YAN_VAULT: vault, YAN_MACHINE_DIR: join(tmp, 'machine') };

    // Something the vault does not have: looking takes longer than one command,
    // so the check has to be re-run rather than trusted from the first pass.
    mkdirSync(join(home, 'tasks', 't003'), { recursive: true });
    writeFileSync(join(home, 'tasks', 't003', 'task.json'), '{"version":1,"id":"t003","title":"later","complete":false,"units":[]}\n');

    const refused = await runYan(home, ['vault', 'drop-home'], env);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain('task t003');
    expect(existsSync(join(home, 'tasks', 't001')), 'nothing was removed').toBe(true);

    // With it accounted for, the same command clears the old layout.
    cpSync(join(home, 'tasks', 't003'), join(vault, 'tasks', 't003'), { recursive: true });
    const dropped = await runYan(home, ['vault', 'drop-home'], env);
    expect(dropped.code, dropped.out).toBe(0);
    expect(existsSync(join(home, 'tasks'))).toBe(false);
    expect(existsSync(join(home, 'repos'))).toBe(false);
  });

  it('--drop-home removes the old copies and says where they went', async () => {
    await legacyHome();
    const { code, out, vault } = await init(['--drop-home']);
    expect(code, out).toBe(0);

    for (const rel of ['tasks', 'mem', 'repos', join('conf', 'config.json')]) {
      expect(existsSync(join(home, rel)), rel).toBe(false);
    }
    const note = JSON.parse(readFileSync(join(home, '.migrated.json'), 'utf8')) as { vault?: string };
    expect(note.vault?.toLowerCase()).toBe(vault.replace(/\\/g, '/').toLowerCase());
  });
});

describe('what it refuses, before anything moves', () => {
  it('refuses while a shift is live, and writes no vault', async () => {
    await legacyHome();
    mkdirSync(join(home, 'tasks', 't001', 'shifts', 's1', 'run'), { recursive: true });
    writeFileSync(join(home, 'tasks', 't001', 'shifts', 's1', 'run', 'meta.json'), '{"version":1}\n');

    const { code, out, vault } = await init();
    expect(code).not.toBe(0);
    expect(out).toContain('t001/s1 is still live');
    expect(existsSync(join(vault, 'vault.json')), 'a refusal leaves nothing to clean up').toBe(false);
    expect(existsSync(join(home, 'repos', 'demo')), 'and moves nothing').toBe(true);
  });

  it('refuses when the destination for a clone is already taken', async () => {
    await legacyHome();
    mkdirSync(join(tmp, 'code', 'demo'), { recursive: true });
    writeFileSync(join(tmp, 'code', 'demo', 'something.txt'), 'in the way\n');

    const { code, out } = await init();
    expect(code).not.toBe(0);
    expect(out).toContain('never merges two clones');
    expect(existsSync(join(home, 'repos', 'demo'))).toBe(true);
  });

  it('refuses while the pool holds a tree for a clone that would move', async () => {
    const { clone } = await legacyHome();
    const poolRoot = join(tmp, 'trees');
    await fxGit(['-C', clone, 'branch', 'integ']);

    const leased = await runYan(
      home,
      ['tree', 'get', '--repo', clone, '--base', 'integ', '--branch', 's1', '--holder', 't/u/s1'],
      { YAN_POOL_ROOT: poolRoot, YAN_VAULT: undefined, YAN_MACHINE_DIR: join(tmp, 'machine') },
    );
    expect(leased.code, leased.out).toBe(0);

    const remote = await mkEmptyRemote(join(tmp, 'vault.git'));
    const r = await runYan(
      home,
      ['vault', 'init', 'personal', '--remote', remote, '--path', join(tmp, 'vault'), '--clone-root', join(tmp, 'code'), '--from-home'],
      { ...identity, YAN_POOL_ROOT: poolRoot, YAN_VAULT: undefined, YAN_MACHINE_DIR: join(tmp, 'machine') },
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('leased tree');
    expect(r.out, 'the pool is keyed by the path, so the fix is to give the tree back').toContain('yan tree return');
    expect(existsSync(join(home, 'repos', 'demo'))).toBe(true);
  });
});
