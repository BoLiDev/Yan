import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkTempDir, repoRoot, type RunResult } from '../helpers/fixtures.js';

/**
 * `scripts/migrate-v4.mjs` against `tests/fixtures/v3-vault`, a v3 vault with
 * one of each thing v4 drops or moves, and a v3 pool holding a standing tree
 * and a shift's tree.
 */

afterAll(cleanupTempDirs);

function migrate(args: readonly string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'migrate-v4.mjs'), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr, out: stdout + stderr }));
  });
}

const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/** The fixture as a committed vault, registered on a machine of its own. */
async function aV3Machine(): Promise<{ vault: string; machine: string; env: Record<string, string> }> {
  const root = realpathSync(mkTempDir('yan-migrate-'));
  const vault = join(root, 'vault');
  cpSync(join(repoRoot, 'tests', 'fixtures', 'v3-vault'), vault, { recursive: true });
  await fxGit(['init', '-q', '-b', 'main'], vault);
  await fxGit(['add', '-A'], vault);
  await fxGit(['commit', '-q', '-m', 'v3'], vault);
  const machine = join(root, 'machine');
  mkdirSync(machine, { recursive: true });
  writeFileSync(join(machine, 'config.json'), JSON.stringify({ version: 1, active: 'fx', vaults: { fx: vault }, clone_root: root }));
  return {
    vault,
    machine,
    env: { YAN_MACHINE_DIR: machine, YAN_OLD_POOL_ROOT: join(root, '.yan-trees'), YAN_POOL_ROOT: '' },
  };
}

describe('a dry run', () => {
  it('reports what it would do and writes nothing', async () => {
    const { vault, env } = await aV3Machine();
    const r = await migrate(['--dry-run'], env);
    expect(r.out).toContain('dry run');
    expect(r.out).toContain('t007: deliverable.json could not be read');
    expect((await fxGit(['status', '--porcelain'], vault)).stdout).toBe('');
  });
});

