import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkClone, mkEmptyRemote, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';

/**
 * `yan serve` through `bin/yan.mjs`, against a vault with an origin: what the
 * page asks for, what the files port hands out, and a push to origin turning
 * up without anyone reloading.
 */

let home = '';
let bare = '';
let port = 0;
let server: ChildProcess | undefined;
const page = (path: string): string => `http://localhost:${port}${path}`;
const files = (path: string): string => `http://localhost:${port + 1}${path}`;

afterAll(async () => {
  if (server !== undefined && server.exitCode === null) {
    const gone = new Promise((resolve) => server?.once('exit', resolve));
    server.kill();
    await gone;
    // Its `git cat-file` ends when its stdin does; give it the moment Windows needs.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  cleanupTempDirs();
});

/** Two free ports in a row: the page's and the files'. */
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

function write(dir: string, rel: string, body: string | Buffer): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

const task = (id: string, title: string): string =>
  JSON.stringify({ version: 2, id, title, state: 'open', repos: [], nextDeliverable: 2, deliverables: [{ id: 'd1', text: 'it works', status: 'todo' }], resources: {} });

async function until<T>(what: () => Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await what();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  const root = mkTempDir('yan-serve-it-');
  home = mkYanHome(join(root, 'home'), { withDist: true });
  bare = await mkEmptyRemote(join(root, 'vault.git'));
  write(home, 'tasks/t001/task.json', task('t001', 'first'));
  write(home, 'tasks/t001/problem.md', '# first\n\nThe problem.\n');
  write(home, 'tasks/t001/artifacts/c4/shot-1280.png', Buffer.from('not really a png'));
  write(home, 'tasks/t001/artifacts/clip.webm', Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  write(home, 'tasks/t001/artifacts/page/index.html', '<!doctype html><img src="./pic.png">');
  write(home, 'tasks/t001/artifacts/page/pic.png', 'pic');
  await fxGit(['init', '-q', '--initial-branch=main'], home);
  await fxGit(['add', 'vault.json', 'tasks'], home);
  await fxGit(['commit', '-q', '-m', 'seed'], home);
  await fxGit(['remote', 'add', 'origin', bare], home);
  await fxGit(['push', '-q', '-u', 'origin', 'main'], home);

  port = await freePorts();
  server = spawn(process.execPath, [join(home, 'bin', 'yan.mjs'), 'serve', '--no-open', '--port', String(port), '--every', '2'], {
    env: { ...process.env, YAN_HOME: home, YAN_VAULT: home, YAN_MACHINE_DIR: join(home, '.machine') },
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    server?.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('serving')) resolve();
    });
    server?.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    server?.once('exit', (code) => reject(new Error(`yan serve exited ${code}: ${out}`)));
  });
});

describe('yan serve', () => {
  it('serves the page and an index of every task', async () => {
    expect(await (await fetch(page('/'))).text()).toContain('id="app"');
    const index = (await (await fetch(page('/api/index'))).json()) as { tasks: { id: string; artifacts: number }[]; latest: unknown[]; filesOrigin: string; status: { ok: boolean } };
    expect(index.tasks.map((t) => [t.id, t.artifacts])).toEqual([['t001', 4]]);
    expect(index.latest).toHaveLength(1);
    expect(index.filesOrigin).toBe(`http://localhost:${port + 1}`);
    expect(index.status.ok).toBe(true);
  });

  it('gives a task its problem, deliverables and files', async () => {
    const t = (await (await fetch(page('/api/task/t001'))).json()) as { problem: { text: string }; deliverables: { id: string }[]; files: { path: string }[] };
    expect(t.problem.text).toContain('The problem.');
    expect(t.deliverables.map((d) => d.id)).toEqual(['d1']);
    expect(t.files.map((f) => f.path)).toEqual(['c4/shot-1280.png', 'clip.webm', 'page/index.html', 'page/pic.png']);
    expect((await fetch(page('/api/task/t404'))).status).toBe(404);
  });

  it('hands out a video in pieces, so it can be played and sought', async () => {
    const r = await fetch(files('/tasks/t001/artifacts/clip.webm'), { headers: { Range: 'bytes=10-19' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-type')).toBe('video/webm');
    expect(r.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('serves a page by its path, so what it links beside it loads, and revalidates by sha', async () => {
    const r = await fetch(files('/tasks/t001/artifacts/page/index.html'));
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const etag = r.headers.get('etag') ?? '';
    expect((await fetch(files('/tasks/t001/artifacts/page/index.html'), { headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect(await (await fetch(files('/tasks/t001/artifacts/page/pic.png'))).text()).toBe('pic');
    expect((await fetch(files('/tasks/t001/nope.png'))).status).toBe(404);
  });

  it('answers only to localhost by name', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port, path: '/api/index', agent: false, headers: { Host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', () => resolve(0))
        .end();
    });
    expect(status).toBe(403);
  });

  it('shows what was pushed to origin within a tick, and says so on the event stream', async () => {
    const before = (await (await fetch(page('/api/index'))).json()) as { status: { version: number } };
    const events = await fetch(page('/api/events'));
    const reader = events.body?.getReader();

    const elsewhere = await mkClone(bare, join(mkTempDir('yan-serve-other-'), 'vault'));
    write(elsewhere, 'tasks/t001/artifacts/c4/shot-390.png', 'phone');
    await fxGit(['add', 'tasks'], elsewhere);
    await fxGit(['commit', '-q', '-m', 'more'], elsewhere);
    await fxGit(['push', '-q', 'origin', 'main'], elsewhere);

    const index = await until(async () => {
      const i = (await (await fetch(page('/api/index'))).json()) as { status: { version: number }; tasks: { artifacts: number }[] };
      return i.status.version > before.status.version ? i : undefined;
    }, 20_000);
    expect(index.tasks[0]?.artifacts).toBe(5);

    let seen = '';
    const decoder = new TextDecoder();
    while (!seen.includes(`"version":${index.status.version}`)) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
      seen += decoder.decode(chunk.value);
    }
    expect(seen).toContain('event: status');
    expect(seen).toContain(`"version":${index.status.version}`);
    await reader?.cancel();
  });

  it('opens the one already running rather than starting another', async () => {
    const r = await runYan(home, ['serve', '--no-open', '--port', String(port)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`already serving at http://localhost:${port}`);
  });
});
