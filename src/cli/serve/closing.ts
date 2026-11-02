import type { ServerResponse } from 'node:http';
import { paneOf, sendInput } from '../../externals/herdr/index.js';
import { isYanError } from '../../util/error.js';
import { terminalsOf, type HeldTerminal } from '../../util/machine.js';
import { closingRequest, pausingRequest } from '../shared/launch.js';
import { openTasks } from '../shared/task-id.js';
import type { Launches } from './launch.js';

/**
 * Done, Abandon and Pause on the page: the task's agent asked to close it,
 * as `user` asks with yan:done, or to put it aside, as with yan:pause. Each
 * returns the task's worktrees, which wipes them, and whether one holds
 * work the task means to keep is for the agent to judge, as it does when
 * asked in its terminal: a closing throws away what is only build output
 * or leftovers, a pause commits and pushes the work first, and either stops
 * to ask `user` about anything else. So one that cannot go through is the
 * agent's to explain, in the terminal the page goes to, and is answered
 * there; asking again is asking the agent again. A pause with nothing to
 * judge, no agent running and every tree clean, pushed and on a branch the
 * task keeps, is serve's own: there is nothing an agent would do but that.
 */

/** What herdr says of the agent in a pane; undefined when the pane, or herdr, is gone. */
async function statusOf(t: { readonly socket: string; readonly pane: string }): Promise<string | undefined> {
  try {
    return (await paneOf(t.socket, t.pane)).agent_status;
  } catch {
    return undefined;
  }
}

/** Why an agent cannot be typed a request now, with herdr saying `status` of it; undefined when it can. */
function busy(status: string): string | undefined {
  if (status === 'working') return 'its agent is at work: ask once it has finished its turn, or stop it first';
  if (status === 'blocked') return 'its agent is waiting on you: answer it in its terminal first';
  return undefined;
}

/**
 * `request`, what the task's agent is asked, given to it: typed into the
 * agent running in a herdr pane here, as `user` would type it, unless it
 * is at work or waiting on `user`, when the request would land in the
 * middle of something else, so it is refused saying why. With none running,
 * `here` is asked whether serve can do it without one, and answers when it
 * can; else one is started on the task with the request as `user`'s first
 * message (bare `yan --task <id>` and `words`), in a herdr tab as Continue
 * opens one. A tab Continue opened whose agent bare `yan` has not kept yet
 * is refused too: its agent may be on its way, and a second would start
 * beside it.
 *
 * Answers `{ typed: true }`, the launch's name as Continue does, or what
 * `here` answers.
 */
async function askAgent(res: ServerResponse, task: string, vault: string, launches: Launches, request: (cli: string) => string, words: readonly string[], here?: (res: ServerResponse) => Promise<boolean>): Promise<void> {
  const kept: HeldTerminal | undefined = terminalsOf(vault).find((t) => t.task === task);
  const status = kept === undefined ? undefined : await statusOf(kept);
  if (kept !== undefined && status !== undefined) {
    const refused = busy(status);
    if (refused !== undefined) return void res.writeHead(409).end(refused);
    try {
      await sendInput(kept.socket, kept.pane, request(kept.cli), ['enter']);
    } catch (err) {
      return void res.writeHead(isYanError(err) && err.code !== 'herdr_unreachable' ? 400 : 502).end(err instanceof Error ? err.message : String(err));
    }
    return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"typed":true}');
  }

  const launched = launches.held(task);
  if (launched !== undefined && (await statusOf(launched)) !== undefined) {
    return void res.writeHead(409).end('the tab Continue opened for it has no agent kept yet: ask once its agent is up, or stop it first');
  }
  if (here !== undefined && (await here(res))) return;
  return launches.goOn(res, task, words);
}

/** `{ task }`, or `{ task, abandon }` with the reason it is given up: the task's agent asked to close it. */
export async function askToClose(res: ServerResponse, given: Record<string, unknown>, vault: string, launches: Launches): Promise<void> {
  const [task, abandon] = [given.task, given.abandon];
  if (typeof task !== 'string') return void res.writeHead(400).end('task is needed');
  if (abandon !== undefined && (typeof abandon !== 'string' || abandon.trim() === '')) return void res.writeHead(400).end('abandon takes the reason the task is being given up');
  if (!openTasks().some((t) => t.id === task)) return void res.writeHead(404).end(`${task} is not an open task in this vault`);
  const why = abandon?.replace(/\s+/g, ' ').trim();
  return askAgent(res, task, vault, launches, (cli) => closingRequest(cli, why), why === undefined ? ['--done'] : ['--abandon', why]);
}

/**
 * `{ task }`: the task put aside, its agent asked to save its work and
 * pause it, or, with no agent running here and nothing in its trees to
 * judge, paused by `here` straight away.
 */
export async function askToPause(res: ServerResponse, given: Record<string, unknown>, vault: string, launches: Launches, here: (res: ServerResponse, task: string) => Promise<boolean>): Promise<void> {
  const task = given.task;
  if (typeof task !== 'string') return void res.writeHead(400).end('task is needed');
  if (!openTasks().some((t) => t.id === task)) return void res.writeHead(404).end(`${task} is not an open task in this vault, or is paused already`);
  return askAgent(res, task, vault, launches, pausingRequest, ['--pause'], (r) => here(r, task));
}
