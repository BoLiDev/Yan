import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { CONTROL_SINCE, atLeast, createTab, sendText, serverOf } from '../../externals/herdr/index.js';
import { isYanError } from '../../util/error.js';
import { yanHome } from '../../util/home.js';
import { terminalsOf, type HeldTerminal } from '../../util/machine.js';
import { newTaskRepos } from '../shared/launch.js';

/**
 * A new task started from the page: the page's form has asked what bare
 * `yan` would ask, so serve opens a herdr tab and types bare `yan` into it
 * with those answers (`yan --new`), as `user` would type it there. What
 * bare `yan` says as it makes the task and its trees, and the agent after,
 * is that tab's, which the page shows as it shows any terminal, by the
 * launch's own name until bare `yan` keeps the pane as the new task's.
 * Launches live in serve's memory: one that serve restarts across goes on
 * in herdr, and is the task's terminal once it has one.
 */

/** A launch's name where a task's id would be, so the page streams and types into it as into a task's terminal. */
export const LAUNCHED = 'new-';

interface Launch {
  readonly socket: string;
  readonly bin: string;
  readonly pane: string;
  readonly title: string;
  readonly since: string;
}

/** A word for the shell, quoted as sh, bash, zsh and fish all read it back as it was. */
const quoted = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

export class Launches {
  private readonly launched = new Map<string, Launch>();

  public constructor(private readonly vault: string) {}

  /** What the page's form offers: each repository a new task may work in, with its packages. */
  public repos(): { name: string; packages: string[] }[] {
    return newTaskRepos(homedir());
  }

  /**
   * The herdr a launch goes to: the one serve runs in, else the one an agent
   * here was started in, else whichever `herdr` on the PATH finds.
   */
  private bin(): string {
    return process.env.HERDR_BIN_PATH?.trim() || terminalsOf(this.vault)[0]?.bin || 'herdr';
  }

  /** The launch `key` names, as a terminal held for it; none once its pane is kept as a task's. */
  public held(key: string): HeldTerminal | undefined {
    const l = key.startsWith(LAUNCHED) ? this.launched.get(key) : undefined;
    return l === undefined ? undefined : { vault: this.vault, task: key, pane: l.pane, socket: l.socket, bin: l.bin, cli: 'yan', since: l.since };
  }

  /** Every launch, and the task it has become once bare `yan` keeps its pane for one. */
  public all(): { key: string; held: HeldTerminal; title: string; task: string | undefined }[] {
    const kept = terminalsOf(this.vault);
    return [...this.launched].map(([key, l]) => ({
      key,
      held: this.held(key) as HeldTerminal,
      title: l.title,
      task: kept.find((t) => t.socket === l.socket && t.pane === l.pane)?.task,
    }));
  }

  /**
   * `{ title, repos: [{ name, scope }] }`: a new task, started in a new herdr
   * tab named for it. Answers the launch's name.
   */
  public async start(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const title = typeof given.title === 'string' ? given.title.trim() : '';
    if (title === '' || title.length > 200) return void res.writeHead(400).end('a new task needs a title, of 200 characters at most');
    const offered = this.repos();
    const repos: { name: string; scope: string[] }[] = [];
    for (const r of Array.isArray(given.repos) ? (given.repos as unknown[]) : []) {
      const name = typeof (r as { name?: unknown }).name === 'string' ? (r as { name: string }).name : '';
      const scope = Array.isArray((r as { scope?: unknown }).scope) ? ((r as { scope: unknown[] }).scope).filter((p): p is string => typeof p === 'string') : [];
      const repo = offered.find((o) => o.name === name);
      if (repo === undefined) return void res.writeHead(400).end(`no repository called ${name} is registered and cloned here`);
      if (scope.some((p) => !repo.packages.includes(p))) return void res.writeHead(400).end(`${name} has no such package`);
      repos.push({ name, scope });
    }

    const bin = this.bin();
    try {
      const herdr = await serverOf(bin);
      if (!herdr.running) return void res.writeHead(409).end('herdr 没有在运行：先在终端里打开 herdr');
      if (!atLeast(herdr.version, CONTROL_SINCE)) return void res.writeHead(409).end(`herdr ${herdr.version} 太旧，需要 ${CONTROL_SINCE} 或更新的版本`);
      // The shell starts where bare `yan` typed by hand would, and in the vault serve shows, whichever is this machine's own.
      const pane = await createTab(herdr.socket, { cwd: homedir(), label: title, env: { YAN_VAULT: this.vault } });
      const words = [process.execPath, join(yanHome(), 'bin', 'yan.mjs'), '--new', title];
      for (const r of repos) words.push('--repo', r.scope.length === 0 ? r.name : `${r.name}:${r.scope.join(',')}`);
      if (repos.length === 0) words.push('--no-repo');
      await sendText(herdr.socket, pane, `${words.map(quoted).join(' ')}\r`);
      const key = `${LAUNCHED}${randomBytes(4).toString('hex')}`;
      this.launched.set(key, { socket: herdr.socket, bin, pane, title, since: new Date().toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ launch: key }));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const unreachable = !isYanError(err) || err.code === 'herdr_unreachable';
      res.writeHead(unreachable ? 502 : 400).end(unreachable ? `找不到 herdr（${bin}）：${why}` : why);
    }
  }
}
