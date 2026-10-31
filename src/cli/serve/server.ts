import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { artifactLinker, vaultFileLink, type FileLink } from '../shared/artifacts.js';
import { saveVault } from '../shared/vault-push.js';
import { Task, parseUat } from '../../records/task/index.js';
import { isYanError } from '../../util/error.js';
import { cloneOf } from '../../util/machine.js';
import { repoKey } from '../../util/repo-key.js';
import { Branches, PATCH_LIMIT } from './branch-view.js';
import { gitAsync } from './blobs.js';
import { behind, editText, handout, imagesOut, readRecord, sha256, withoutSubtasks } from './report.js';
import { noAgentPage } from './no-agent.js';
import { Terminals } from './terminal.js';
import { Launches } from './launch.js';
import { Updater } from './update.js';
import { sourceRules } from './source.js';
import { Thumbs, type ThumbSize } from './thumbs.js';
import { VaultView } from './vault-view.js';
import { buildLoads, buildPrint } from './build.js';

/**
 * `yan serve`'s two HTTP servers, both on 127.0.0.1.
 *
 * The page is on one port and the vault's files on the next. A page an
 * agent wrote runs as itself on the files port, loading its own scripts,
 * modules and fonts beside it, and as another origin it cannot read the
 * page's API or the page around it. The page shows text through
 * `/blob/<sha>` on its own origin, and points images, frames and players at
 * the files port, a picture shown small at a small copy of it.
 *
 * Every `everyS` seconds the server fetches the vault's branch into a ref of
 * its own and moves to the newest commit among that, origin's and the work
 * tree's HEAD, so a commit an agent made here and has not pushed yet shows
 * too. Pages hear of it through `/api/events`, a server-sent event stream.
 *
 * It reads git objects and never the work tree, with one exception: on a
 * task's report `user` ticks a deliverable, gives one up or edits a text.
 * That is written to task.json or report.html in the work tree, committed
 * and pushed as `yan vault push` would, and then shown like any other commit.
 */

export interface ServeOptions {
  readonly port: number;
  readonly everyS: number;
  readonly vaultDir: string;
  readonly vaultName: string;
  /** yan's own clone: the page, its fonts, its one library. */
  readonly home: string;
  /**
   * Called, instead of the next tick, once yan in `home` is a newer build
   * than the one running and it starts: the caller stops this server and
   * starts that one. Without it the server runs on as it is.
   */
  readonly onNewBuild?: () => void;
}

interface Status {
  version: number;
  commit: string | null;
  checkedAt: number | null;
  pulledAt: number | null;
  ok: boolean;
  error: string | null;
  everyS: number;
  /** The vault has no origin, so nothing is fetched. */
  local: boolean;
  /** Which yan is serving, from `buildPrint`: a page loaded from another reloads itself. */
  build: string;
}

const OWN_REF = 'refs/yan/serve/heads/';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
};

