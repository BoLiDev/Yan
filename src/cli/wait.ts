import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { Supervision, type WatcherState } from '../records/supervision/index.js';
import { Task } from '../records/task/index.js';
import { Terminal } from '../externals/herdr/index.js';
import {
  TerminalEvents,
  isPaneId,
  type AgentStatus,
  type AgentStatusEvent,
} from '../externals/herdr/index.js';
import { CommandError } from './shared/errors.js';
import { action, out } from './shared/action.js';

/**
 * `yan wait` — the watcher (supervision.md §2, architecture.md §5.1).
 *
 * ONE COMMAND, TWO SHAPES, AND A PURE OBSERVER
 *
 *   yan wait                 Claude's Stop autoarm runs this IN THE HOOK'S
 *                            FOREGROUND for minutes to hours
 *   yan wait --seconds N     the Codex model calls this as a foreground tool;
 *                            it stops dead at N so the model gets control back
 *
 * Same sources either way. The only difference is when it gives up.
 *
 * It holds NO DURABLE STATE OF ITS OWN. A timeout, a kill, or dying with its
 * process tree loses nothing: the shift is still in its own pane and every fact
 * it acted on is a file somebody else owns. The three things it writes are all
 * somebody else's channel — the wake file the model drains, the single-flight
 * lock, and the beacon other processes read.
 *
 * THE SOURCES, AND WHY THERE ARE THREE WORDS FOR TWO CHANNELS
 *
 *   signal        run/signal exists         the shift reported via `yan report`
 *   agent-status  a Herdr subscription      blocked / done, observed from
 *                                           outside, without the shift saying
 *                                           anything
 *   agent-alive   termAgentAlive = dead     the agent died and cannot say so
 *
 * The MVP's third source — the pane's content hash — IS GONE. Herdr recognises
 * an approval or a question UI directly, which is what the hash was standing in
 * for, and it does it far better than "these bytes stopped changing".
 *
 * The liveness poll is NOT gone, and that is not an oversight: `pane_exited` is
 * in Herdr's event schema but not in its subscription schema, and `events.wait`
 * refuses it too (evidence §11.2). "The agent died" has no push channel on this
 * build, so it stays a poll for as long as that is true.
 *
 * There is deliberately NO FOURTH SOURCE. yan does not poll pull requests or
 * CI, because a shift does not wait for CI before clocking out. When every
 * shift has clocked out and outbound CI is running there is nothing here to
 * wait for — the next `yan session-start` asks the forge. A known and accepted
 * gap, not an omission.
 *
 * EDGE-TRIGGERED VERSUS LEVEL-TRIGGERED
 *
 * `signal` is an edge: this command is its only reader, so it writes the reason
 * down and THEN removes the marker. A crash in between repeats a wake; the
 * reverse order would lose one.
 *
 * Everything else is a level. A dead agent stays dead and a blocked agent stays
 * blocked until somebody acts, so a reason still sitting undrained in the wake
 * file suppresses an identical one — or a rearmed watcher would wake the model
 * again the instant it started, for ever.
 *
 * EXIT CODES
 *
 *     0  something actionable happened; the reason is on stdout and in the wake
 *        file. Claude's autoarm turns this into a rewake; Codex drains and acts
 *   124  a --seconds slice ended quietly while shifts are still being watched
 *     3  there is nothing (left) to supervise. SILENT in the unbounded shape
 *     4  another watcher already holds the single-flight lock
 *     2  called wrongly            1  it did not work
 */

/** The whole list. `yan wait --sources` prints it, and nothing else may add to it. */
export const WAIT_SOURCES = ['signal', 'agent-status', 'agent-alive'] as const;

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_CHECKPOINT_SECONDS = 180;

/** What `yan wait` needs from the terminal: a status snapshot and a liveness verdict. */
export interface StatusReader {
  list(container?: string): readonly { readonly pane: string; readonly status: AgentStatus }[];
  agentAlive(pane: string): 'alive' | 'dead' | 'unknown';
}

/** What `yan wait` needs from the event stream. `TerminalEvents` is the real one. */
export interface EventSource {
  readonly connected: boolean;
  open(): Promise<void>;
  subscribe(panes: readonly string[]): Promise<void>;
  reconnect(panes?: readonly string[]): Promise<void>;
  onStatus(handler: (event: AgentStatusEvent) => void): void;
  onClosed(handler: () => void): void;
  close(): void;
}

