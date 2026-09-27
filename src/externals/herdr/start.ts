import { nativePath } from '../../util/paths.js';
import { herdrCall, type HerdrRunner } from './cli.js';
import { requireAgentName, requirePaneId, requireWorkspaceId } from './ids.js';
import { asRecord, asString } from '../../util/narrow.js';
import { agentSessionOf, statusOf } from './parse.js';
import { YanError, isYanError } from '../../util/error.js';
import type { AgentStatus, Alive, SplitAt, StartAgentOptions, StartedAgent } from './types.js';

/**
 * Starting one agent, from the pane it is given to the status it settled on.
 * `Terminal.startAgent` is the way in; everything here is internal to the
 * herdr module.
 */

/** How long a new pane's shell is given to reach its prompt. */
export const BUSY_RETRY_MS = 15000;

/** The pause between asking a busy pane again. */
const BUSY_INTERVAL_MS = 500;

/** How long a freshly started agent is given to reach `working` or `blocked`. */
export const SETTLE_MS = 8000;

/** How many startup dialogs in a row `startAgent` will answer before giving up. */
const STARTUP_DIALOG_ROUNDS = 3;

/**
 * The dialogs a harness puts up before it has read its prompt, whose Enter
 * default answers the question yan already decided by choosing the directory
 * it started the agent in. Nothing else is answered blind: an unrecognised
 * question is left standing, and `yan state` is what finds it.
 *
 * `--dangerously-skip-permissions` does not cover this one; it is asked before
 * permissions are consulted at all, and it is asked once per directory that
 * has no trusted ancestor.
 */
const STARTUP_DIALOGS: readonly RegExp[] = [/Yes, I trust this folder/i];

function isStartupDialog(screen: string): boolean {
  return STARTUP_DIALOGS.some((pattern) => pattern.test(screen));
}

/**
 * What a start needs: how to run herdr, how to wait, the two budgets, and the
 * four questions `Terminal` already knows how to ask about a pane.
 */
export interface Starting {
  readonly run: HerdrRunner;
  /** Blocks for a number of milliseconds. */
  readonly sleep: (ms: number) => void;
  /** How long a freshly started agent is waited for; 0 skips the wait. */
  readonly settleMs: number;
  /** How long a busy new pane is asked again. */
  readonly busyRetryMs: number;
  /** The agent's status, `unknown` when Herdr will not say. Never throws. */
  readonly status: (pane: string) => AgentStatus;
  readonly alive: (pane: string) => Alive;
  /** The screen, or `''` when it cannot be read. Never throws. */
  readonly screen: (pane: string) => string;
  /** One prompt, refused when no live agent is there. */
  readonly send: (pane: string, text: string) => void;
}

/**
 * Make a pane carrying `env` and `cwd` — a new tab in the container, or,
 * with `split`, the new half of that pane — and start an agent in it. Does
 * not focus.
 *
 * Only returns a pane whose agent was still alive a moment later — Herdr's
 * own readiness check is screen-based and matches a bare shell prompt too.
 * That second look can be fooled the same way, so it catches an agent that
 * is already visibly gone and promises nothing beyond that.
 *
 * Herdr calls an agent ready as soon as it recognises one, which it does
 * while the harness is still holding up its trust dialog; the returned
 * `status` is therefore the settled one, read after the agent has had time
 * to move, and a recognised startup dialog has been answered by then. A
 * `blocked` here means something yan does not recognise is on the screen —
 * the agent is running, so the caller keeps the tree and tells `user`.
 *
 * @throws YanError `term_usage` for a missing argument, `term_not_found` when no
 *   agent is in the pane afterwards.
 */
export function startAgent(ctx: Starting, options: StartAgentOptions): StartedAgent {
  requireAgentName(options.name);
  if (options.kind === '') throw YanError.usage('term_usage', 'an agent kind is required');
  if (options.cwd === '') throw YanError.usage('term_usage', 'a working directory is required');

  const pane = options.split === undefined ? createTab(ctx.run, options) : splitPane(ctx.run, options.split, options);
  const startArgs = ['agent', 'start', options.name, '--kind', options.kind, '--pane', pane];
  // Everything after `--` reaches the agent as argv, with no shell in
  // between, so nothing here needs quoting.
  if (options.argv !== undefined && options.argv.length > 0) startArgs.push('--', ...options.argv);

  let started: Record<string, unknown>;
  try {
    started = asRecord(startWhenReady(ctx, startArgs));
  } catch (err) {
    // This call made the pane, and it never took its agent, so it is not
    // left behind as an empty tab or an empty half of one.
    try {
      herdrCall(ctx.run, ['pane', 'close', pane], 'pane close');
    } catch {
      // Closing is tidying; the reason worth reporting is the start's.
    }
    throw err;
  }
  const agent = asRecord(started.agent);
  const reported = asString(agent.pane_id) || pane;

  if (ctx.alive(reported) !== 'alive') {
    throw new YanError('term_not_found',
      `herdr reported '${options.name}' ready in ${reported}, but no agent is there - the CLI probably exited at once. Look at the pane before sending anything to it`,
    );
  }

  const session = agentSessionOf(agent.agent_session);
  return {
    name: asString(agent.name) || options.name,
    pane: reported,
    status: settle(ctx, reported, statusOf(agent.agent_status), options.prompt),
    ...(session === undefined ? {} : { agent_session: session }),
  };
}

