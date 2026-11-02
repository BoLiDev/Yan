import type { ServerResponse } from 'node:http';
import { CONTROL_SINCE, atLeast, closeTab, createTab, layoutOfTab, serverOf, splitPane, tabOf, versionOf } from '../../externals/herdr/index.js';
import { leasesHeldBy } from '../../externals/worktree/index.js';
import { Task } from '../../records/task/index.js';
import { isYanError } from '../../util/error.js';
import { remoteUrl } from '../../util/git.js';
import { holdWorktreeTab, letWorktreeTabGo, worktreeTabsOf, type WorktreeTab } from '../../util/machine.js';
import { repoKey } from '../../util/repo-key.js';
import { openTasks } from '../shared/task-id.js';
import type { WorktreeState } from './wire.js';

/**
 * A task's Worktree tab: a herdr tab beside its agent's, with a shell in
 * each of the task's worktrees on this machine, side by side, for looking
 * at and running what the agent is working on. One for a task: asked for
 * again, it is the same tab, however it has been split since; closed, it
 * is opened anew. It is kept in this machine's config.json, so serve finds
 * it again after a restart, and is let go of once herdr no longer has it.
 * Its shells are the page's, as the agent's tab is, streamed and typed into.
 */
export class Worktrees {
  public constructor(private readonly vault: string, private readonly bin: () => string) {}

  /** The tab kept for `task`, if any. */
  public held(task: string): WorktreeTab | undefined {
    return worktreeTabsOf(this.vault).find((w) => w.task === task);
  }

  /**
   * The tab of `task`, as herdr has it split; undefined once it is gone,
   * when herdr answers but no longer has it, which lets it go.
   */
  private async layoutOf(w: WorktreeTab): Promise<WorktreeState | undefined> {
    try {
      const [layout, herdr] = await Promise.all([layoutOfTab(w.socket, w.tab), versionOf(w.socket)]);
      return { tab: w.tab, layout, herdr, streams: atLeast(herdr, CONTROL_SINCE) };
    } catch {
      // Closed in herdr, or herdr is down: only one that answers can say the tab is gone.
      if (await versionOf(w.socket).then(() => true, () => false)) letWorktreeTabGo(this.vault, w.task);
      return undefined;
    }
  }

  /** Each task's Worktree tab that herdr still has, by task. */
  public async states(): Promise<Record<string, WorktreeState>> {
    const found = await Promise.all(worktreeTabsOf(this.vault).map(async (w) => [w.task, await this.layoutOf(w)] as const));
    return Object.fromEntries(found.filter((f): f is readonly [string, WorktreeState] => f[1] !== undefined));
  }

  /**
   * `{ task }`: the task's Worktree tab, opened with a shell in each of its
   * worktrees here, in the order the task lists its repositories, side by
   * side in equal parts; or the one open already. Answers `{ tab }`.
   */
  public async open(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const task = given.task;
    if (typeof task !== 'string' || !openTasks().some((t) => t.id === task)) return void res.writeHead(404).end(`${String(task)} is not an open task in this vault`);
    const kept = this.held(task);
    if (kept !== undefined && (await this.layoutOf(kept)) !== undefined) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tab: kept.tab }));

    const { title, repos } = new Task(task).read();
    const order = (path: string): number => {
      const url = remoteUrl(path);
      const at = url === undefined ? -1 : repos.findIndex((r) => repoKey(r.url) === repoKey(url));
      return at < 0 ? repos.length : at;
    };
    const trees = leasesHeldBy(task).map((l) => l.path).sort((a, b) => order(a) - order(b));
    if (trees.length === 0) return void res.writeHead(409).end(`${task} has no worktree on this machine: Continue opens them`);

    const bin = this.bin();
    try {
      const herdr = await serverOf(bin);
      if (!herdr.running) return void res.writeHead(409).end('herdr is not running: open it in a terminal first');
      if (!atLeast(herdr.version, CONTROL_SINCE)) return void res.writeHead(409).end(`herdr ${herdr.version} is too old: ${CONTROL_SINCE} or newer is needed`);
      const env = { YAN_VAULT: this.vault, YAN_TASK: task };
      const first = await createTab(herdr.socket, { cwd: trees[0] as string, label: `${title || task} · worktree`, env });
      const tab = await tabOf(herdr.socket, first);
      // Each split keeps the pane split off its share, so every worktree has an equal part of the tab.
      let last = first;
      for (const [i, tree] of trees.entries()) {
        if (i === 0) continue;
        last = await splitPane(herdr.socket, last, 'right', { cwd: tree, ratio: 1 / (trees.length - i + 1), env });
      }
      holdWorktreeTab({ vault: this.vault, task, tab, socket: herdr.socket, bin });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tab }));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const unreachable = !isYanError(err) || err.code === 'herdr_unreachable';
      res.writeHead(unreachable ? 502 : 400).end(unreachable ? `herdr cannot be found (${bin}): ${why}` : why);
    }
  }

  /** `{ task }`: the task's Worktree tab closed, every shell in it with it. */
  public async close(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const w = typeof given.task === 'string' ? this.held(given.task) : undefined;
    if (w === undefined) return void res.writeHead(404).end('this task has no Worktree tab on this machine');
    try {
      await this.end(w);
    } catch (err) {
      return void res.writeHead(isYanError(err) && err.code !== 'herdr_unreachable' ? 400 : 502).end(err instanceof Error ? err.message : String(err));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  /** The Worktree tab of each task `aside` says is closed or paused: its worktrees are wiped, and a pause is for the room it took. */
  public async endSetAside(aside: (task: string) => Promise<boolean>): Promise<void> {
    for (const w of worktreeTabsOf(this.vault)) {
      // One herdr will not close is tried again on the next tick.
      if (await aside(w.task)) await this.end(w).catch(() => undefined);
    }
  }

  /** The tab closed, and let go of; one herdr has closed already only let go of. */
  private async end(w: WorktreeTab): Promise<void> {
    if ((await this.layoutOf(w)) !== undefined) await closeTab(w.socket, w.tab);
    letWorktreeTabGo(this.vault, w.task);
  }
}
