import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { Supervision, type WatcherState } from '../records/supervision/index.js';
import { readPulse, writePulse } from '../records/shift/index.js';
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
 * `yan wait` — the watcher. Unbounded, or stopping dead at `--seconds N`; the
 * sources are the same either way.
 *
 *   signal        run/signal exists      the shift reported via `yan report`
 *   agent-status  a Herdr subscription   blocked / done, seen from outside
 *   agent-alive   a liveness poll        the agent died and cannot say so
 *
 * A pure observer, holding no durable state: killing it loses nothing. It
 * writes only other people's channels — the wake file, the single-flight lock,
 * the beacon — plus each shift's `run/pulse`, which nothing here ever decides
 * from.
 *
 * `signal` is edge-triggered, so its marker is removed once the reason is
 * written down. The others are level-triggered and stay true until somebody
 * acts, so an identical reason still undrained in the wake file suppresses a
 * second one.
 *
 * Exit codes
 *
 *     0  something actionable happened; the reason is on stdout and in the
 *        wake file
 *   124  a --seconds slice ended quietly while shifts are still being watched
 *     3  there is nothing (left) to supervise
 *     4  another watcher already holds the single-flight lock
 *     2  called wrongly            1  it did not work
 */

/** What `yan wait --sources` prints. */
export const WAIT_SOURCES = ['signal', 'agent-status', 'agent-alive'] as const;

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_CHECKPOINT_SECONDS = 180;

/** How many lines of a pane's tail the pulse digests. */
const PULSE_LINES = 40;

/**
 * How often a pane is read, which is far less often than the loop turns. The
 * throttle is the pulse file's own `seen`, so a restarted watcher does not
 * resample everything at once.
 */
const PULSE_EVERY_SECONDS = 15;

/** What `yan wait` needs from the terminal. `Terminal` is the real one. */
export interface StatusReader {
  list(container?: string): readonly { readonly pane: string; readonly status: AgentStatus }[];
  agentAlive(pane: string): 'alive' | 'dead' | 'unknown';
  read(pane: string, lines?: number): string;
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
  /** Where a degraded-mode note goes; stderr by default. */
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
 * Watch until something actionable happens, returning the exit code and the
 * reason rather than exiting. Falls back to polling when the event stream is
 * not available, and never throws for a terminal it cannot reach.
 */
export async function watch(options: WatchOptions): Promise<WatchResult> {
  const sup = new Supervision(options.task);
  const interval = Math.max(0.05, options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000;
  const bounded = options.seconds !== undefined;
  const deadline = bounded ? Date.now() + (options.seconds ?? 0) * 1000 : Number.POSITIVE_INFINITY;
  const note = options.note ?? ((line: string) => process.stderr.write(`wait: ${line}\n`));

  if (sup.liveCount() === 0) return { code: 3 };

  // Single flight: one watcher per task, or the model is woken twice over.
  if (sup.lockTaken()) {
    return { code: 4, reason: `another watcher is already on duty for task ${options.task}` };
  }
  if (!sup.claimLock()) {
    return { code: 4, reason: 'another watcher took the single-flight lock first' };
  }

  // Registered only now, so a watcher that refused to start cannot release a
  // lock it never took. Being killed has to leave the lock behind for nobody.
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

  const asked = new Set<string>();

  /**
   * Subscribe to every live pane that is not subscribed yet, and that herdr
   * currently lists — an id it does not know closes the whole connection,
   * taking every other pane's subscription with it.
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
    // Subscribe, then snapshot: a subscription is an edge trigger, so a shift
    // that went `blocked` before anybody was listening needs the snapshot.
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
      takePulses(terminal, live);
      for (const event of arrived.splice(0)) status.set(event.pane, event.status);
      // Without a subscription the status has to be asked for: same facts, one
      // poll late.
      if (state !== 'subscribed') snapshot(terminal, status);

      const found = look(sup, terminal, live, status);
      if (found !== undefined) {
        // Written down before the marker is consumed: a crash in between
        // repeats a wake, where the other order would lose one.
        sup.wakeWrite(found.reason);
        if (found.consume !== undefined) rmSync(found.consume, { force: true });
        return { code: 0, reason: found.reason };
      }

      if (live.length === 0) return { code: 3 };
      if (bounded && Date.now() >= deadline) return { code: 124 };

      if (dropped || !events.connected) {
        // Re-subscribed from disk rather than from memory: shifts may have
        // come and gone while the connection was down.
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
        // A shift dispatched while this watcher was looping has a new pane.
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
 * The first actionable thing any live shift shows, or undefined. Per shift, in
 * order: a reported signal, a dead agent, then its status —
 *
 *   blocked  → wake: it is sitting on an approval or a question
 *   done     → wake, to look; never a verdict
 *   idle | working | unknown  → not actionable
 *
 * A reason already waiting undrained in the wake file is skipped.
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

    // `unknown` is never rounded up to `dead`.
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
      // A plan-approval prompt also arrives as `done`, so this is a reason to
      // look and never a verdict.
      const reason =
        `done: ${shift.sid} - herdr reports unseen work finished. Look before acting: ` +
        `a shift clocks out only once its merge request has merged into the integration branch`;
      if (!sup.wakeHas(reason)) return { reason };
      continue;
    }
  }
  return undefined;
}

/**
 * Digest every live shift's terminal into its `run/pulse`, at most once per
 * PULSE_EVERY_SECONDS. Never throws: a pane that cannot be read is skipped.
 */
function takePulses(terminal: StatusReader, live: readonly Watched[]): void {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  for (const shift of live) {
    if (shift.pane === '') continue;
    const previous = readPulse(shift.run);
    if (previous !== undefined && seconds - previous.seen < PULSE_EVERY_SECONDS) continue;
    try {
      writePulse(shift.run, terminal.read(shift.pane, PULSE_LINES), now);
    } catch {
      continue;
    }
  }
}

/**
 * Merge one `agent list` into the status map. Never throws: a terminal that
 * cannot be reached leaves the map as it was.
 */
function snapshot(terminal: StatusReader, into: Map<string, AgentStatus>): void {
  let listed: readonly { readonly pane: string; readonly status: AgentStatus }[];
  try {
    listed = terminal.list();
  } catch {
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
 * The panes a subscription can carry. A shift whose recorded pane is not an id
 * — a dispatch mid-flight, or an older record — is dropped, and keeps
 * `run/signal` and the liveness poll.
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
          // Only the bounded shape says so: its caller is a model that has to
          // know to stop slicing, where a quiet end must wake nobody.
          process.stderr.write(
            `wait: nothing to supervise in task ${task} - every shift has clocked out\n`,
          );
        }
        process.exitCode = result.code;
      },
    ),
  );
