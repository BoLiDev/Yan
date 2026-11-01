import type { AgentChange, AgentStatus } from './wire.js';

/**
 * What each task's agent last changed from and to, and when, as serve sees
 * herdr say it. herdr says only what an agent is now; when it finished, or
 * began to wait on `user`, is what the page's Latest and its toasts tell, so
 * serve keeps it. In memory and for this machine alone, as the agents are:
 * a serve started again knows no change until the next.
 */
export class AgentWatch {
  private readonly last = new Map<string, { status: AgentStatus; change?: AgentChange }>();

  /**
   * `task`'s agent seen to be `status` at `now`, in seconds: its last
   * change, this one when it has just changed. The first sight of an agent
   * is no change, and neither is herdr not knowing: an agent herdr cannot
   * read for a moment is not taken to have stopped and started again.
   */
  public note(task: string, status: AgentStatus, now = Math.floor(Date.now() / 1000)): AgentChange | undefined {
    const was = this.last.get(task);
    if (status === 'unknown') return was?.change;
    if (was === undefined || was.status === 'unknown') {
      this.last.set(task, { status });
      return undefined;
    }
    if (was.status === status) return was.change;
    const change: AgentChange = { from: was.status, to: status, at: now };
    this.last.set(task, { status, change });
    return change;
  }

  /** Only `tasks` are still there: an agent whose pane has gone is forgotten, and one started again begins afresh. */
  public keep(tasks: ReadonlySet<string>): void {
    for (const task of this.last.keys()) if (!tasks.has(task)) this.last.delete(task);
  }
}