describe('a vault', () => {
  it('becomes version 2, every task with it', async () => {
    const { vault, machine, env } = await aV3Machine();
    const r = await migrate([], env);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('3 thing(s) to look at');

    expect(read(join(vault, 'vault.json')).version).toBe(2);
    expect(read(join(vault, 'config.json'))).toEqual({ cli: 'codex', model: 'gpt-5', effort: 'high' });
    expect(read(join(machine, 'config.json')).clone_root).toBeUndefined();
    for (const gone of ['repos.json', '.local', 'skills', 'hooks', 'mem']) expect(existsSync(join(vault, gone)), gone).toBe(false);
    expect(existsSync(join(vault, 'learnings', 'folder-trust.md'))).toBe(true);

    expect(read(join(vault, 'tasks', 't002', 'task.json'))).toMatchObject({
      version: 2,
      state: 'done',
      closedAt: '2026-08-20T12:00:00Z',
      repo: 'https://gitlab.acme.internal/acme/ledger.git',
      nextDeliverable: 5,
    });
    expect(read(join(vault, 'tasks', 't005', 'task.json')).state).toBe('abandoned');
    expect(read(join(vault, 'tasks', 't001', 'task.json')).repo).toBe('git@github.com:acme/site.git');
    expect(existsSync(join(vault, 'tasks', 't002', 'deliverable.json'))).toBe(false);
    expect(existsSync(join(vault, 'tasks', 't007', 'deliverable.json.unmigrated'))).toBe(true);
    expect(readFileSync(join(vault, 'tasks', 't008', 'task.json'), 'utf8')).toContain('this is not json');

    // The title line goes, BOM and all; the rest of the brief stays.
    expect(readFileSync(join(vault, 'tasks', 't001', 'brief.md'), 'utf8')).toMatch(/^The site has no page/);
    expect(readFileSync(join(vault, 'tasks', 't003', 'brief.md'), 'utf8')).toMatch(/^## Description/);

    expect(existsSync(join(vault, 'tasks', 't001', 'drafts', '2026-09-01_120000-parser-ideas.md'))).toBe(true);
    expect(existsSync(join(vault, 'tasks', 't001', 'artifacts'))).toBe(false);
    expect(existsSync(join(vault, 'tasks', 't001', 'run'))).toBe(false);
    expect(existsSync(join(vault, 'tasks', 't002', 'shifts', 's1', 'run'))).toBe(false);
    expect(existsSync(join(vault, 'tasks', 't002', 'shifts', 's1', 'outcome.md'))).toBe(true);
    expect(existsSync(join(vault, 'tasks', 't002', 'artifacts', 'notes.md'))).toBe(true);

    // Run again, nothing left to do.
    const again = await migrate([], env);
    expect(again.out).toContain('already version 2');
  });

  it('refuses a vault with uncommitted changes to tracked files, and changes nothing', async () => {
    const { vault, env } = await aV3Machine();
    writeFileSync(join(vault, 'tasks', 't001', 'brief.md'), 'edited\n');
    const r = await migrate([], env);
    expect(r.out).toContain('has uncommitted changes');
    expect(read(join(vault, 'vault.json')).version).toBe(1);
  });

  it('migrates a task git does not track yet, and says git cannot undo it there', async () => {
    const { vault, env } = await aV3Machine();
    cpSync(join(vault, 'tasks', 't002'), join(vault, 'tasks', 't011'), { recursive: true });
    writeFileSync(join(vault, 'tasks', 't011', 'task.json'), JSON.stringify({ ...read(join(vault, 'tasks', 't002', 'task.json')), id: 't011' }));
    const r = await migrate([], env);
    expect(r.out).toContain('git does not track yet (tasks/t011/)');
    expect(read(join(vault, 'tasks', 't011', 'task.json'))).toMatchObject({ version: 2, id: 't011' });
  });
});

describe('the pool', () => {
  it('moves under the machine directory, keeps git linked, and leases a task', async () => {
    const { machine, env } = await aV3Machine();
    const bare = await mkBareRemote(join(mkTempDir(), 'origin.git'));
    const clone = realpathSync(await mkClone(bare, join(mkTempDir(), 'demo')));

    // A v3 pool: a standing tree held by t001/site, and a shift's tree whose
    // work is pushed.
    const old = env.YAN_OLD_POOL_ROOT as string;
    const poolDir = join(old, 'demo-abcd1234');
    mkdirSync(join(poolDir, 'leases'), { recursive: true });
    for (const [slot, branch, holder] of [[1, 'yan/t001-site-r1', 't001/site'], [2, 'yan/t001-site-s1', 't001/site/s1']] as const) {
      const tree = join(poolDir, String(slot), 'demo');
      await fxGit(['worktree', 'add', '-b', branch, tree, 'origin/main'], clone);
      await fxGit(['push', '-u', 'origin', branch], tree);
      writeFileSync(join(poolDir, 'leases', `${slot}.json`), JSON.stringify({ version: 1, slot, path: tree, branch, base: 'main', holder, lease_id: 'x', at: 0, pid: 0 }));
    }
    mkdirSync(join(poolDir, '1', 'demo', 'node_modules'), { recursive: true });

    const r = await migrate([], env);
    expect(r.out).toContain('repairing git links');

    const moved = join(machine, 'trees', 'demo-abcd1234');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(moved, '1', 'demo', 'node_modules'))).toBe(true);
    const listed = (await fxGit(['worktree', 'list', '--porcelain'], clone)).stdout;
    expect(listed).toContain(join(moved, '1', 'demo'));
    expect((await fxGit(['status', '--porcelain'], join(moved, '1', 'demo'))).code).toBe(0);

    expect(read(join(moved, 'leases', '1.json'))).toMatchObject({ holder: 't001', path: join(moved, '1', 'demo') });
    expect(existsSync(join(moved, 'leases', '2.json')), "a shift's pushed tree is returned").toBe(false);
  });
});
