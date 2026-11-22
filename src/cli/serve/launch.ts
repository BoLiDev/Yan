import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import type { ServerResponse } from 'node:http';
import { isYanError } from '../../util/error.js';
import { JANUS } from '../../records/task/index.js';
import { terminalsOf, type HeldTerminal } from '../../util/machine.js';
import { newTaskRepos } from '../shared/launch.js';
import { openTasks } from '../shared/task-id.js';
import { herdrBin, openYanTab } from '../shared/yan-tab.js';

/**
 * A task started from the page, new or gone on with: serve opens a herdr
 * tab and types bare `yan` into it, as `user` would type it there, with the
 * answers the page's form asked for (`yan --new`) or the task to go on with
 * (`yan --task`). What bare `yan` says as it makes the task and its trees,
 * and the agent after, is that tab's, which the page shows as it shows any
 * terminal: a new task's by the launch's own name until bare `yan` keeps
 * the pane as the task's, a task gone on with by the task's own id from the
 * start. Launches live in serve's memory: one that serve restarts across
 * goes on in herdr, and is the task's terminal once it has one.
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

export class Launches {
  private readonly launched = new Map<string, Launch>();

  public constructor(private readonly vault: string) {}

  /** What the page's form offers: each repository a new task may work in, with its packages. */
  public repos(): { name: string; packages: string[] }[] {
    return newTaskRepos(homedir());
  }

  /** The herdr a launch goes to. */
  public bin(): string {
    return herdrBin(this.vault);
  }

  /** The launch `key` names, a new task's or a task's own id, as a terminal held for it. */
  public held(key: string): HeldTerminal | undefined {
    const l = this.launched.get(key);
    return l === undefined ? undefined : { vault: this.vault, task: key, pane: l.pane, socket: l.socket, bin: l.bin, cli: 'yan', since: l.since };
  }

  /** The launch forgotten, its tab closed. */
  public forget(key: string): void {
    this.launched.delete(key);
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
   * tab named for it; `{ task }`: an open task gone on with in one. Answers
   * the launch's name, the task's own id for one gone on with.
   */
  public async start(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    if (given.task !== undefined) return this.goOn(res, given.task);
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

    const answers = ['--new', title];
    for (const r of repos) answers.push('--repo', r.scope.length === 0 ? r.name : `${r.name}:${r.scope.join(',')}`);
    if (repos.length === 0) answers.push('--no-repo');
    return this.open(res, `${LAUNCHED}${randomBytes(4).toString('hex')}`, title, answers);
  }

  /**
   * The open task `task` gone on with in a herdr tab named for it, bare
   * `yan --task` typed into it with `more` after: the closing an agent is
   * started for, say. Answers the launch's name, the task's own id.
   */
  public async goOn(res: ServerResponse, task: unknown, more: readonly string[] = []): Promise<void> {
    // Janus is no task on the list, and is started as itself.
    if (task === JANUS) return this.open(res, JANUS, 'Janus', ['--janus']);
    const open = openTasks().find((t) => t.id === task);
    if (open === undefined) return void res.writeHead(404).end(`${String(task)} is not an open task in this vault`);
    return this.open(res, open.id, open.title, ['--task', open.id, ...more]);
  }

  /**
   * Janus started in a herdr tab of its own, unless it is running already:
   * what serve does as it starts, with nobody to tell why it could not.
   *
   * @throws YanError when herdr is not there to open a tab in.
   */
  public async janus(): Promise<void> {
    if (terminalsOf(this.vault).some((t) => t.task === JANUS) || this.launched.has(JANUS)) return;
    await this.tab(JANUS, 'Janus', ['--janus']);
  }

  /** A herdr tab named `title`, bare `yan` typed into it with `args`, kept as the launch `key`. */
  private async tab(key: string, title: string, args: readonly string[]): Promise<void> {
    const bin = this.bin();
    const { socket, pane } = await openYanTab(bin, this.vault, title, args);
    this.launched.set(key, { socket, bin, pane, title, since: new Date().toISOString() });
  }

  /** `tab`, answered to the page: the launch's name, or why there is none. */
  private async open(res: ServerResponse, key: string, title: string, args: readonly string[]): Promise<void> {
    try {
      await this.tab(key, title, args);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ launch: key }));
    } catch (err) {
      if (!isYanError(err)) throw err;
      res.writeHead(err.code === 'tab_no_herdr' ? 409 : err.code === 'tab_unreachable' ? 502 : 400).end(err.message);
    }
  }
}
