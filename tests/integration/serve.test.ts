import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  it('serves the page and an index of every task, each with what its files are now', async () => {
    expect(await (await fetch(page('/'))).text()).toContain('<div id="root"></div>');
    const index = (await (await fetch(page('/api/index'))).json()) as { tasks: { id: string; artifacts: number; rev: string }[]; latest: unknown[]; filesOrigin: string; status: { ok: boolean } };
    expect(index.tasks.map((t) => [t.id, t.artifacts])).toEqual([['t001', 4]]);
    expect(index.tasks[0]?.rev).toMatch(/^[0-9a-f]{16}$/);
    expect(index.latest).toHaveLength(1);
    expect(index.filesOrigin).toBe(`http://localhost:${port + 1}`);
    expect(index.status.ok).toBe(true);
  });

  it('serves the page as vite built it, its files kept forever, and nothing else from there', async () => {
    const html = await (await fetch(page('/'))).text();
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(script).toBeDefined();
    const js = await fetch(page(script as string));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(page('/assets/no-such-file.js'))).status).toBe(404);
    expect((await fetch(page('/assets/../package.json'))).status).toBe(404);
    expect((await fetch(page('/app.js'))).status).toBe(404);
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

  it('serves the faces its page and its code are drawn in', async () => {
    for (const name of ['yan-round-regular.woff2', '0xproto-regular.woff2', '0xproto-bold.woff2']) {
      const r = await fetch(page(`/fonts/${name}`));
      expect(r.status, name).toBe(200);
      expect(r.headers.get('content-type')).toBe('font/woff2');
    }
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

  it('ticks and gives up a deliverable in task.json, commits and pushes it, and hands out the page without the one given up', async () => {
    expect((await post('/api/deliverable', { task: 't002', id: 'd1', to: 'done' })).status).toBe(200);
    expect((await post('/api/deliverable', { task: 't002', id: 'd2', to: 'abandoned', reason: 'not now' })).status).toBe(200);
    const ds = (readJson(join(home, 'tasks/t002/task.json')) as { deliverables: { status: string; reason?: string }[] }).deliverables;
    expect(ds.map((x) => x.status)).toEqual(['done', 'abandoned']);
    expect((await fxGit(['log', '-1', '--format=%s', 'origin/main'], home)).stdout.trim()).toBe('t002: d2 given up in yan serve');
    expect((await fxGit(['log', '-1', '--format=%s'], bare)).stdout.trim()).toBe('t002: d2 given up in yan serve');

    const copy = await (await fetch(page('/api/report/download?task=t002'))).text();
    expect(copy).toContain('data-yan-d="d1" data-yan-status="done"');
    expect(copy).not.toContain('data-yan-d="d2"');
    expect(copy).toContain('<span data-yan-progress="">1/1</span>');
    expect((await report())?.behind).toEqual([]);

    expect((await post('/api/deliverable', { task: 't002', id: 'd2', to: 'abandoned', reason: 'not this month' })).status).toBe(200);
    expect((readJson(join(home, 'tasks/t002/task.json')) as { deliverables: { reason?: string }[] }).deliverables[1]?.reason).toBe('not this month');
    expect((await fxGit(['log', '-1', '--format=%s', 'origin/main'], home)).stdout.trim()).toBe("t002: d2's reason for giving up reworded in yan serve");

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

  it('lists a task its agent handed over as 验收中, and offers no way back to open', async () => {
    expect((await runYan(home, ['uat', 'ready', '--task', 't002'])).stdout).toContain('t002  验收中');
    await fxGit(['commit', '-q', '-am', 'ready'], home);
    const state = async (): Promise<string | undefined> => {
      const i = (await (await fetch(page('/api/index'))).json()) as { tasks: { id: string; state: string }[] };
      return i.tasks.find((t) => t.id === 't002')?.state;
    };
    expect(await until(async () => ((await state()) === 'uat' ? true : undefined), 20_000)).toBe(true);

    expect((await post('/api/not-accepted', { task: 't002' })).status).toBe(405);
    expect((readJson(at('task.json')) as { state: string }).state).toBe('uat');
    expect(await state()).toBe('uat');
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

describe('the overview on yan serve', () => {
  const at = (rel: string): string => join(home, 'tasks/t002', rel);
  const post = (path: string, value: unknown, origin = page('')) =>
    fetch(page(path), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
  const subject = async (): Promise<string> => (await fxGit(['log', '-1', '--format=%s'], bare)).stdout.trim();
  type Detail = { problem: { sha: string; text: string } | null };
  const detail = async (): Promise<Detail> => (await (await fetch(page('/api/task/t002'))).json()) as Detail;

  it('writes problem.md whole, and refuses an edit begun on a problem.md since changed', async () => {
    expect((await post('/api/problem', { task: 't002', sha: '', text: 'x' }, 'http://evil.example')).status).toBe(403);
    expect((await post('/api/problem', { task: 't002', sha: '', text: '   ' })).status).toBe(400);
    expect((await post('/api/problem', { task: 't002', sha: '', text: '# report\n\nwhat was wrong' })).status).toBe(200);
    expect(readFileSync(at('problem.md'), 'utf8')).toBe('# report\n\nwhat was wrong\n');
    expect(await subject()).toBe('t002: problem edited in yan serve');

    const read = await until(async () => {
      const problem = (await detail()).problem;
      return problem?.text.includes('what was wrong') ? problem : undefined;
    }, 20_000);
    expect((await post('/api/problem', { task: 't002', sha: read.sha, text: 'what was wrong, said better' })).status).toBe(200);
    expect((await post('/api/problem', { task: 't002', sha: read.sha, text: 'laid over the other' })).status).toBe(409);
    expect(readFileSync(at('problem.md'), 'utf8')).toBe('what was wrong, said better\n');
  });

  it('rewords a deliverable, keeping its id and state', async () => {
    expect((await post('/api/deliverable/text', { task: 't002', id: 'd1', text: 'one, reworded' })).status).toBe(200);
    expect((readJson(at('task.json')) as { deliverables: { id: string; text: string; status: string }[] }).deliverables[0]).toMatchObject({ id: 'd1', text: 'one, reworded', status: 'done' });
    expect(await subject()).toBe('t002: d1 reworded in yan serve');
    expect((await post('/api/deliverable/text', { task: 't002', id: 'd9', text: 'x' })).status).toBe(400);
  });

  it('deletes a deliverable as if never added, the ones after it taking its number', async () => {
    expect((await post('/api/deliverable/remove', { task: 't002', id: 'd1' })).status).toBe(200);
    expect((readJson(at('task.json')) as { deliverables: { id: string; text: string }[] }).deliverables.map((d) => `${d.id} ${d.text}`)).toEqual(['d1 two']);
    expect(await subject()).toBe('t002: d1 removed in yan serve');
    expect((await post('/api/deliverable/remove', { task: 't002', id: 'd9' })).status).toBe(400);
    expect((await post('/api/deliverable/remove', { task: 't002' })).status).toBe(400);
  });

  it('changes where a resource points, keeping its kind, and forgets one', async () => {
    await runYan(home, ['resource', 'add', 'spec', 'design', 'https://example.com/a', '--task', 't002']);
    await runYan(home, ['resource', 'add', 'general', 'notes', '/tmp/notes', '--task', 't002']);
    await fxGit(['commit', '-q', '-am', 'resources'], home);
    expect((await post('/api/resource', { task: 't002', name: 'design', where: 'https://example.com/b' })).status).toBe(200);
    expect(await subject()).toBe('t002: resource design changed in yan serve');
    expect((await post('/api/resource', { task: 't002', name: 'notes', remove: true })).status).toBe(200);
    expect(await subject()).toBe('t002: resource notes removed in yan serve');
    const doc = readJson(at('task.json')) as { resources: Record<string, string>; resourceKinds: Record<string, string> };
    expect(doc.resources).toEqual({ design: 'https://example.com/b' });
    expect(doc.resourceKinds.design).toBe('spec');
    expect((await post('/api/resource', { task: 't002', name: 'gone', where: 'x' })).status).toBe(400);
  });
});

describe('a yan serve left running while yan is updated', () => {
  const build = async (): Promise<string | undefined> => {
    try {
      return ((await (await fetch(page('/api/index'))).json()) as { status: { build: string } }).status.build;
    } catch {
      return undefined;
    }
  };

  it('restarts on the newer build by itself, in the same process and on the same port', async () => {
    const was = await build();
    expect(was).toMatch(/^[0-9a-f]{16}$/);
    const pid = server?.pid;
    write(home, 'dist/cli/newer.js', '// a newer build\n');
    const now = await until(async () => {
      const b = await build();
      return b !== undefined && b !== was ? b : undefined;
    }, 30_000);
    expect(now).not.toBe(was);
    expect(server?.exitCode).toBeNull();
    expect(server?.pid).toBe(pid);
    expect((await (await fetch(page('/api/hello'))).json()) as unknown).toMatchObject({ yan: 'serve' });
  });
});
