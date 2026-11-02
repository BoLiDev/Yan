import type { ServerResponse } from 'node:http';
import { CONTROL_SINCE, atLeast, closeTab, createTab, layoutOfTab, serverOf, tabOf, versionOf } from '../../externals/herdr/index.js';
import { leasesHeldBy } from '../../externals/worktree/index.js';
import { Task } from '../../records/task/index.js';
import { isYanError } from '../../util/error.js';
import { remoteUrl } from '../../util/git.js';
import { holdWorktreeTab, letWorktreeTabGo, worktreeTabsOf, type WorktreeTab } from '../../util/machine.js';
import { repoKey } from '../../util/repo-key.js';
import { repoName } from '../shared/repo-name.js';
import { openTasks } from '../shared/task-id.js';
import type { WorktreeState } from './wire.js';

/**
 * A task's worktree tabs: a herdr tab beside its agent's for each of the
 * task's worktrees on this machine, a shell in it, for looking at and
 * running what the agent is working on. A branch's worktree is its
 * repository's, the one tree the task has of it, so every branch of a
 * repository opens the same tab and each other repository's a tab of its
 * own; asked for again, a tab is the same, however it has been split since,
 * and closed, it is opened anew. Each is kept in this machine's
 * config.json, so serve finds it again after a restart, and is let go of
 * once herdr no longer has it. Their shells are the page's, as the agent's
 * tab is, streamed and typed into. Opening one puts no branch in its tree:
 * the tree is the agent's to move, and may be on another of its branches.
 */
export class Worktrees {
  public constructor(private readonly vault: string, private readonly bin: () => string) {}

  /** The tabs kept for `task`. */
  public held(task: string): WorktreeTab[] {
    return worktreeTabsOf(this.vault).filter((w) => w.task === task);
  }

  /**
   * A tab as herdr has it split; undefined once it is gone, when herdr
   * answers but no longer has it, which lets it go.
   */
  private async stateOf(w: WorktreeTab): Promise<WorktreeState | undefined> {
    try {
      const [layout, herdr] = await Promise.all([layoutOfTab(w.socket, w.tab), versionOf(w.socket)]);
      return { tab: w.tab, name: w.name, layout, herdr, streams: atLeast(herdr, CONTROL_SINCE) };
    } catch {
      // Closed in herdr, or herdr is down: only one that answers can say the tab is gone.
      if (await versionOf(w.socket).then(() => true, () => false)) letWorktreeTabGo(this.vault, w.task, w.tab);
      return undefined;
    }
  }

  /** Each task's worktree tabs that herdr still has, by task, in the order they were opened. */
  public async states(): Promise<Record<string, WorktreeState[]>> {
    const found = await Promise.all(worktreeTabsOf(this.vault).map(async (w) => [w.task, await this.stateOf(w)] as const));
    const out: Record<string, WorktreeState[]> = {};
    for (const [task, state] of found) if (state !== undefined) (out[task] ??= []).push(state);
    return out;
  }

  /**
   * `{ task, repo }`: the tab of the task's worktree of its `repo`th
   * repository, the one its branches there are worked on in: the one open
   * already, or one opened with a shell in it. Answers `{ tab }`.
   */
  public async open(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const [task, at] = [given.task, given.repo];
    if (typeof task !== 'string' || !openTasks().some((t) => t.id === task)) return void res.writeHead(404).end(`${String(task)} is not an open task in this vault`);
    const { title, repos } = new Task(task).read();
    const repo = Number.isInteger(at) ? repos[at as number] : undefined;
    if (repo === undefined) return void res.writeHead(400).end('repo, the place of one of the task\'s repositories, is needed');
    const name = repoName(repo.url);
    const tree = leasesHeldBy(task).map((l) => l.path).find((p) => {
      const url = remoteUrl(p);
      return url !== undefined && repoKey(url) === repoKey(repo.url);
    });
    if (tree === undefined) return void res.writeHead(409).end(`${task} has no worktree of ${name} on this machine: Continue opens it`);

    const kept = this.held(task).find((w) => w.tree === tree);
    if (kept !== undefined && (await this.stateOf(kept)) !== undefined) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tab: kept.tab }));

    const bin = this.bin();
    try {
      const herdr = await serverOf(bin);
      if (!herdr.running) return void res.writeHead(409).end('herdr is not running: open it in a terminal first');
      if (!atLeast(herdr.version, CONTROL_SINCE)) return void res.writeHead(409).end(`herdr ${herdr.version} is too old: ${CONTROL_SINCE} or newer is needed`);
      const pane = await createTab(herdr.socket, { cwd: tree, label: `${title || task} · ${name}`, env: { YAN_VAULT: this.vault, YAN_TASK: task } });
      const tab = await tabOf(herdr.socket, pane);
      holdWorktreeTab({ vault: this.vault, task, tree, name, tab, socket: herdr.socket, bin });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tab }));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const unreachable = !isYanError(err) || err.code === 'herdr_unreachable';
      res.writeHead(unreachable ? 502 : 400).end(unreachable ? `herdr cannot be found (${bin}): ${why}` : why);
    }
  }

  /** `{ task, tab }`: that worktree tab of the task's closed, every shell in it with it. */
  public async close(res: ServerResponse, given: Record<string, unknown>): Promise<void> {
    const w = typeof given.task === 'string' ? this.held(given.task).find((x) => x.tab === given.tab) : undefined;
    if (w === undefined) return void res.writeHead(404).end('this task has no such worktree tab on this machine');
    try {
      await this.end(w);
    } catch (err) {
      return void res.writeHead(isYanError(err) && err.code !== 'herdr_unreachable' ? 400 : 502).end(err instanceof Error ? err.message : String(err));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  /** The worktree tabs of each task `aside` says is closed or paused: its worktrees are wiped, and a pause is for the room it took. */
  public async endSetAside(aside: (task: string) => Promise<boolean>): Promise<void> {
    for (const w of worktreeTabsOf(this.vault)) {
      // One herdr will not close is tried again on the next tick.
      if (await aside(w.task)) await this.end(w).catch(() => undefined);
    }
  }

  /** The tab closed, and let go of; one herdr has closed already only let go of. */
  private async end(w: WorktreeTab): Promise<void> {
    if ((await this.stateOf(w)) !== undefined) await closeTab(w.socket, w.tab);
    letWorktreeTabGo(this.vault, w.task, w.tab);
  }
}