export interface WatchOptions {
  readonly task: string;
  /** Unbounded when absent. */
  readonly seconds?: number;
  readonly intervalSeconds?: number;
  readonly terminal?: StatusReader;
  readonly events?: EventSource;
  /** Where a degraded-mode note goes. Separated so a test can read it. */
  readonly note?: (line: string) => void;
}

export interface WatchResult {
  readonly code: 0 | 3 | 4 | 124;
  readonly reason?: string;
}

interface Watched {
  readonly sid: string;
  readonly run: string;
  readonly pane: string;
}

/**
 * The watcher, without the process around it.
 *
 * Separated from the Commander command for one reason: a test drives this and
 * gets a result back, where driving the command would mean driving
 * `process.exit`. Everything that decides anything is here.
 */
export async function watch(options: WatchOptions): Promise<WatchResult> {
  const sup = new Supervision(options.task);
  const interval = Math.max(0.05, options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
  const bounded = options.seconds !== undefined;
  const deadline = bounded ? Date.now() + (options.seconds ?? 0) * 1000 : Number.POSITIVE_INFINITY;
  const note = options.note ?? ((line: string) => process.stderr.write(`wait: ${line}\n`));

  if (sup.liveCount() === 0) return { code: 3 };

  // Single flight. Under Claude every Stop can fire autoarm, so without this a
  // busy session ends up with several watchers, each able to wake the model for
  // the same fact.
  if (sup.lockTaken()) {
    return { code: 4, reason: `another watcher is already on duty for task ${options.task}` };
  }
  if (!sup.claimLock()) {
    return { code: 4, reason: 'another watcher took the single-flight lock first' };
  }

  // Only now, because a watcher that refused to start must never release the
  // lock it did not take. A watcher IS meant to be killable — it is the process
  // tree of a hook the harness owns — so dying has to leave the lock behind for
  // nobody.
  const letGo = (): void => {
    sup.releaseLock();
  };
  const onSignal = (code: number): void => {
    letGo();
    process.exit(code);
  };
  const onInterrupt = (): void => {
    onSignal(130);
  };
  const onTerminate = (): void => {
    onSignal(143);
  };
  process.on('exit', letGo);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  const terminal = options.terminal ?? new Terminal();
  const events = options.events ?? new TerminalEvents();

  const arrived: AgentStatusEvent[] = [];
  const status = new Map<string, AgentStatus>();
  let dropped = false;
  let rouse: (() => void) | undefined;
  const stir = (): void => {
    const wake = rouse;
    rouse = undefined;
    if (wake !== undefined) wake();
  };

  events.onStatus((event) => {
    arrived.push(event);
    stir();
  });
  events.onClosed(() => {
    dropped = true;
    stir();
  });

  /** The panes this watcher has a subscription for, so it does not ask twice. */
  const asked = new Set<string>();

  /**
   * Subscribe to every live pane that is not subscribed yet.
   *
   * ONLY PANES HERDR CURRENTLY LISTS ARE ASKED ABOUT, and that is not caution:
   * a subscription naming a pane the server does not know is not refused with
   * an error — **the server closes the connection**, taking every other pane's
   * subscription with it (evidence §12.1). A stale pane id in `run/meta.json`
   * would otherwise cost the whole watcher its event stream, once per turn,
   * for ever. The snapshot is what says which panes are real.
   */
  const subscribeToNew = async (live: readonly Watched[]): Promise<void> => {
    const missing = panesOf(live).filter((pane) => !asked.has(pane));
    if (missing.length === 0) return;
    snapshot(terminal, status);
    const real = missing.filter((pane) => status.has(pane));
    if (real.length === 0) return;
    await events.subscribe(real);
    for (const pane of real) asked.add(pane);
  };

  try {
    // SUBSCRIBE, THEN SNAPSHOT, THEN BLOCK. The last snapshot is what closes
    // the window for a `yan wait` starting up over shifts that are already
    // running: a subscription is an edge trigger, so a shift that went
    // `blocked` before anybody was listening would never be reported
    // (evidence §11.5).
    let state: WatcherState = 'polling';
    try {
      await events.open();
      await subscribeToNew(sup.liveShifts().map(toWatched));
      state = 'subscribed';
    } catch (err) {
      note(
        `herdr's event stream is not available (${err instanceof Error ? err.message : String(err)}) - ` +
          `falling back to polling agent status. 'blocked' will be seen a poll late, not the moment it happens`,
      );
    }
    snapshot(terminal, status);

    for (;;) {
      sup.touchBeacon(state);

      const live = sup.liveShifts().map(toWatched);
      for (const event of arrived.splice(0)) status.set(event.pane, event.status);
      // Without a subscription the status has to be asked for. Same facts, one
      // poll late (the Phase 5 gate's fallback), and never a content hash.
      if (state !== 'subscribed') snapshot(terminal, status);

      const found = look(sup, terminal, live, status);
      if (found !== undefined) {
        // The reason is written down BEFORE the marker is consumed: a crash in
        // between repeats a wake, and repeating one is free.
        sup.wakeWrite(found.reason);
        if (found.consume !== undefined) rmSync(found.consume, { force: true });
        return { code: 0, reason: found.reason };
      }

      if (live.length === 0) return { code: 3 };
      if (bounded && Date.now() >= deadline) return { code: 124 };

      if (dropped || !events.connected) {
        // A subscription that ends is reconnected and re-subscribed FROM DISK,
        // not from what this process happened to be holding: shifts may have
        // come and gone while the connection was down. The snapshot on the way
        // back in closes the window the reconnect opened, exactly as the one at
        // startup does.
        state = 'reconnecting';
        sup.touchBeacon(state);
        asked.clear();
        try {
          await events.reconnect([]);
          await subscribeToNew(live);
          snapshot(terminal, status);
          state = 'subscribed';
          dropped = false;
        } catch (err) {
          state = 'polling';
          note(
            `the event subscription ended and could not be re-established (${err instanceof Error ? err.message : String(err)}) - ` +
              `still watching, on the poll`,
          );
          dropped = false;
        }
      } else if (state === 'subscribed') {
        // A pane may have appeared since the last turn: a shift dispatched
        // while this watcher was already looping still has to be subscribed to.
        try {
          await subscribeToNew(live);
        } catch {
          dropped = true;
        }
      }

      await rest(Math.min(interval, bounded ? Math.max(50, deadline - Date.now()) : interval), (wake) => {
        rouse = wake;
      });
      rouse = undefined;
    }
  } finally {
    events.close();
    sup.releaseLock();
    process.off('exit', letGo);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

interface Found {
  readonly reason: string;
  /** A file to remove once the reason is safely written down. */
  readonly consume?: string;
}

/**
 * What the sources say, in the order a stronger fact beats a weaker one.
 *
 * The mapping is supervision.md §3, complete:
 *
 *   blocked  → escalate: the shift is sitting on an approval or a question
 *   done     → wake, and look. NEVER a verdict — see below
 *   idle     → not actionable: the tab has been seen, so `user` already knows
 *   working  → not actionable: normal
 *   unknown  → not actionable: explicitly not a completion signal
 */
function look(
  sup: Supervision,
  terminal: StatusReader,
  live: readonly Watched[],
  status: ReadonlyMap<string, AgentStatus>,
): Found | undefined {
  for (const shift of live) {
    const signal = join(shift.run, 'signal');
    if (existsSync(signal)) {
      return {
        reason: `signal: ${shift.sid} - the shift reported - 'yan state ${shift.sid}' says what is true now`,
        consume: signal,
      };
    }

    if (shift.pane === '') continue;

    // `unknown` is never rounded up to `dead`: where the terminal cannot tell,
    // yan says so and keeps watching.
    let alive: 'alive' | 'dead' | 'unknown';
    try {
      alive = terminal.agentAlive(shift.pane);
    } catch {
      alive = 'unknown';
    }
    if (alive === 'dead') {
      const reason = `died: ${shift.sid} - the agent is gone and could not report it`;
      if (!sup.wakeHas(reason)) return { reason };
      continue;
    }

    const seen = status.get(shift.pane);
    if (seen === 'blocked') {
      const reason = `blocked: ${shift.sid} - herdr sees an approval or a question on its terminal`;
      if (!sup.wakeHas(reason)) return { reason };
      continue;
    }
    if (seen === 'done') {
      // DONE IS A REASON TO LOOK, NEVER A VERDICT. The plan-approval prompt
      // arrives as `done` because no screen rule matches it (evidence §11.3),
      // so a shift parked on a plan approval looks exactly like a shift that
      // has finished — and clocking out is destructive. Rule 3 is the objective
      // condition, and this sentence is here because this is where it would be
      // forgotten.
      const reason =
        `done: ${shift.sid} - herdr reports unseen work finished. Look before acting: ` +
        `a shift clocks out only once its merge request has merged into the integration branch`;
      if (!sup.wakeHas(reason)) return { reason };
      continue;
    }
  }
  return undefined;
}

/** One `agent list` for every live pane's status. The snapshot, and the poll. */
function snapshot(terminal: StatusReader, into: Map<string, AgentStatus>): void {
  let listed: readonly { readonly pane: string; readonly status: AgentStatus }[];
  try {
    listed = terminal.list();
  } catch {
    // A terminal yan cannot reach is not a reason to stop watching: run/signal
    // still works, and the next turn asks again.
    return;
  }
  for (const agent of listed) {
    if (agent.pane !== '') into.set(agent.pane, agent.status);
  }
}

function toWatched(shift: { sid: string; run: string; meta: () => { agentId?: string } }): Watched {
  return { sid: shift.sid, run: shift.run, pane: shift.meta().agentId ?? '' };
}

/**
 * The panes a subscription can carry.
 *
 * A shift dispatched by the tmux half carries a `%7`, which Herdr never issued
 * and a subscription is refused whole for — so one legacy pane would cost every
 * other shift its subscription. Those shifts keep `run/signal`, which is all a
 * Herdr-less pane ever had.
 */
function panesOf(live: readonly Watched[]): string[] {
  return live.map((s) => s.pane).filter((pane) => isPaneId(pane));
}

/** Sleep, unless an event arrives first. */
function rest(ms: number, register: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    register(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function wholeSeconds(value: string, what: string): number {
  if (!/^\d+$/.test(value)) {
    throw CommandError.usage('wait', `${what} takes a whole number of seconds, got: ${value}`);
  }
  return Number(value);
}

export const command = new Command('wait')
  .description('watch the live shifts until something actionable happens')
  .argument('[task-id]', 'defaults to $YAN_TASK')
  .option('--task <id>', 'the task to watch')
  .option('--seconds [n]', 'stop after N seconds whatever happens (the Codex checkpoint slice)')
  .option('--interval <s>', 'how often to look')
  .option('--sources', 'print the sources this watches, one per line, and exit')
  .action(
    action(
      'wait',
      async (
        id: string | undefined,
        options: { task?: string; seconds?: string | boolean; interval?: string; sources?: boolean },
      ) => {
        if (options.sources === true) {
          for (const source of WAIT_SOURCES) out(source);
          return;
        }

        const task = id ?? options.task ?? process.env.YAN_TASK ?? '';
        if (task === '') {
          throw CommandError.usage(
            'wait',
            'cannot tell which task to watch - pass a task id, or set $YAN_TASK as the task container does',
          );
        }
        if (!new Task(task).exists()) {
          throw CommandError.usage('wait', `no such task: ${task}`);
        }

        let seconds: number | undefined;
        if (options.seconds !== undefined && options.seconds !== false) {
          seconds =
            options.seconds === true
              ? wholeSeconds(process.env.YAN_CODEX_CHECKPOINT ?? String(DEFAULT_CHECKPOINT_SECONDS), '$YAN_CODEX_CHECKPOINT')
              : wholeSeconds(options.seconds, '--seconds');
          if (seconds < 1) {
            throw CommandError.usage('wait', `--seconds takes at least 1 second, got: ${seconds}`);
          }
        }

        const intervalSeconds =
          options.interval === undefined
            ? Number(process.env.YAN_WAIT_INTERVAL ?? DEFAULT_INTERVAL_SECONDS)
            : Number(options.interval);
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
          throw CommandError.usage('wait', `--interval takes seconds, got: ${String(options.interval)}`);
        }

        const result = await watch({ task, seconds, intervalSeconds });

        if (result.code === 0 && result.reason !== undefined) out(result.reason);
        if (result.code === 4 && result.reason !== undefined) {
          process.stderr.write(`wait: ${result.reason} - not starting a second one\n`);
        }
        if (result.code === 3 && seconds !== undefined) {
          // The bounded shape says so on stderr, because the Codex model is the
          // caller and needs to know to stop slicing. The unbounded shape is
          // SILENT: a quiet end there must not wake anybody.
          process.stderr.write(
            `wait: nothing to supervise in task ${task} - every shift has clocked out\n`,
          );
        }
        process.exitCode = result.code;
      },
    ),
  );
