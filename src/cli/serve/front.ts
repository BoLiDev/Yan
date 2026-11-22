import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { inVault } from '../../util/vault.js';
import { YanServer, type Carried, type ServeOptions } from './server.js';
import type { Index, Status, TaskSummary, VaultStanding } from './wire.js';

/**
 * `yan serve` over several vaults, shown as one: the tasks of every vault
 * this machine has in one list, a task id two vaults have being the earlier
 * vault's, as the commands read them.
 *
 * Each vault keeps a server of its own (`YanServer`), whole and unchanged:
 * its commits, its fetches or its watching, its saves. None of them listens.
 * This listens for them all, and hands each request to the vault it is for,
 * told by the task it names; what names none, the drafts, a new task, yan's
 * own update, is the first vault's, the active one. Only what is one answer
 * for all of them is put together here: the index, the status every page
 * follows, the agents' terminals and worktrees, and a pull.
 *
 * A vault's work runs inside `inVault`, its ticks and timers with it, so
 * the records one request writes are that vault's and never the first's.
 */

const BODY_LIMIT = 16 * 1024 * 1024;

export interface VaultToServe {
  readonly name: string;
  readonly dir: string;
}

export class ManyVaults {
  private readonly sites: YanServer[];
  private readonly servers: Server[] = [];
  private readonly clients = new Set<ServerResponse>();

  public constructor(private readonly options: Omit<ServeOptions, 'vaultDir' | 'vaultName' | 'behind'>, vaults: readonly VaultToServe[]) {
    // The build is one for them all: only the first vault's server watches for a newer one.
    const { onNewBuild, ...rest } = options;
    this.sites = vaults.map(({ name, dir }, i) => inVault(dir, () => new YanServer({
      ...rest,
      ...(i === 0 && onNewBuild !== undefined ? { onNewBuild } : {}),
      vaultDir: dir,
      vaultName: name,
      behind: { said: () => this.broadcast(), whole: () => this.status() },
    })));
  }

  /** Read every vault once, then listen on `port` and `port + 1`. */
  public async start(): Promise<number> {
    for (const site of this.sites) await inVault(site.dir, () => site.start());
    try {
      await this.listen(this.options.port, (req, res) => this.app(req, res));
      await this.listen(this.options.port + 1, (req, res) => this.files(req, res));
    } catch (err) {
      await this.stop();
      throw err;
    }
    return this.options.port;
  }

