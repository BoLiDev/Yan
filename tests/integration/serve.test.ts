import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkClone, mkEmptyRemote, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { readJson } from '../../src/util/json.js';

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

  it("serves highlight.js and its languages one by one from yan's own copy, and nothing else from there", async () => {
    const core = await fetch(page('/vendor/highlight.js'));
    expect(core.status).toBe(200);
    expect(core.headers.get('content-type')).toContain('javascript');
    expect(await core.text()).toContain('hljs');
    const one = await fetch(page('/vendor/highlight/dockerfile.js'));
    expect(one.status).toBe(200);
    expect(await one.text()).toContain('dockerfile');
    expect((await fetch(page('/vendor/highlight/no-such-language.js'))).status).toBe(404);
    expect((await fetch(page('/vendor/highlight/package.json'))).status).toBe(404);
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

  it('serves the face its page is drawn in', async () => {
    const r = await fetch(page('/fonts/yan-round-regular.woff2'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('font/woff2');
  });

  it('opens the one already running rather than starting another', async () => {
    const r = await runYan(home, ['serve', '--no-open', '--port', String(port)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`already serving at http://localhost:${port}`);
  });
});

describe('a report on yan serve', () => {
  const PAGE = `<!doctype html><html><head><style>body{background:#000}</style></head><body>
<h1 data-yan-edit="title">报告</h1>
<span data-yan-bar="done" style="width:0.00%"></span><span data-yan-bar="abandoned" style="width:0.00%"></span><span data-yan-progress="">0 完成 · 2 待确认 · 0 放弃</span>
<div class="head" data-yan-d="d1" data-yan-status="todo"><h3><span data-yan-edit="summary">一</span></h3><p class="why">放弃：<span data-yan-reason=""></span></p></div>
<div class="head" data-yan-d="d2" data-yan-status="todo"><h3><span data-yan-edit="summary">二</span></h3><p class="why">放弃：<span data-yan-reason=""></span></p></div>
</body></html>`;
  const at = (rel: string): string => join(home, 'tasks/t002', rel);
  const post = (path: string, value: unknown, origin = page('')) =>
    fetch(page(path), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
  type Report = { sha: string; behind: string[]; uat: { path: string; for: string[]; url: string | null }[]; html: string };
  const report = async (): Promise<Report | undefined> => {
    const r = await fetch(page('/api/report?task=t002'));
    return r.ok ? ((await r.json()) as Report) : undefined;
  };

  beforeAll(async () => {
    // Another clone pushed in the tests above; a commit on top of an older one would never be the newest.
    await fxGit(['pull', '-q', '--rebase', 'origin', 'main'], home);
    const shot = Buffer.from('a picture');
    write(home, 'tasks/t002/task.json', JSON.stringify({ version: 2, id: 't002', title: 'report', state: 'open', repos: [], nextDeliverable: 3, resources: {},
      deliverables: [{ id: 'd1', text: 'one', status: 'todo' }, { id: 'd2', text: 'two', status: 'todo' }] }));
    write(home, 'tasks/t002/artifacts/report.html', PAGE);
    write(home, 'tasks/t002/artifacts/uat/d1.png', shot);
    write(home, 'tasks/t002/artifacts/uat/uat.json', JSON.stringify({ version: 1, files: { 'd1.png': { for: ['d1'], shows: 'it' } }, notes: {} }));
    write(home, 'tasks/t002/artifacts/report.json', JSON.stringify({ version: 1, generatedAt: '2026-10-18T12:00:00Z',
      deliverables: [{ id: 'd1', text: 'one', status: 'todo' }, { id: 'd2', text: 'two', status: 'todo' }],
      files: { 'd1.png': { sha256: createHash('sha256').update(shot).digest('hex'), for: ['d1'] } }, notes: {} }));
    await fxGit(['add', 'tasks'], home);
    await fxGit(['commit', '-q', '-m', 'a report'], home);
    await until(report, 20_000);
  });

  it('hands out the page, nothing behind it, and every file in uat/ with what records it', async () => {
    const r = (await report()) as Report;
    expect(r.html).toContain('data-yan-edit="title"');
    expect(r.behind).toEqual([]);
    expect(r.uat).toEqual([expect.objectContaining({ path: 'd1.png', for: ['d1'] })]);
  });

  it('takes a change only from its own page', async () => {
    expect((await post('/api/deliverable', { task: 't002', id: 'd1', to: 'done' }, 'http://evil.example')).status).toBe(403);
    expect((await post('/api/deliverable', { task: 't002', id: 'd1', to: 'abandoned' })).status).toBe(400);
    expect((readJson(at('../t002/task.json')) as { deliverables: { status: string }[] }).deliverables[0]?.status).toBe('todo');
  });

  it('ticks and gives up a deliverable in task.json, commits and pushes it, and hands out the page in that state', async () => {
    expect((await post('/api/deliverable', { task: 't002', id: 'd1', to: 'done' })).status).toBe(200);
    expect((await post('/api/deliverable', { task: 't002', id: 'd2', to: 'abandoned', reason: 'not now' })).status).toBe(200);
    const ds = (readJson(join(home, 'tasks/t002/task.json')) as { deliverables: { status: string; reason?: string }[] }).deliverables;
    expect(ds.map((x) => x.status)).toEqual(['done', 'abandoned']);
    expect((await fxGit(['log', '-1', '--format=%s', 'origin/main'], home)).stdout.trim()).toBe('t002: d2 given up in yan serve');
    expect((await fxGit(['log', '-1', '--format=%s'], bare)).stdout.trim()).toBe('t002: d2 given up in yan serve');

    const copy = await (await fetch(page('/api/report/download?task=t002'))).text();
    expect(copy).toContain('data-yan-d="d1" data-yan-status="done"');
    expect(copy).toContain('data-yan-d="d2" data-yan-status="abandoned"');
    expect(copy).toContain('<span data-yan-reason="">not now</span>');
    expect(copy).toContain('<span data-yan-progress="">1 完成 · 0 待确认 · 1 放弃</span>');
    expect((await report())?.behind).toEqual([]);

    expect((await post('/api/deliverable', { task: 't002', id: 'd2', to: 'todo' })).status).toBe(200);
    expect((readJson(join(home, 'tasks/t002/task.json')) as { deliverables: { status: string }[] }).deliverables[1]).toEqual({ id: 'd2', text: 'two', status: 'todo' });
  });

  it('edits one text of the page in report.html, and refuses an edit made on an older page', async () => {
    const { sha } = (await report()) as Report;
    expect((await post('/api/report/edit', { task: 't002', sha: '0'.repeat(40), index: 0, text: 'x' })).status).toBe(409);
    expect((await post('/api/report/edit', { task: 't002', sha, index: 1, text: '第一 <b>' })).status).toBe(200);
    const html = readFileSync(at('artifacts/report.html'), 'utf8');
    expect(html).toContain('<span data-yan-edit="summary">第一 &lt;b&gt;</span>');
    expect(html.replace('第一 &lt;b&gt;', '一')).toBe(PAGE);
    expect((await fxGit(['log', '-1', '--format=%s'], home)).stdout.trim()).toBe('t002: report edited in yan serve');
    expect((await post('/api/report/edit', { task: 't002', sha: (await report())?.sha, index: 9, text: 'x' })).status).toBe(400);
  });

  it('lists a task waiting to be accepted as 待验收, and puts it back to open when it is not, logging nothing', async () => {
    expect((await runYan(home, ['uat', 'ready', '--task', 't002'])).stdout).toContain('t002  待验收');
    await fxGit(['commit', '-q', '-am', 'ready'], home);
    const state = async (): Promise<string | undefined> => {
      const i = (await (await fetch(page('/api/index'))).json()) as { tasks: { id: string; state: string }[] };
      return i.tasks.find((t) => t.id === 't002')?.state;
    };
    expect(await until(async () => ((await state()) === 'uat' ? true : undefined), 20_000)).toBe(true);

    expect((await post('/api/not-accepted', { task: 't002' }, 'http://evil.example')).status).toBe(403);
    expect((await post('/api/not-accepted', { task: 't002' })).status).toBe(200);
    expect((readJson(at('task.json')) as { state: string }).state).toBe('open');
    expect(await state()).toBe('open');
    expect((await fxGit(['log', '-1', '--format=%s'], bare)).stdout.trim()).toBe('t002: not accepted in yan serve, back to open');
    expect(existsSync(at('log.md'))).toBe(false);
  });

  it('says what changed since the page was written', async () => {
    write(home, 'tasks/t002/artifacts/uat/d1.png', 'another picture');
    await fxGit(['commit', '-q', '-am', 'redone'], home);
    const r = await until(async () => {
      const x = await report();
      return x !== undefined && x.behind.length > 0 ? x : undefined;
    }, 20_000);
    expect(r.behind).toEqual(['uat/d1.png 换了新的']);
  });
});