/**
 * Wait for a freshly started agent to reach its input line, answering the
 * startup dialogs in `STARTUP_DIALOGS` as they appear, then hand it
 * `prompt` and answer with the status it settled on.
 *
 * The prompt is typed in here rather than passed on the command line
 * because Herdr's `agent start` returns only once the agent is ready for
 * input: one that already has its work order goes straight to work and is
 * still working at the deadline, so the start was reported as a timeout and
 * the pane closed on a shift that was fine. Typed in after the dialogs, the
 * prompt also survives a harness that restarts behind one, which drops
 * whatever it was started with.
 *
 * Never throws: the agent is already running, and every failure here is a
 * question about it rather than a reason to tear it down.
 */
function settle(ctx: Starting, pane: string, reported: AgentStatus, prompt?: string): AgentStatus {
  if (ctx.settleMs <= 0) return handOver(ctx, pane, reported, prompt);

  let status = reported;
  let answered = false;
  for (let round = 0; round <= STARTUP_DIALOG_ROUNDS; round += 1) {
    // Returns the moment it is any of them, so a healthy agent costs a
    // second rather than the whole budget.
    waitFor(ctx, pane, ['idle', 'done', 'blocked']);
    status = ctx.status(pane);

    if (status !== 'blocked') break;
    if (round === STARTUP_DIALOG_ROUNDS) break;
    if (!isStartupDialog(ctx.screen(pane))) break;

    // Enter takes the highlighted default, which for these is yes.
    ctx.run(['agent', 'send-keys', pane, 'enter']);
    answered = true;
  }

  if (answered) {
    // The harness is restarting behind the dialog, and Herdr reads that
    // screen as `blocked` too, so the status just taken says nothing yet.
    waitFor(ctx, pane, ['idle', 'done']);
    status = ctx.status(pane);
  }

  return handOver(ctx, pane, status, prompt);
}

/**
 * Type the work order into an agent that is at its input line. A `blocked`
 * agent is asking something nobody here recognises, and the prompt would be
 * typed into that dialog; it is left standing for the caller to raise.
 */
function handOver(ctx: Starting, pane: string, status: AgentStatus, prompt?: string): AgentStatus {
  if (status === 'blocked' || prompt === undefined || prompt === '') return status;
  try {
    ctx.send(pane, prompt);
    return ctx.status(pane);
  } catch {
    // The agent is up and the pane is recorded; the caller has it from here.
    return status;
  }
}

/**
 * `agent start`, asked again while herdr says the pane is busy. A new pane's
 * shell takes a moment to reach its prompt, and herdr is the one that knows
 * when it has; nothing was started while it said busy, so asking again
 * cannot start a second agent.
 *
 * @throws YanError `term_busy` once `busyRetryMs` has passed, or whatever
 *   else the start fails with, at once.
 */
function startWhenReady(ctx: Starting, args: readonly string[]): unknown {
  const deadline = Date.now() + ctx.busyRetryMs;
  for (;;) {
    try {
      return herdrCall(ctx.run, args, 'agent start');
    } catch (err) {
      if (!(isYanError(err)) || err.code !== 'term_busy') throw err;
      if (Date.now() + BUSY_INTERVAL_MS > deadline) {
        throw new YanError('term_busy', `the new pane was not at its shell prompt within ${Math.round(ctx.busyRetryMs / 1000)}s, so no agent was started in it`, { cause: err });
      }
      ctx.sleep(BUSY_INTERVAL_MS);
    }
  }
}

/** Wait for any of `states`, and answer nothing: the caller re-reads. */
function waitFor(ctx: Starting, pane: string, states: readonly AgentStatus[]): void {
  const args = ['agent', 'wait', pane];
  for (const state of states) args.push('--until', state);
  args.push('--timeout', String(ctx.settleMs));
  ctx.run(args);
}

/**
 * Split `at.pane` in half, carrying the agent's `env` and `cwd`, and answer
 * with the new pane. A pane too small to split is Herdr's refusal and
 * surfaces as one; it is never turned into a tab here.
 *
 * @throws YanError when `at.pane` is not a pane id, the split was refused,
 *   or herdr reports no new pane.
 */
function splitPane(run: HerdrRunner, at: SplitAt, options: StartAgentOptions): string {
  requirePaneId(at.pane, 'pane split');
  const args = [
    'pane',
    'split',
    at.pane,
    '--direction',
    at.direction,
    '--ratio',
    '0.5',
    '--no-focus',
    '--cwd',
    nativePath(options.cwd),
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }

  const split = asRecord(herdrCall(run, args, 'pane split'));
  const pane = asString(asRecord(split.pane).pane_id) || asString(split.pane_id);
  if (pane === '') throw YanError.usage('term_usage', `herdr did not report the pane it split off ${at.pane}`);
  return pane;
}

/**
 * Make a tab in the container and answer with its one pane.
 *
 * @throws YanError when the container is not a workspace id, or herdr
 *   reports no root pane.
 */
function createTab(run: HerdrRunner, options: StartAgentOptions): string {
  requireWorkspaceId(options.container, 'tab create');
  const args = [
    'tab',
    'create',
    '--workspace',
    options.container,
    '--no-focus',
    '--cwd',
    nativePath(options.cwd),
  ];
  if (options.label !== undefined && options.label !== '') {
    args.push('--label', options.label);
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }

  const created = asRecord(herdrCall(run, args, 'tab create'));
  const pane = asString(asRecord(created.root_pane).pane_id) || asString(created.root_pane_id);
  if (pane === '') throw YanError.usage('term_usage', 'herdr did not report a root pane for the new tab');
  return pane;
}
