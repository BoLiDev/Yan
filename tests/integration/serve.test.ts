import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkClone, mkEmptyRemote, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { AGENT_PANE, SHELL_PANE, startFakeHerdr, type FakeHerdr } from '../helpers/fake-herdr.js';
import { readJson } from '../../src/util/json.js';
import type { TerminalState } from '../../src/cli/serve/wire.js';

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

/** A POST as the page makes one, or as a page at `origin` would. */
const post = (path: string, value: unknown, origin = page('')): Promise<Response> =>
  fetch(page(path), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });

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
      if (out.includes('Ctrl+C to stop')) resolve();
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

  it("gives its API only to its own page: a page elsewhere, an agent's on the files port among them, is refused", async () => {
    const from = async (site: string): Promise<number> => (await fetch(page('/api/hello'), { headers: { 'Sec-Fetch-Site': site } })).status;
    expect(await from('cross-site')).toBe(403);
    expect(await from('same-site')).toBe(403);
    expect(await from('same-origin')).toBe(200);
    expect((await fetch(page('/api/pull'), { method: 'POST', headers: { Origin: files('') } })).status).toBe(403);
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
    expect(r.stdout).toContain(`➜  Page    http://localhost:${port}  already running`);
  });
});

describe('pictures shown small on yan serve', () => {
  let shot = '';
  let fake = '';

  beforeAll(async () => {
    await fxGit(['pull', '-q', '--rebase', 'origin', 'main'], home);
    const { default: sharp } = await import('sharp');
    write(home, 'tasks/t003/task.json', task('t003', 'pictures'));
    write(home, 'tasks/t003/artifacts/uat/big.png', await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#336699' } }).png().toBuffer());
    await fxGit(['add', 'tasks'], home);
    await fxGit(['commit', '-q', '-m', 'a picture'], home);
    const shas = await until(async () => {
      const r = await fetch(page('/api/task/t003'));
      return r.ok ? ((await r.json()) as { files: { path: string; sha: string }[] }).files : undefined;
    }, 20_000);
    shot = shas.find((f) => f.path === 'uat/big.png')?.sha ?? '';
    fake = ((await (await fetch(page('/api/task/t001'))).json()) as { files: { path: string; sha: string }[] }).files.find((f) => f.path === 'c4/shot-1280.png')?.sha ?? '';
  });

  it('makes a row its copy by the shorter side and a card its copy by the longer, kept for good', async () => {
    const { default: sharp } = await import('sharp');
    for (const [size, width, height] of [['row', 108, 72], ['card', 520, 347]] as const) {
      const r = await fetch(files(`/_thumb/${size}/${shot}/big.png`));
      expect(r.headers.get('content-type')).toBe('image/webp');
      expect(r.headers.get('cache-control')).toContain('immutable');
      const meta = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
      expect([meta.width, meta.height], size).toEqual([width, height]);
    }
  });

  it('hands out as it is what is no picture it can read', async () => {
    const r = await fetch(files(`/_thumb/row/${fake}/shot-1280.png`));
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(await r.text()).toBe('not really a png');
    expect((await fetch(files(`/_thumb/huge/${fake}/shot-1280.png`))).status).toBe(404);
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

  it('sends the page its pictures beside it, and keeps them inside the copy to download', async () => {
    const shot = Buffer.from('the picture inside');
    write(home, 'tasks/t002/artifacts/report.html', PAGE.replace('</body>', `<figure><img src="data:image/png;base64,${shot.toString('base64')}" alt="it"></figure></body>`));
    await fxGit(['commit', '-q', '-am', 'a picture inside'], home);
    const r = await until(async () => {
      const x = await report();
      return x?.html.includes('<figure>') === true ? x : undefined;
    }, 20_000);
    expect(r.html).not.toContain('base64');
    const src = /<img loading="lazy" decoding="async" src="([^"]+)" alt="it">/.exec(r.html)?.[1] ?? '';
    expect(src).toBe(files(`/_report/${r.sha}/0`));
    const img = await fetch(src);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer()).toString()).toBe('the picture inside');
    expect((await fetch(files(`/_report/${r.sha}/1`))).status).toBe(404);
    expect(await (await fetch(page('/api/report/download?task=t002'))).text()).toContain(`src="data:image/png;base64,${shot.toString('base64')}"`);
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

  it('refuses a body too large to take, saying so rather than dropping the connection', async () => {
    const r = await post('/api/problem', { task: 't002', sha: '', text: 'x'.repeat(70_000) });
    expect(r.status).toBe(413);
    expect(readFileSync(at('problem.md'), 'utf8')).not.toContain('xxxx');
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

  it('keeps the agents in the order dragged to, the first shown kept last, and says so of a task with none', async () => {
    const kept = (): string[] => Object.keys((readJson(at('task.json')) as { resources?: object }).resources ?? {});
    const others = kept();
    for (const n of ['one', 'two', 'three']) await runYan(home, ['resource', 'add', 'run', n, `https://agent.example/${n}`, '--task', 't002']);
    await fxGit(['commit', '-q', '-am', 'agents'], home);
    expect((await post('/api/agents', { task: 't002', order: ['one', 'three', 'two'] })).status).toBe(200);
    expect(await subject()).toBe('t002: agents ordered in yan serve');
    expect(kept()).toEqual([...others, 'two', 'three', 'one']);
    expect((await post('/api/agents', { task: 't002', order: ['one', 'nine'] })).status).toBe(400);
    expect((await post('/api/agents', { task: 't002', order: 'one' })).status).toBe(400);

    const none = await fetch(page('/agent?task=t001'));
    expect(none.status).toBe(200);
    const said = await none.text();
    expect(said, 'the task named, and nothing else said').toContain('<h1><span>first</span><b> 没有 Agent</b></h1>');
    expect(said).not.toMatch(/<p[ >]/);
  });

  it('goes on answering while a save waits for the vault, and saves once the vault is free', async () => {
    // The vault held as an agent's hook holds it while it pushes.
    const lock = join(home, '.git', 'yan-sync.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: Math.floor(Date.now() / 1000) }));
    const saving = post('/api/deliverable/text', { task: 't001', id: 'd1', text: 'it still works' });
    try {
      // task.json written, the save is under way and waiting for the vault.
      await until(async () => (readFileSync(join(home, 'tasks/t001/task.json'), 'utf8').includes('it still works') ? true : undefined), 10_000);
      const asked = Date.now();
      const hello = await Promise.race([fetch(page('/api/hello')).then((r) => r.status), new Promise((resolve) => setTimeout(() => resolve('no answer'), 2000))]);
      expect(hello).toBe(200);
      expect(Date.now() - asked).toBeLessThan(2000);
      const first = await Promise.race([saving.then(() => 'saved'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 300))]);
      expect(first).toBe('waiting');
    } finally {
      rmSync(lock, { force: true });
    }
    expect((await saving).status).toBe(200);
    expect(await subject()).toBe('t001: d1 reworded in yan serve');
  });
});

// herdr's socket here is a Unix socket and its command a script with a shebang.
describe.skipIf(process.platform === 'win32')('an agent in a herdr pane on yan serve', () => {
  let herdr: FakeHerdr | undefined;
  afterEach(async () => {
    await herdr?.close();
    herdr = undefined;
  });

  /** This machine keeping t001's agent in `h`'s agent pane, and the terminals in `more` beside it. */
  function keep(h: FakeHerdr, more: { task: string; pane: string }[] = []): void {
    // The vault is $YAN_VAULT, so the machine's config.json registers none.
    mkdirSync(join(home, '.machine'), { recursive: true });
    writeFileSync(join(home, '.machine', 'config.json'), JSON.stringify({
      version: 1, vaults: {}, clones: {},
      terminals: [h.terminal(home, 't001'), ...more.map((m) => h.terminal(home, m.task, m.pane))],
    }));
  }

  /** A herdr of `version`, with t001's agent kept in its agent pane. */
  async function aHerdr(version: string, more: { task: string; pane: string }[] = []): Promise<FakeHerdr> {
    herdr = await startFakeHerdr({ version });
    keep(herdr, more);
    return herdr;
  }

  const terminals = async (): Promise<Record<string, TerminalState>> => (await (await fetch(page('/api/terminals'))).json()) as Record<string, TerminalState>;
  const input = (value: unknown, origin?: string): Promise<Response> => post('/api/terminal/input', value, origin);

  /** The first `n` frames a terminal stream sends, as herdr's controller wrote them, their bytes as text. */
  async function framesOf(res: Response, n: number): Promise<{ width: number; height: number; text: string }[]> {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let got = '';
    const events = (): string[] => got.split('\n\n').slice(0, -1).filter((e) => e.startsWith('data: '));
    while (events().length < n) {
      const chunk = await reader.read();
      if (chunk.done) break;
      got += decoder.decode(chunk.value, { stream: true });
    }
    return events().slice(0, n).map((e) => {
      const f = JSON.parse(e.slice('data: '.length)) as { width: number; height: number; bytes: string };
      return { width: f.width, height: f.height, text: Buffer.from(f.bytes, 'base64').toString() };
    });
  }

  it('lists a task whose pane is there with what herdr says of it, and streams the pane at the size the page holds it at', async () => {
    const h = await aHerdr('0.9.5', [{ task: 't009', pane: 'w9:p9' }]);
    expect(await terminals(), 'a pane gone is left out').toEqual({ t001: expect.objectContaining({ status: 'blocked', agent: 'claude', herdr: '0.9.5', streams: true, pane: AGENT_PANE }) });
    expect((await fetch(page('/api/terminal/stream?task=t001'))).status, 'a stream is sized by the page').toBe(400);

    const holding = new AbortController();
    const res = await fetch(page('/api/terminal/stream?task=t001&cols=132&rows=41'), { signal: holding.signal });
    const frames = await framesOf(res, 2);
    expect(frames.map((f) => f.text), "herdr's frames of the agent's pane, as it drew them").toEqual([`the screen of ${AGENT_PANE}`, '\x1b[1mDo you want to proceed?\x1b[0m']);
    expect(frames.map((f) => [f.width, f.height])).toEqual([[132, 41], [132, 41]]);
    expect(h.controllers(), 'held at the column\'s size, through the herdr the pane is in').toEqual([expect.objectContaining({ pane: AGENT_PANE, cols: 132, rows: 41, socket: h.socket, holding: true })]);

    // The column changing and the wheel go to the controller, which herdr routes as in its own window.
    expect((await input({ task: 't001', cols: 120, rows: 40 })).status).toBe(200);
    expect((await input({ task: 't001', wheel: -3, col: 5, row: 7 })).status).toBe(200);
    expect((await input({ task: 't001', cols: 3, rows: 40 })).status, 'a size no terminal is').toBe(409);
    const told = await until(async () => {
      const commands = h.controllers()[0]?.commands ?? [];
      return commands.length >= 2 ? commands : undefined;
    }, 5000);
    expect(told).toEqual([
      { type: 'terminal.resize', cols: 120, rows: 40 },
      { type: 'terminal.scroll', direction: 'up', lines: 3, column: 4, row: 6 },
    ]);
    expect(h.received(AGENT_PANE), 'nothing typed into the pane behind it').toEqual([]);

    holding.abort();
    expect(await until(async () => (h.controllers()[0]?.holding === false ? true : undefined), 5000), 'the page going lets the pane go').toBe(true);
  });

  it('types into the pane what the page sends, and turns the wheel as the program in it takes it when no page holds it', async () => {
    const h = await aHerdr('0.9.5');
    expect((await input({ task: 't001', keys: ['2'] })).status).toBe(200);
    expect((await input({ task: 't001', text: '\x1b[H' })).status).toBe(200);
    expect((await input({ task: 't001', paste: '换个做法', enter: true })).status).toBe(200);
    expect(h.received(AGENT_PANE), 'a key by its name, bytes as they are, a paste and its Enter').toEqual([{ keys: ['2'] }, { text: '\x1b[H' }, { paste: '换个做法', keys: ['enter'] }]);

    expect((await input({ task: 't001', wheel: -2, col: 5, row: 7 })).status).toBe(200);
    expect(h.wheels(AGENT_PANE), 'a full-screen program, with no history to scroll back, reads the wheel itself').toEqual([{ up: true, col: 5, row: 7 }, { up: true, col: 5, row: 7 }]);
    expect((await input({ task: 't001', pane: SHELL_PANE, wheel: -3, col: 5, row: 7 })).status).toBe(200);
    expect(h.scrolledBack(SHELL_PANE), "a shell with history has herdr's view of it scrolled back").toBe(3);
    expect(h.wheels(SHELL_PANE)).toEqual([]);

    const typed = h.received(AGENT_PANE).length;
    expect((await input({ task: 't001', keys: ['2'] }, 'http://evil.example')).status).toBe(403);
    expect((await input({ task: 't404', keys: ['2'] })).status).toBe(404);
    expect(h.received(AGENT_PANE), 'nothing typed for either').toHaveLength(typed);
  });

  it("shows the agent's whole tab, streams and types into a shell split off in it, and splits and closes one", async () => {
    const h = await aHerdr('0.9.5');
    expect(await until(async () => (await terminals()).t001?.layout, 5000)).toEqual({ split: 'right', ratio: 0.6, first: { pane: AGENT_PANE }, second: { pane: SHELL_PANE } });

    const holding = new AbortController();
    const res = await fetch(page(`/api/terminal/stream?task=t001&pane=${SHELL_PANE}&cols=60&rows=30`), { signal: holding.signal });
    expect((await framesOf(res, 1))[0]).toEqual({ width: 60, height: 30, text: `the screen of ${SHELL_PANE}` });
    holding.abort();
    expect((await fetch(page('/api/terminal/stream?task=t001&pane=w9:p9&cols=60&rows=30'))).status, 'a pane outside the tab').toBe(404);
    expect((await input({ task: 't001', pane: SHELL_PANE, text: 'ls\r' })).status).toBe(200);
    expect(h.received(SHELL_PANE)).toEqual([{ text: 'ls\r' }]);

    const split = await post('/api/terminal/split', { task: 't001', pane: SHELL_PANE, direction: 'down' });
    const { pane: made } = (await split.json()) as { pane: string };
    expect((await terminals()).t001?.layout, "split below the shell in herdr's tab, and so on the page").toEqual({
      split: 'right', ratio: 0.6, first: { pane: AGENT_PANE }, second: { split: 'down', ratio: 0.5, first: { pane: SHELL_PANE }, second: { pane: made } },
    });
    expect((await post('/api/terminal/close', { task: 't001', pane: SHELL_PANE })).status).toBe(200);
    expect((await terminals()).t001?.layout, 'closed in herdr, the pane split off it taking its place').toEqual({ split: 'right', ratio: 0.6, first: { pane: AGENT_PANE }, second: { pane: made } });

    expect((await post('/api/terminal/close', { task: 't001', pane: AGENT_PANE })).status, "the agent's own pane").toBe(400);
    expect((await post('/api/terminal/close', { task: 't001', pane: 'w9:p9' })).status, 'a pane outside the tab').toBe(404);
    expect((await post('/api/terminal/split', { task: 't001', direction: 'up' })).status).toBe(400);
    expect((await post('/api/terminal/split', { task: 't001', direction: 'right' }, 'http://evil.example')).status).toBe(403);
    expect(h.tabs().map((t) => t.panes), 'nothing split or closed for any of them').toEqual([[AGENT_PANE, made]]);
  });

  it("starts a new task in a new herdr tab, streams it by the launch's name, and says the task it becomes", async () => {
    const h = await aHerdr('0.9.5');
    expect(await (await fetch(page('/api/launch/repos'))).json(), 'nothing registered here').toEqual([]);
    expect((await post('/api/launch', { title: 'pay retries' }, 'http://evil.example')).status).toBe(403);
    expect((await post('/api/launch', { title: '  ' })).status).toBe(400);
    expect((await post('/api/launch', { title: 'x', repos: [{ name: 'nope', scope: [] }] })).status).toBe(400);
    expect(h.tabs(), 'no tab opened for any of them').toHaveLength(1);

    const started = await post('/api/launch', { title: "pay's retries", repos: [] });
    expect(started.status).toBe(200);
    const { launch } = (await started.json()) as { launch: string };
    expect(launch).toMatch(/^new-[0-9a-f]{8}$/);
    const tab = h.tabs().find((t) => t.label === "pay's retries");
    expect(tab, "its shell where bare yan typed by hand would start, in this vault, and herdr's focus left where it was").toMatchObject({ cwd: homedir(), env: { YAN_VAULT: home }, focused: false });
    const pane = tab?.panes[0] ?? '';
    expect(h.received(pane), 'bare yan with the answers, quoted for the shell where it must be, typed once the shell is at its prompt')
      .toEqual([{ text: expect.stringMatching(/bin\/yan\.mjs --new 'pay'\\''s retries' --no-repo\r$/) }]);

    expect((await terminals())[launch], "shown by the launch's name at once").toMatchObject({ title: "pay's retries", pane, cli: 'yan' });
    expect((await terminals())[launch]?.task).toBeUndefined();
    expect((await input({ task: launch, text: 'x' })).status, 'typed into as a terminal').toBe(200);
    expect(h.received(pane).at(-1)).toEqual({ text: 'x' });

    // bare yan keeps the pane as the new task's terminal.
    keep(h, [{ task: 't008', pane }]);
    expect(await until(async () => (await terminals())[launch]?.task, 5000)).toBe('t008');
  });

  it('goes on with a task in a new herdr tab, shown by its own id, and stops an agent by closing its tab', async () => {
    const h = await aHerdr('0.9.5');
    write(home, 'tasks/t007/task.json', task('t007', 'go on'));
    try {
      expect((await post('/api/launch', { task: 't404' })).status).toBe(404);
      const went = await post('/api/launch', { task: 't007' });
      expect(await went.json()).toEqual({ launch: 't007' });
      const tab = h.tabs().find((t) => t.label === 'go on');
      expect(tab?.focused).toBe(false);
      const pane = tab?.panes[0] ?? '';
      expect(h.received(pane), 'bare yan given the task to go on with').toEqual([{ text: expect.stringMatching(/yan\.mjs --task t007\r$/) }]);
      expect((await terminals()).t007, "the page shows it as the task's terminal at once").toMatchObject({ pane, cli: 'yan', title: 'go on' });

      expect((await post('/api/terminal/stop', { task: 't001' }, 'http://evil.example')).status).toBe(403);
      expect(h.tabs()).toHaveLength(2);
      expect((await post('/api/terminal/stop', { task: 't001' })).status).toBe(200);
      expect(h.tabs().map((t) => t.label), 'the whole tab the agent is in, the shell beside it with it').toEqual(['go on']);
      expect((readJson(join(home, '.machine', 'config.json')) as { terminals?: unknown[] }).terminals ?? [], "no longer this machine's terminal").toEqual([]);
      expect((await post('/api/terminal/stop', { task: 't007' })).status, 'a launch stops as a terminal does').toBe(200);
      expect(h.tabs()).toEqual([]);
      expect((await post('/api/terminal/stop', { task: 't007' })).status, 'and is then gone').toBe(404);
    } finally {
      rmSync(join(home, 'tasks', 't007'), { recursive: true, force: true });
    }
  });

  it('says which herdr is too old to stream a pane', async () => {
    await aHerdr('0.7.1');
    const state = await until(async () => {
      const t001 = (await terminals()).t001;
      return t001?.herdr === '0.7.1' ? t001 : undefined;
    }, 5000);
    expect(state.streams).toBe(false);
    const r = await fetch(page('/api/terminal/stream?task=t001&cols=100&rows=30'));
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('0.7.2');
  });
});

describe('yan updated from yan serve', () => {
  it('lets only its own page start an update, and counts what its clone is behind', async () => {
    const start = (origin: string) => fetch(page('/api/yan/update'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
    expect((await start('http://evil.example')).status).toBe(403);
    expect(await (await fetch(page('/api/yan/update'))).json()).toMatchObject({ running: false, error: null });
    // yan's folder here is the vault's clone too, level with its origin.
    expect(await (await fetch(page('/api/yan/updates'))).json()).toEqual({ behind: 0 });
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