export function typeOf(name: string): string {
  return TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

const SHA = /^[0-9a-f]{7,64}$/;

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function json(res: ServerResponse, value: unknown): void {
  send(res, 200, JSON.stringify(value), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
}

/**
 * Bytes, honouring one `Range`: a video or a long recording is played by
 * asking for pieces of it, and seeking needs them.
 */
function sendBytes(req: IncomingMessage, res: ServerResponse, bytes: Buffer, type: string, headers: Record<string, string>): void {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const base = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', ...headers };
  if (range === null || (range[1] === '' && range[2] === '')) {
    res.writeHead(200, { ...base, 'Content-Length': String(bytes.length) });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return;
  }
  const size = bytes.length;
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
  res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}

/**
 * A change comes only from yan serve's own page: a page on any other site
 * can send this server a request, but its browser says where it came from.
 */
function originOk(req: IncomingMessage, port: number): boolean {
  const origin = (req.headers.origin ?? '').toLowerCase();
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

/** A JSON body, at most 64 KB; anything else is `undefined`. */
async function body(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 65_536) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A request whose Host is not this machine by name is refused: a page elsewhere that rebinds its name to 127.0.0.1 gets nothing. */
function hostOk(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

export class YanServer {
  private readonly view: VaultView;
  private readonly branches: Branches;
  private readonly thumbs = new Thumbs();
  private readonly terminals: Terminals;
  private readonly launches: Launches;
  private readonly updater: Updater;
  /** The sha256 of each blob of uat/ a report was checked against, by its git sha. */
  private readonly hashes = new Map<string, string>();
  /** The last few reports as the page is sent them, and the pictures taken out of each, by report.html's blob. */
  private readonly lightReports = new Map<string, { html: string; images: { type: string; bytes: Buffer }[] }>();
  private readonly status: Status;
  /** Where a file of the vault opens on its forge, read once: the vault's remote does not move while serve runs. */
  private readonly fileLink: FileLink | undefined;
  private readonly clients = new Set<ServerResponse>();
  private readonly servers: Server[] = [];
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private branch = 'main';
  private port = 0;
  /** A newer build seen on the last tick, waited on for one more to see it settled. */
  private nextBuild: string | undefined;
  /** A newer build that did not start, not tried again until it changes. */
  private brokenBuild: string | undefined;

  public constructor(private readonly options: ServeOptions) {
    this.view = new VaultView(options.vaultDir);
    this.launches = new Launches(options.vaultDir);
    this.terminals = new Terminals(options.vaultDir, this.launches);
    this.updater = new Updater(options.home, () => this.restartOnBuild());
    this.branches = new Branches(options.everyS);
    this.fileLink = vaultFileLink(options.vaultDir);
    this.status = { version: 0, commit: null, checkedAt: null, pulledAt: null, ok: true, error: null, everyS: options.everyS, local: false, build: buildPrint(options.home) };
  }

  public get filesOrigin(): string {
    return `http://localhost:${this.port + 1}`;
  }

  /**
   * Read the vault once, then listen on `port` and `port + 1`.
   *
   * @throws the listen error, `EADDRINUSE` most likely, with nothing left open.
   */
  public async start(): Promise<number> {
    this.branch = (await gitAsync(this.options.vaultDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
    if (this.branch === 'HEAD') this.branch = 'main';
    this.status.local = (await gitAsync(this.options.vaultDir, ['remote', 'get-url', 'origin'])).code !== 0;
    await this.tick();

    this.port = this.options.port;
    try {
      await this.listen(this.port, (req, res) => this.app(req, res));
      await this.listen(this.port + 1, (req, res) => this.files(req, res));
    } catch (err) {
      this.stop();
      throw err;
    }
    this.schedule();
    return this.port;
  }

  /** Stop ticking and listening; resolves once both ports are free. */
  public stop(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const c of this.clients) c.end();
    this.terminals.close();
    const closed = Promise.all(this.servers.map((s) => new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    })));
    void this.view.close();
    void this.branches.close();
    return closed.then(() => undefined);
  }

  private listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        handler(req, res).catch((err: unknown) => {
          if (!res.headersSent) send(res, 500, `yan serve: ${(err as Error)?.message ?? String(err)}`);
          else res.end();
        });
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.servers.push(server);
        resolve();
      });
    });
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      if (this.options.onNewBuild !== undefined && this.newBuild()) {
        this.options.onNewBuild();
        return;
      }
      this.tick()
        .catch(() => undefined)
        .finally(() => this.schedule());
    }, this.options.everyS * 1000);
  }

  /**
   * Restart now on the build in `home`, made whole by the page's update:
   * one other than the running one, which starts.
   */
  private restartOnBuild(): 'restarting' | 'same' | 'broken' {
    const now = buildPrint(this.options.home);
    if (now === '' || now === this.status.build) return 'same';
    if (this.options.onNewBuild === undefined || !buildLoads(this.options.home)) return 'broken';
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.options.onNewBuild();
    return 'restarting';
  }

  /**
   * Whether to restart on the yan now in `home`: a build other than the
   * running one, the same as on the last tick, since `npm run build` empties
   * dist/ and writes it again over a second or two, and one that starts.
   */
  private newBuild(): boolean {
    const now = buildPrint(this.options.home);
    if (now === '' || now === this.status.build) {
      this.nextBuild = undefined;
      return false;
    }
    if (now !== this.nextBuild) {
      this.nextBuild = now;
      return false;
    }
    if (now === this.brokenBuild) return false;
    if (buildLoads(this.options.home)) return true;
    this.brokenBuild = now;
    return false;
  }

  /** Fetch, move to the newest commit, and tell every open page. One at a time. */
  private tick(): Promise<void> {
    if (this.ticking !== undefined) return this.ticking;
    const first = this.view.commit === undefined;
    this.ticking = (async (): Promise<void> => {
      const dir = this.options.vaultDir;
      const now = (): number => Math.floor(Date.now() / 1000);
      if (this.status.local) {
        // No origin: the vault is only here, and HEAD is all there is to read.
        this.status.checkedAt = now();
      } else {
        const fetched = await gitAsync(
          dir,
          ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--no-write-fetch-head', '--no-tags', '--quiet', 'origin', `+refs/heads/${this.branch}:${OWN_REF}${this.branch}`],
          30_000,
        );
        this.status.checkedAt = now();
        this.status.ok = fetched.code === 0;
        this.status.error = fetched.code === 0 ? null : fetched.stderr.trim().split(/\r?\n/).pop() || 'fetch failed';
        if (fetched.code === 0) this.status.pulledAt = this.status.checkedAt;
      }

      try {
        const commit = await this.newest([`${OWN_REF}${this.branch}`, `refs/remotes/origin/${this.branch}`, 'HEAD']);
        if (commit !== undefined && commit !== this.view.commit) {
          await this.view.load(commit);
          this.status.commit = commit;
          this.status.version += 1;
        }
      } catch (err) {
        // The first read failing is the command failing; a later one leaves
        // the page on the commit it has, and says why.
        if (first) throw err;
        this.status.ok = false;
        this.status.error = (err as Error).message;
      }
      this.broadcast();
    })().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /** The newest of `refs`: one that descends from all the others before it. */
  private async newest(refs: readonly string[]): Promise<string | undefined> {
    let best: string | undefined;
    for (const ref of refs) {
      const r = await gitAsync(this.options.vaultDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      const sha = r.stdout.trim();
      if (r.code !== 0 || sha === '' || sha === best) continue;
      if (best === undefined || (await gitAsync(this.options.vaultDir, ['merge-base', '--is-ancestor', best, sha])).code === 0) best = sha;
    }
    return best;
  }

  private broadcast(): void {
    const data = `event: status\ndata: ${JSON.stringify(this.status)}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  // --- the page's origin -----------------------------------------------------

  private async app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostOk(req, this.port)) return send(res, 403, 'yan serve answers only to localhost');
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const p = url.pathname;
    const q = url.searchParams;

    if (req.method === 'POST' && p === '/api/pull') {
      await this.tick();
      return json(res, this.status);
    }
    // yan updating itself: only the page may start it.
    if (req.method === 'POST' && p === '/api/yan/update') {
      if (!originOk(req, this.port)) return send(res, 403, 'only yan serve\'s own page may update yan');
      return this.updater.start() ? json(res, this.updater.now) : send(res, 409, 'an update is running');
    }
    // What is typed into an agent's terminal: not the vault's, so nothing is committed, but only the page may send it.
    if (req.method === 'POST' && p === '/api/terminal/input') {
      if (!originOk(req, this.port)) return send(res, 403, 'only yan serve\'s own page may type into a terminal');
      const given = await body(req);
      if (given === undefined) return send(res, 400, 'a JSON body is needed');
      return this.terminals.input(res, given);
    }
    // A new task started in a new herdr tab: only the page may.
    if (req.method === 'POST' && p === '/api/launch') {
      if (!originOk(req, this.port)) return send(res, 403, 'only yan serve\'s own page may start a task');
      const given = await body(req);
      if (given === undefined) return send(res, 400, 'a JSON body is needed');
      return this.launches.start(res, given);
    }
    // A task's agent stopped, its herdr tab closed: only the page may.
    if (req.method === 'POST' && p === '/api/terminal/stop') {
      if (!originOk(req, this.port)) return send(res, 403, 'only yan serve\'s own page may stop an agent');
      const given = await body(req);
      if (given === undefined) return send(res, 400, 'a JSON body is needed');
      return this.terminals.stop(res, given);
    }
    // A pane split off beside the agent, or closed: only the page may.
    if (req.method === 'POST' && (p === '/api/terminal/split' || p === '/api/terminal/close')) {
      if (!originOk(req, this.port)) return send(res, 403, 'only yan serve\'s own page may split or close a pane');
      const given = await body(req);
      if (given === undefined) return send(res, 400, 'a JSON body is needed');
      return p === '/api/terminal/split' ? this.terminals.split(res, given) : this.terminals.closeSplit(res, given);
    }
    const write = req.method === 'POST' ? this.writes[p] : undefined;
    if (write !== undefined) {
      if (!originOk(req, this.port)) return send(res, 403, 'only yan serve\'s own page may change the vault');
      const given = await body(req);
      if (given === undefined) return send(res, 400, 'a JSON body is needed');
      return write(res, given);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET only');

    // The page, as `vite build` wrote it from web/: its files are named for their content, so they keep forever.
    if (p === '/' || p === '/index.html') return this.asset(res, join(this.options.home, 'dist', 'web', 'index.html'), 'text/html; charset=utf-8');
    if (p.startsWith('/assets/') && /^[\w.-]+$/.test(p.slice(8))) {
      return this.asset(res, join(this.options.home, 'dist', 'web', 'assets', p.slice(8)), typeOf(p), 'max-age=31536000, immutable');
    }
    if (p.startsWith('/fonts/') && /^[\w.-]+\.woff2$/.test(p.slice(7))) {
      return this.asset(res, join(this.options.home, 'templates', 'fonts', p.slice(7)), 'font/woff2', 'max-age=86400');
    }

    if (p === '/api/hello') return json(res, { yan: 'serve', vault: this.options.vaultName });
    if (p === '/agent') {
      const id = q.get('task') ?? '';
      return send(res, 200, noAgentPage(id, this.view.index().tasks.find((t) => t.id === id)?.title), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    }
    if (p === '/api/events') return this.events(req, res);
    if (p === '/api/terminals') return json(res, await this.terminals.states());
    if (p === '/api/launch/repos') return json(res, this.launches.repos());
    if (p === '/api/yan/updates') return json(res, await this.updater.behind());
    if (p === '/api/yan/update') return json(res, this.updater.now);
    if (p === '/api/terminal/stream') return this.terminals.stream(q.get('task') ?? '', q, req, res);
    if (p === '/api/index') {
      return json(res, {
        ...this.view.index(),
        status: this.status,
        vault: { name: this.options.vaultName, dir: this.options.vaultDir, fileLink: this.fileLink ?? null, source: sourceRules(await this.vaultConfig()) },
        filesOrigin: this.filesOrigin,
      });
    }
    const task = /^\/api\/task\/([\w.-]+)$/.exec(p);
    if (task !== null) {
      const detail = await this.view.task(task[1] as string);
      return detail === undefined ? send(res, 404, 'no such task') : json(res, detail);
    }
    const blob = /^\/blob\/([0-9a-f]{7,64})$/.exec(p);
    if (blob !== null) {
      const bytes = await this.view.blobs.read(blob[1] as string);
      if (bytes === undefined) return send(res, 404, 'no such blob');
      return sendBytes(req, res, bytes, 'text/plain; charset=utf-8', { 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    if (p === '/api/report') {
      const report = await this.report(q.get('task') ?? '');
      return report === undefined ? send(res, 404, 'that task has no report') : json(res, { ...report, html: withoutSubtasks((await this.light(report.sha)).html) });
    }
    if (p === '/api/report/download') {
      const id = q.get('task') ?? '';
      const [detail, report] = [await this.view.task(id), await this.report(id)];
      if (detail === undefined || report === undefined) return send(res, 404, 'that task has no report');
      const html = (await this.view.blobs.read(report.sha))?.toString('utf8') ?? '';
      return send(res, 200, handout(html, detail.deliverables), 'text/html; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${id}-report.html"`,
        'Cache-Control': 'no-store',
      });
    }
    if (p.startsWith('/api/branch')) return this.branchApi(req, res, p, q);
    return send(res, 404, 'not found');
  }

  /** The vault's config.json as the commit being shown has it, so a change pushed from elsewhere is seen as it arrives; {} when it is not there or not JSON. */
  private async vaultConfig(): Promise<unknown> {
    try {
      return JSON.parse((await this.view.rootFile('config.json'))?.toString('utf8') ?? '{}');
    } catch {
      return {};
    }
  }

  // --- the report ---------------------------------------------------------------

  /**
   * A task's report as the commit being shown has it: the page's blob, what
   * changed since it was written, and every file in uat/ with what uat.json
   * records of it and where it opens in the vault's repository.
   */
  private async report(id: string) {
    const detail = await this.view.task(id);
    const page = detail?.files.find((f) => f.path === 'report.html');
    if (detail === undefined || page === undefined) return undefined;
    const read = async (path: string): Promise<Buffer | undefined> => {
      const f = detail.files.find((x) => x.path === path);
      return f === undefined ? undefined : this.view.blobs.read(f.sha);
    };
    const parse = (bytes: Buffer | undefined): unknown => {
      try {
        return bytes === undefined ? undefined : (JSON.parse(bytes.toString('utf8')) as unknown);
      } catch {
        return undefined;
      }
    };
    const recordRaw = parse(await read('report.json'));
    const uat = parseUat(parse(await read('uat/uat.json')));
    // A blob's hash is worked out once: a report is asked for again on every push to its task, and uat/ is megabytes.
    const files = await Promise.all(uat.files.map(async (f) => {
      const blob = detail.files.find((x) => x.path === `uat/${f.path}`)?.sha;
      if (blob === undefined) return undefined;
      let hash = this.hashes.get(blob);
      if (hash === undefined) {
        const bytes = await this.view.blobs.read(blob);
        if (bytes === undefined) return undefined;
        this.hashes.set(blob, (hash = sha256(bytes)));
      }
      return { path: f.path, sha256: hash, for: f.for };
    }));
    const record = recordRaw === undefined ? undefined : readRecord(recordRaw);
    const link = artifactLinker(join(this.options.vaultDir, 'tasks', id));
    return {
      sha: page.sha,
      generatedAt: record?.generatedAt ?? null,
      behind: record === undefined ? ['没有 report.json，看不出写完之后哪里变了'] : behind(record, detail.deliverables, { files: files.filter((f) => f !== undefined) }),
      uat: detail.files
        .filter((f) => f.path.startsWith('uat/') && f.path !== 'uat/uat.json')
        .map((f) => {
          const rel = f.path.slice('uat/'.length);
          const recorded = uat.files.find((x) => x.path === rel);
          return { path: rel, sha: f.sha, size: f.size, for: recorded?.for ?? [], shows: recorded?.shows ?? null, url: link?.(f.path) ?? null };
        }),
    };
  }

  /**
   * The report.html of blob `sha` with its pictures taken out, as the page
   * is sent it; they are at `_report/<sha>/<n>` on the files port. The copy
   * handed out to download keeps them in.
   */
  private async light(sha: string): Promise<{ html: string; images: { type: string; bytes: Buffer }[] }> {
    let out = this.lightReports.get(sha);
    if (out === undefined) {
      out = imagesOut((await this.view.blobs.read(sha))?.toString('utf8') ?? '', (n) => `${this.filesOrigin}/_report/${sha}/${n}`);
      this.lightReports.set(sha, out);
      if (this.lightReports.size > 4) this.lightReports.delete(this.lightReports.keys().next().value as string);
    }
    return out;
  }

  /** Commit and push what `user` changed, then show the commit; a push that fails leaves the change committed here. */
  private async save(res: ServerResponse, message: string): Promise<void> {
    let warning: string | null = null;
    try {
      saveVault(this.options.vaultDir, message);
    } catch (err) {
      warning = isYanError(err) ? err.message : String(err);
    }
    await this.tick();
    json(res, { ok: true, warning, status: this.status });
  }

  /** Every change `user` makes from the page, by its path: each takes a JSON body, then commits and pushes. */
  private readonly writes: Readonly<Record<string, (res: ServerResponse, given: Record<string, unknown>) => Promise<void>>> = {
    '/api/deliverable': (res, given) => this.setDeliverable(res, given),
    '/api/deliverable/text': (res, given) => this.rewordDeliverable(res, given),
    '/api/deliverable/remove': (res, given) => this.removeDeliverable(res, given),
    '/api/problem': (res, given) => this.editProblem(res, given),
    '/api/resource': (res, given) => this.setResource(res, given),
    '/api/agents': (res, given) => this.orderAgents(res, given),
    '/api/report/edit': (res, given) => this.editReport(res, given),
  };

  /**
   * `{ task, id }`: a deliverable deleted on the overview, as if never added;
   * the ones after it take its number, and uat/ follows.
   */
  private async removeDeliverable(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [id, d] = [given.task, given.id];
    if (typeof id !== 'string' || !Task.isId(id) || typeof d !== 'string') return send(res, 400, 'task and id are needed');
    try {
      new Task(id).removeDeliverable(d);
    } catch (err) {
      return send(res, isYanError(err) ? 400 : 500, isYanError(err) ? err.message : String(err));
    }
    return this.save(res, `${id}: ${d} removed in yan serve`);
  }

  /** `{ task, id, text }`: a deliverable reworded on the overview, keeping its id and state. */
  private async rewordDeliverable(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [id, d, text] = [given.task, given.id, given.text];
    if (typeof id !== 'string' || !Task.isId(id) || typeof d !== 'string' || typeof text !== 'string') return send(res, 400, 'task, id and text are needed');
    try {
      new Task(id).editDeliverable(d, text);
    } catch (err) {
      return send(res, isYanError(err) ? 400 : 500, isYanError(err) ? err.message : String(err));
    }
    return this.save(res, `${id}: ${d} reworded in yan serve`);
  }

  /**
   * `{ task, sha, text }`: problem.md rewritten whole on the overview. `sha`
   * is the file the edit began from, '' when there was none; when the file
   * is no longer that, the edit is refused rather than laid over what an
   * agent wrote meanwhile.
   */
  private async editProblem(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [id, sha, text] = [given.task, given.sha, given.text];
    if (typeof id !== 'string' || !Task.isId(id) || typeof sha !== 'string' || typeof text !== 'string') return send(res, 400, 'task, sha and text are needed');
    if (text.trim() === '') return send(res, 400, 'a problem cannot be blank');
    const task = new Task(id);
    if (!existsSync(task.file)) return send(res, 404, 'no such task');
    const file = task.problem;
    const now = existsSync(file) ? (await gitAsync(this.options.vaultDir, ['hash-object', '--', file])).stdout.trim() : '';
    if (now !== sha) return send(res, 409, 'problem.md changed since this page loaded it - reload it and edit again');
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    return this.save(res, `${id}: problem edited in yan serve`);
  }

  /** `{ task, name, where }`: where a resource points, changed and its kind kept; `{ task, name, remove: true }`: forgotten. */
  private async setResource(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [id, name, where, remove] = [given.task, given.name, given.where, given.remove === true];
    if (typeof id !== 'string' || !Task.isId(id) || typeof name !== 'string' || (!remove && typeof where !== 'string')) {
      return send(res, 400, 'task, name and where (or remove) are needed');
    }
    try {
      const task = new Task(id);
      if (remove) task.removeResource(name);
      else {
        const kinds = task.read().resourceKinds;
        if (!(name in kinds)) return send(res, 400, `no such resource: ${name}`);
        task.addResource(kinds[name] ?? 'general', name, where as string);
      }
    } catch (err) {
      return send(res, isYanError(err) ? 400 : 500, isYanError(err) ? err.message : String(err));
    }
    return this.save(res, `${id}: resource ${name} ${remove ? 'removed' : 'changed'} in yan serve`);
  }

  /**
   * `{ task, order }`: the task's agents in the order dragged to, the first
   * the one going to the task opens. They are shown the last kept first, so
   * they are kept in the order turned round, and the next one kept comes
   * before them all.
   */
  private async orderAgents(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [id, order] = [given.task, given.order];
    if (typeof id !== 'string' || !Task.isId(id) || !Array.isArray(order) || !order.every((n): n is string => typeof n === 'string')) {
      return send(res, 400, 'task and order are needed');
    }
    try {
      new Task(id).orderResources([...order].reverse());
    } catch (err) {
      return send(res, isYanError(err) ? 400 : 500, isYanError(err) ? err.message : String(err));
    }
    return this.save(res, `${id}: agents ordered in yan serve`);
  }

  /** `{ task, id, to: done | todo | abandoned, reason? }`: `user` ticking, unticking or giving up a deliverable. */
  private async setDeliverable(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [id, d, to, reason] = [given.task, given.id, given.to, given.reason];
    if (typeof id !== 'string' || !Task.isId(id) || typeof d !== 'string' || (to !== 'done' && to !== 'todo' && to !== 'abandoned')) {
      return send(res, 400, 'task, id and to (done, todo or abandoned) are needed');
    }
    let reworded = false;
    try {
      const task = new Task(id);
      // Given up again, it is only its reason that changes: the page edits that in place.
      reworded = to === 'abandoned' && task.read().deliverables.some((x) => x.id === d && x.status === 'abandoned');
      if (to === 'done') task.deliverableDone(d);
      else if (to === 'todo') task.reopenDeliverable(d);
      else task.abandonDeliverable(d, typeof reason === 'string' ? reason : '');
    } catch (err) {
      return send(res, isYanError(err) ? 400 : 500, isYanError(err) ? err.message : String(err));
    }
    if (reworded) return this.save(res, `${id}: ${d}'s reason for giving up reworded in yan serve`);
    const word = { done: 'done', todo: 'back to do', abandoned: 'given up' }[to];
    return this.save(res, `${id}: ${d} ${word} in yan serve`);
  }

  /**
   * `{ task, sha, index, text }`: one text of the report, edited on the page.
   * `sha` is the page the edit was made on; when the file is no longer that
   * page, the edit is refused rather than laid over whatever replaced it.
   */
  private async editReport(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [id, sha, index, text] = [given.task, given.sha, given.index, given.text];
    if (typeof id !== 'string' || !Task.isId(id) || typeof sha !== 'string' || !Number.isInteger(index) || typeof text !== 'string') {
      return send(res, 400, 'task, sha, index and text are needed');
    }
    const file = join(this.options.vaultDir, 'tasks', id, 'artifacts', 'report.html');
    if (!existsSync(file)) return send(res, 404, 'that task has no report');
    const now = (await gitAsync(this.options.vaultDir, ['hash-object', '--', file])).stdout.trim();
    if (now !== sha) return send(res, 409, 'the report changed since this page loaded it - reload it and edit again');
    try {
      writeFileSync(file, editText(readFileSync(file, 'utf8'), index as number, text));
    } catch (err) {
      return send(res, 400, (err as Error).message);
    }
    return this.save(res, `${id}: report edited in yan serve`);
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(this.status)}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private async branchApi(req: IncomingMessage, res: ServerResponse, p: string, q: URLSearchParams): Promise<void> {
    const detail = await this.view.task(q.get('task') ?? '');
    const repo = detail?.repos[Number(q.get('repo') ?? '0')];
    if (detail === undefined || repo === undefined || repo.branch === null) return send(res, 404, 'that task keeps no branch there');
    const clone = cloneOf(repoKey(repo.url));
    const usable = clone !== undefined && existsSync(clone) ? clone : undefined;

    if (p === '/api/branch') {
      // The branch the task is on, or one it was on before; never any other name.
      const asked = q.get('branch') || repo.branch;
      if (asked !== repo.branch && !repo.earlier.includes(asked)) return send(res, 404, `${asked} is not a branch this task kept`);
      return json(res, await this.branches.view(repo.url, asked, usable, q.get('fresh') === '1', repo.bases[asked]));
    }
    if (usable === undefined) return send(res, 404, 'no clone of that repository on this machine');

    const sha = (name: string): string | undefined => {
      const v = q.get(name) ?? '';
      return SHA.test(v) ? v : undefined;
    };
    if (p === '/api/branch/diff') {
      const [base, head, path] = [sha('base'), sha('head'), q.get('path') ?? ''];
      if (base === undefined || head === undefined || path === '') return send(res, 400, 'base, head and path are needed');
      const from = q.get('from');
      const context = q.get('context') === 'all' ? '-U100000' : '-U3';
      const r = await gitAsync(usable, ['diff', '--no-color', '--no-ext-diff', '-M', context, base, head, '--', ...(from ? [from] : []), path]);
      return send(res, r.code === 0 ? 200 : 500, r.code === 0 ? r.stdout.slice(0, PATCH_LIMIT) : r.stderr, 'text/plain; charset=utf-8', { 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    if (p === '/api/branch/commit') {
      const c = sha('sha');
      if (c === undefined) return send(res, 400, 'sha is needed');
      const [head, patch] = await Promise.all([
        gitAsync(usable, ['show', '-s', '--format=%H%x1f%ct%x1f%an%x1f%s%x1f%b', c]),
        gitAsync(usable, ['show', '--no-color', '--no-ext-diff', '-M', '--format=', c]),
      ]);
      if (head.code !== 0) return send(res, 404, 'no such commit');
      const [full = c, at = '0', author = '', subject = '', body = ''] = head.stdout.split('\x1f');
      return json(res, { sha: full, at: Number(at), author, subject, body: body.trim(), patch: patch.stdout.slice(0, PATCH_LIMIT), truncated: patch.stdout.length > PATCH_LIMIT });
    }
    if (p === '/api/branch/tree') {
      const head = sha('head');
      if (head === undefined) return send(res, 400, 'head is needed');
      const r = await gitAsync(usable, ['ls-tree', '-r', '-l', '-z', head]);
      const files = r.stdout
        .split('\0')
        .map((line) => {
          const tab = line.indexOf('\t');
          const [, type, s, size] = line.slice(0, tab).trim().split(/\s+/);
          return tab < 0 || type !== 'blob' ? undefined : { path: line.slice(tab + 1), sha: s, size: Number(size) || 0 };
        })
        .filter((f) => f !== undefined);
      return json(res, files);
    }
    if (p === '/api/branch/blob') {
      const s = sha('sha');
      if (s === undefined) return send(res, 400, 'sha is needed');
      const bytes = await this.branches.reader(usable).read(s);
      if (bytes === undefined) return send(res, 404, 'no such blob');
      // On this origin only a picture is served as what it is: an SVG or a
      // page from the repository would run here, beside the API.
      const named = typeOf(q.get('name') ?? '');
      const type = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(named) ? named : 'text/plain; charset=utf-8';
      return sendBytes(req, res, bytes, type, { 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    return send(res, 404, 'not found');
  }

  private asset(res: ServerResponse, file: string, type: string, cache = 'no-cache'): void {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return send(res, 404, `yan serve: ${file} is missing - is this yan's own clone?`);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(size), 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    createReadStream(file).pipe(res);
  }

  // --- the files' origin -----------------------------------------------------

  /**
   * `/<path in the vault>`, as the commit being shown has it. Revalidated by
   * its blob's sha, so a file an agent rewrote is fetched again and one it
   * did not is a 304.
   */
  private async files(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostOk(req, this.port + 1)) return send(res, 403, 'yan serve answers only to localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET only');
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
    } catch {
      return send(res, 400, 'bad path');
    }
    // `_sha/<sha>/<name>`: one version of a file, which never changes, for
    // the image being looked at - a redraw costs no request.
    const pinned = /^_sha\/([0-9a-f]{40,64})\/([^/]+)$/.exec(path);
    if (pinned !== null) {
      const bytes = await this.view.blobs.read(pinned[1] as string);
      if (bytes === undefined) return send(res, 404, 'no such blob');
      return sendBytes(req, res, bytes, typeOf(pinned[2] as string), { 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    // `_report/<sha>/<n>`: the nth picture taken out of that report.html, read again from it when no longer kept.
    const shown = /^_report\/([0-9a-f]{40,64})\/(\d+)$/.exec(path);
    if (shown !== null) {
      const image = (await this.light(shown[1] as string)).images[Number(shown[2])];
      if (image === undefined) return send(res, 404, 'no such picture in that report');
      return sendBytes(req, res, image.bytes, image.type, { 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    // `_thumb/<size>/<sha>/<name>`: that version small, or as it is when it is no picture sharp reads.
    const small = /^_thumb\/(row|card)\/([0-9a-f]{40,64})\/([^/]+)$/.exec(path);
    if (small !== null) {
      const sha = small[2] as string;
      const copy = await this.thumbs.of(sha, small[1] as ThumbSize, () => this.view.blobs.read(sha));
      const bytes = copy ?? (await this.view.blobs.read(sha));
      if (bytes === undefined) return send(res, 404, 'no such blob');
      return sendBytes(req, res, bytes, copy === undefined ? typeOf(small[3] as string) : 'image/webp', { 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    let entry = this.view.entry(path);
    // A folder's page, as a static server would give it.
    if (entry === undefined && (path === '' || path.endsWith('/'))) entry = this.view.entry(`${path}index.html`);
    if (entry === undefined) return send(res, 404, `${path} is not in the vault`);

    const etag = `"${entry.sha}"`;
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const bytes = await this.view.blobs.read(entry.sha);
    if (bytes === undefined) return send(res, 404, `${path} cannot be read`);
    const download = new URL(req.url ?? '/', 'http://localhost').searchParams.has('download');
    const name = path.split('/').pop() ?? 'file';
    sendBytes(req, res, bytes, typeOf(path), download ? { ...headers, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : headers);
  }
}
