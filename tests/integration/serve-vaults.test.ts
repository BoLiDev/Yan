import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkEmptyRemote, mkTempDir, mkYanHome } from '../helpers/fixtures.js';

/**
 * `yan serve` on a machine with several vaults: one page for them all. What
 * matters is that the list is every vault's, that a task id two vaults have
 * is the earlier vault's, and that whatever the page asks or changes of a
 * task lands in the vault that task is in.
 */

let server: ChildProcess | undefined;
let port = 0;
let home = '';
let team = '';
let work = '';
let bare = '';

const page = (path: string): string => `http://localhost:${port}${path}`;
const post = (path: string, value: unknown): Promise<Response> =>
  fetch(page(path), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: page('') }, body: JSON.stringify(value) });

function write(dir: string, rel: string, body: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

const task = (id: string, title: string): string =>
  JSON.stringify({ version: 2, id, title, state: 'open', repos: [], nextDeliverable: 2, deliverables: [{ id: 'd1', text: 'it works', status: 'todo' }], resources: {} });

async function until<T>(what: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await what();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function freePorts(): Promise<number> {
  const taken = (p: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(true));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(false)));
    });
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 20_000);
    if (!(await taken(p)) && !(await taken(p + 1))) return p;
  }
}

interface Shown {
  tasks: { id: string; title: string; vault?: string }[];
  status: { local: boolean; vaults?: { name: string; local: boolean; origin: boolean }[] };
}
const index = async (): Promise<Shown> => (await (await fetch(page('/api/index'))).json()) as Shown;

/** A vault of its own at `dir`, a git repository with what `put` holds committed. */
async function vault(dir: string, name: string, put: Record<string, string>): Promise<void> {
  write(dir, 'vault.json', `${JSON.stringify({ version: 2, name, created: '2026-01-01' })}\n`);
  for (const [rel, body] of Object.entries(put)) write(dir, rel, body);
  await fxGit(['init', '-q', '--initial-branch=main'], dir);
  await fxGit(['add', '-A'], dir);
  await fxGit(['commit', '-q', '-m', 'seed'], dir);
}

beforeAll(async () => {
  const root = mkTempDir('yan-serve-vaults-');
  home = mkYanHome(join(root, 'home'), { withDist: true, activate: false });
  team = join(root, 'team');
  work = join(root, 'work');
  bare = await mkEmptyRemote(join(root, 'team.git'));
  await vault(team, 'team', { 'tasks/t001/task.json': task('t001', 'the team\'s first'), 'tasks/t001/artifacts/docs/plan.md': 'the team\'s plan\n' });
  await fxGit(['remote', 'add', 'origin', bare], team);
  await fxGit(['push', '-q', '-u', 'origin', 'main'], team);
  await vault(work, 'work', {
    'tasks/t001/task.json': task('t001', 'hidden behind the team\'s'),
    'tasks/t005/task.json': task('t005', 'kept at work'),
    'tasks/t005/artifacts/docs/notes.md': 'notes kept at work\n',
  });
  const machine = join(root, 'machine');
  write(machine, 'config.json', JSON.stringify({ version: 1, vaults: [{ name: 'team', path: team, type: 'remote' }, { name: 'work', path: work, type: 'local' }], clones: {} }));

  port = await freePorts();
  const env = { ...process.env, YAN_HOME: home, YAN_MACHINE_DIR: machine };
  delete (env as Record<string, string | undefined>).YAN_VAULT;
  server = spawn(process.execPath, [join(home, 'bin', 'yan.mjs'), 'serve', '--no-open', '--port', String(port), '--every', '2', '--no-janus'], { env, windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    server?.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('Ctrl+C to stop')) resolve();
    });
    server?.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    server?.once('exit', (code) => reject(new Error(`yan serve exited ${code}: ${out}`)));
  });
});

afterAll(async () => {
  if (server !== undefined && server.exitCode === null) {
    const gone = new Promise((resolve) => server?.once('exit', resolve));
    server.kill();
    await gone;
  }
  cleanupTempDirs();
});

describe('yan serve over several vaults', () => {
  it('lists the tasks of them all as one, each named with its vault, a shared id being the earlier vault\'s', async () => {
    const shown = await index();
    expect(shown.tasks.map((t) => [t.id, t.title, t.vault])).toEqual([['t001', 'the team\'s first', 'team'], ['t005', 'kept at work', 'work']]);
    expect(shown.status.vaults?.map((v) => [v.name, v.local])).toEqual([['team', false], ['work', true]]);
    expect(shown.status.local, 'not local as a whole while one of them is kept in step').toBe(false);
  });

  it('answers for a task, its files included, from the vault it is in', async () => {
    const theirs = (await (await fetch(page('/api/task/t005'))).json()) as { title: string; files: { path: string; sha: string }[] };
    expect(theirs.title).toBe('kept at work');
    const notes = theirs.files.find((f) => f.path === 'docs/notes.md');
    expect(await (await fetch(page(`/blob/${notes?.sha}`))).text()).toBe('notes kept at work\n');
    expect(await (await fetch(`http://localhost:${port + 1}/tasks/t005/artifacts/docs/notes.md`)).text()).toBe('notes kept at work\n');
    expect(await (await fetch(`http://localhost:${port + 1}/tasks/t001/artifacts/docs/plan.md`)).text()).toBe('the team\'s plan\n');
    expect(((await (await fetch(page('/api/task/t001'))).json()) as { title: string }).title).toBe('the team\'s first');
  });

  it('changes a task in its own vault and no other: the local one committed there, the shared one pushed to its origin', async () => {
    expect((await post('/api/task/title', { task: 't005', title: 'kept at work, renamed' })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(work, 'tasks', 't005', 'task.json'), 'utf8'))).toMatchObject({ title: 'kept at work, renamed' });
    expect((await fxGit(['-C', work, 'log', '-1', '--pretty=%s'])).stdout.trim()).toBe('t005: renamed in yan serve');
    expect((await fxGit(['-C', team, 'log', '-1', '--pretty=%s'])).stdout.trim(), 'the other vault untouched').toBe('seed');

    expect((await post('/api/task/title', { task: 't001', title: 'the team\'s first, renamed' })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(work, 'tasks', 't001', 'task.json'), 'utf8')).title, 'the hidden one of the same id is left alone').toBe('hidden behind the team\'s');
    await until(async () => ((await fxGit(['-C', bare, 'log', '-1', '--pretty=%s', 'main'])).stdout.trim() === 't001: renamed in yan serve' ? true : undefined));
    await until(async () => ((await index()).tasks.find((t) => t.id === 't001')?.title === 'the team\'s first, renamed' ? true : undefined));
  });

  it('shows what is written in the local vault as it is written, and keeps each vault local or not by itself', async () => {
    write(work, 'tasks/t005/artifacts/docs/just-written.md', 'mid-turn\n');
    await until(async () => (JSON.stringify(await (await fetch(page('/api/task/t005'))).json()).includes('just-written.md') ? true : undefined), 8_000);

    const kept = (await (await post('/api/vault/local', { local: true, vault: 'team' })).json()) as Shown['status'];
    expect(kept.vaults?.map((v) => [v.name, v.local])).toEqual([['team', true], ['work', true]]);
    expect(kept.local).toBe(true);
    expect((await post('/api/vault/local', { local: true, vault: 'nobody' })).status).toBe(404);
    const back = (await (await post('/api/vault/local', { local: false, vault: 'team' })).json()) as Shown['status'];
    expect(back.vaults?.map((v) => [v.name, v.local])).toEqual([['team', false], ['work', true]]);
  });
});