  public async stop(): Promise<void> {
    for (const c of this.clients) c.end();
    await Promise.all(this.sites.map((site) => site.stop()));
    await Promise.all(this.servers.map((s) => new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    })));
  }

  private listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        handler(req, res).catch((err: unknown) => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`yan serve: ${(err as Error)?.message ?? String(err)}`);
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

  private get first(): YanServer {
    return this.sites[0] as YanServer;
  }

  /** The vault that answers for task `id`: the first to have it, or for a task being started that has no id yet, the vault that started it. */
  private siteOf(id: string | null | undefined): YanServer | undefined {
    if (typeof id !== 'string' || id === '') return undefined;
    return this.sites.find((site) => site.owns(id)) ?? this.sites.find((site) => site.launched(id));
  }

  /** The vault a request names outright, as a new task's form names the one it is made in. */
  private named(name: unknown): YanServer | undefined {
    return typeof name !== 'string' ? undefined : this.sites.find((site) => site.name === name);
  }

  /** Every vault's status as one: what all of them are, or the first that is not. */
  private status(): Status {
    const all = this.sites.map((site) => site.standing);
    const one = all[0] as Status;
    const wrong = all.find((s) => !s.ok);
    const unpushed = all.find((s) => s.push.error !== null);
    const max = (pick: (s: Status) => number | null): number | null => all.reduce<number | null>((m, s) => { const v = pick(s); return v === null ? m : m === null ? v : Math.max(m, v); }, null);
    return {
      ...one,
      version: all.reduce((n, s) => n + s.version, 0),
      commit: all.map((s) => s.commit ?? '').join('+'),
      checkedAt: max((s) => s.checkedAt),
      pulledAt: max((s) => s.pulledAt),
      ok: wrong === undefined,
      error: wrong === undefined ? null : wrong.error,
      local: all.every((s) => s.local),
      origin: all.some((s) => s.origin),
      push: { pending: all.some((s) => s.push.pending), error: unpushed?.push.error ?? null },
      vaults: this.sites.map((site): VaultStanding => ({ name: site.name, dir: site.dir, local: site.standing.local, origin: site.standing.origin, ok: site.standing.ok, fileLink: null })),
    };
  }

  private broadcast(): void {
    const data = `event: status\ndata: ${JSON.stringify(this.status())}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  /** `/api/index` of them all: each task once, named with its vault, and what arrived for the tasks shown. */
  private async index(): Promise<Index> {
    const each = await Promise.all(this.sites.map((site) => inVault(site.dir, () => site.indexNow())));
    const tasks: TaskSummary[] = [];
    const owner = new Map<string, number>();
    each.forEach((ix, i) => {
      for (const t of ix.tasks) {
        if (owner.has(t.id)) continue;
        owner.set(t.id, i);
        tasks.push({ ...t, vault: (this.sites[i] as YanServer).name });
      }
    });
    const status = this.status();
    return {
      ...(each[0] as Index),
      tasks,
      latest: each.flatMap((ix, i) => ix.latest.filter((push) => owner.get(push.task) === i)).sort((a, b) => b.at - a.at),
      status: { ...status, vaults: (status.vaults ?? []).map((v, i) => ({ ...v, fileLink: each[i]?.vault.fileLink ?? null })) },
    };
  }

  /** One answer made of each vault's, a map by task: an earlier vault's entry stands over a later one's. */
  private async byTask<T>(read: (site: YanServer) => Promise<Record<string, T>>): Promise<Record<string, T>> {
    const each = await Promise.all(this.sites.map((site) => inVault(site.dir, () => read(site))));
    return Object.assign({}, ...each.reverse()) as Record<string, T>;
  }

  private async app(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const json = (value: unknown): void => void res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
    const to = (site: YanServer): Promise<void> => inVault(site.dir, () => site.handle(req, res));
    // Whether the request may be answered at all is each vault's server's to say, as it says it alone: the first is asked what the rest would say.
    const mine = req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === 'none';

    if (req.method === 'GET' && mine) {
      if (p === '/api/index') return json(await this.index());
      if (p === '/api/terminals') return json(await this.byTask((site) => site.terminalStates()));
      if (p === '/api/worktrees') return json(await this.byTask((site) => site.worktreeStates()));
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(this.status())}\n\n`);
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }
      const blob = /^\/blob\/([0-9a-f]{7,64})$/.exec(p);
      if (blob !== null) return to(await this.holding(blob[1] as string));
      const task = /^\/api\/task\/([\w.-]+)$/.exec(p);
      return to(this.siteOf(task?.[1] ?? url.searchParams.get('task')) ?? this.named(url.searchParams.get('vault')) ?? this.first);
    }

    if (req.method === 'POST' && (req.headers['content-type'] ?? '').startsWith('application/json')) {
      // Read here to see which vault it is for, and carried to that vault's server, which would have read it.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size <= BODY_LIMIT) chunks.push(chunk as Buffer);
      }
      (req as Carried).yanBody = Buffer.concat(chunks);
      let given: Record<string, unknown> = {};
      try {
        const value = JSON.parse((req as Carried).yanBody?.toString('utf8') ?? '') as unknown;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) given = value as Record<string, unknown>;
      } catch {
        // Not JSON: the vault's server says so.
      }
      if (p === '/api/pull') {
        // Every vault's own server would refuse a page elsewhere; the first is asked, and its answer is not the status of one.
        if (req.headers.origin?.toLowerCase() !== `http://localhost:${this.options.port}` && req.headers.origin?.toLowerCase() !== `http://127.0.0.1:${this.options.port}`) return to(this.first);
        await Promise.all(this.sites.map((site) => inVault(site.dir, () => site.pull())));
        return json(this.status());
      }
      // A vault kept local or in step again: the one named, and the answer is the status of them all.
      if (p === '/api/vault/local' && typeof given.vault === 'string') {
        const named = this.sites.find((site) => site.name === given.vault);
        if (named === undefined) return void res.writeHead(404).end(`no vault called ${given.vault} is served here`);
        return to(named);
      }
      return to(this.siteOf(typeof given.task === 'string' ? given.task : url.searchParams.get('task')) ?? this.named(given.vault) ?? this.first);
    }
    return to(this.siteOf(url.searchParams.get('task')) ?? this.first);
  }

  /** The vault whose repository has the blob `sha`, or the first when none does, to say so. */
  private async holding(sha: string): Promise<YanServer> {
    for (const site of this.sites) if (await site.hasBlob(sha)) return site;
    return this.first;
  }

  private async files(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let path = '';
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname).replace(/^\/+/, '');
    } catch {
      // A path that cannot be read: the vault's server says so.
    }
    const sha = /^(?:_sha|_report|_thumb\/(?:row|card))\/([0-9a-f]{40,64})\//.exec(path)?.[1];
    const task = /^tasks\/([^/]+)\//.exec(path)?.[1];
    const site = sha !== undefined ? await this.holding(sha) : this.siteOf(task) ?? this.first;
    return inVault(site.dir, () => site.handleFiles(req, res));
  }
}
