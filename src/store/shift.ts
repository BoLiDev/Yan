import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, closeSync, openSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { YanError, type YanErrorOptions } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { readJsonIfPresent } from '../util/json.js';
import { normalizePath } from '../util/paths.js';
import { taskDir } from './task.js';

/**
 * Storage for `tasks/<id>/shifts/<sid>/` and its throwaway `run/` directory.
 * The TypeScript half of `bin/lib-shift.sh`.
 *
 * Same layer as `task.ts` and `log.ts`: it hides one of yan's OWN file formats,
 * not an outside authority, so it is thin and it decides nothing.
 *
 * Four invariants:
 *
 *   1. `run/status` IS APPENDED PLAIN TEXT, never JSON. It has to survive a
 *      crash without damaging what is already there, and a JSON array cannot do
 *      that.
 *
 *   2. EVERY LINE IN `run/status` IS AN EVENT, NOT THE CURRENT STATE
 *      (agents.md §5.4). There is deliberately NO function here that reads the
 *      last line. A `statusLast()` would be read as "the state" within a week,
 *      and `yan state` derives the state from the live sources instead.
 *      Counting lines is offered; interpreting the newest one is not.
 *
 *   3. `run/meta.json` IS READ DEFENSIVELY. A missing file, a missing key, a
 *      half-written file or a key this phase has never heard of must never
 *      crash a reader, so every read here answers with "I do not know" rather
 *      than failing.
 *
 *   4. The event and the wake marker go together. A shift that reports has done
 *      one thing, not two.
 */

const CODES = {
  usage: 'shift_usage',
  missing: 'shift_missing',
  ambiguous: 'shift_ambiguous',
} as const;

export type ShiftErrorKind = keyof typeof CODES;

/** What resolving or reading a shift can fail with. */
export class ShiftError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: ShiftErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(message: string): ShiftError {
    return new ShiftError('usage', message, { exitCode: 2 });
  }
}

/** Which shift we are pointing at. The bash version's four globals, as a value. */
export interface ShiftRef {
  /** The task id, or '' when the layout did not say. */
  readonly task: string;
  readonly sid: string;
  readonly dir: string;
  readonly run: string;
}

export function isShiftId(sid: string): boolean {
  return sid !== '' && /^[A-Za-z0-9._-]+$/.test(sid);
}

function requireSid(sid: string): string {
  if (!isShiftId(sid)) {
    throw ShiftError.usage(`invalid shift id: '${sid}' - use letters, digits, dot, dash or underscore`,
    );
  }
  return sid;
}

/** Point at a shift by name, existing or not. */
export function shiftUse(task: string, sid: string): ShiftRef {
  requireSid(sid);
  const dir = normalizePath(join(taskDir(task), 'shifts', sid));
  return { task, sid, dir, run: normalizePath(join(dir, 'run')) };
}

/**
 * Find an existing shift.
 *
 * Derived by scanning, never read from an index: `tasks/*​/shifts/<sid>` IS the
 * registry (design principle 1). `$YAN_TASK` narrows the search when it is set,
 * which is the normal case — a yan is task-scoped (agents.md §5.2).
 *
 * An id that exists under two tasks is refused rather than guessed at.
 */
export function shiftResolve(sid: string, task = ''): ShiftRef {
  requireSid(sid);
  const want = task !== '' ? task : (process.env.YAN_TASK ?? '');

  if (want !== '') {
    const ref = shiftUse(want, sid);
    if (!existsSync(ref.dir)) {
      throw new ShiftError('missing', `no such shift: ${sid} in task ${want} - ${ref.dir} does not exist`);
    }
    return ref;
  }

  const tasksDir = join(yanHome(), 'tasks');
  let ids: string[];
  try {
    ids = readdirSync(tasksDir);
  } catch {
    ids = [];
  }
  const hits = ids.filter((id) => existsSync(join(tasksDir, id, 'shifts', sid)));

  if (hits.length === 0) {
    throw new ShiftError('missing', `no such shift: ${sid} - nothing matches ${tasksDir}/*/shifts/${sid}`);
  }
  if (hits.length > 1) {
    throw new ShiftError(
      'ambiguous',
      `shift id '${sid}' exists in more than one task - name the task, for example --task <id>\n${hits
        .map((h) => `  ${h}`)
        .join('\n')}`,
    );
  }
  return shiftUse(hits[0] as string, sid);
}

/**
 * Point at a shift given its directory.
 *
 * The task id is recovered from the path only when the layout says so
 * (`…/<task>/shifts/<sid>`); anywhere else it stays empty and callers that need
 * a task say so themselves. Guessing would be worse than not knowing.
 */
export function shiftResolveDir(dir: string): ShiftRef {
  if (!dir) throw ShiftError.usage('a shift directory is required');
  if (!existsSync(dir)) throw new ShiftError('missing', `no such directory: ${dir}`);
  const abs = normalizePath(resolvePath(dir));
  const parent = dirname(abs);
  const task = basename(parent) === 'shifts' ? basename(dirname(parent)) : '';
  return { task, sid: basename(abs), dir: abs, run: normalizePath(join(abs, 'run')) };
}

/**
 * Find the CALLING shift's own directory.
 *
 * `yan report` takes no <sid>: a shift reports about itself, and asking it to
 * repeat its own id is one more thing to get wrong. So the identity comes from
 * the environment its spawn script set. All three readings are accepted, and
 * none of them is invented later:
 *
 *   YAN_SHIFT_DIR        the shift's own directory (preferred, unambiguous)
 *   YAN_TASK_DIR         the shift's own directory, or the task directory when
 *                        YAN_SID is also set
 *   YAN_TASK + YAN_SID   ids only; resolved by scanning
 */
export function shiftResolveEnv(): ShiftRef | undefined {
  const shiftDir = process.env.YAN_SHIFT_DIR;
  if (shiftDir) return shiftResolveDir(shiftDir);

  const taskDirEnv = process.env.YAN_TASK_DIR;
  const sid = process.env.YAN_SID;
  if (taskDirEnv) {
    const trimmed = taskDirEnv.replace(/[\\/]+$/, '');
    if (existsSync(join(trimmed, 'run')) || basename(dirname(trimmed)) === 'shifts') {
      return shiftResolveDir(trimmed);
    }
    if (sid && existsSync(join(trimmed, 'shifts', sid))) {
      return shiftResolveDir(join(trimmed, 'shifts', sid));
    }
  }
  if (sid) return shiftResolve(sid, process.env.YAN_TASK ?? '');
  return undefined;
}

/** How the selected shift is named in a message. */
export function shiftLabel(ref: ShiftRef): string {
  return ref.task === '' ? ref.sid : `${ref.sid} (task ${ref.task})`;
}

export function shiftMetaFile(ref: ShiftRef): string {
  return join(ref.run, 'meta.json');
}

export function shiftStatusFile(ref: ShiftRef): string {
  return join(ref.run, 'status');
}

export function shiftSignalFile(ref: ShiftRef): string {
  return join(ref.run, 'signal');
}

/**
 * Zero while `run/` still exists.
 *
 * `run/` is the only throwaway layer and clocking out deletes it whole
 * (td INDEX.md §3), so its presence IS the fact. Nothing mirrors it.
 */
export function shiftIsLive(ref: ShiftRef): boolean {
  return existsSync(ref.run);
}

// --- reading run/meta.json --------------------------------------------------

/**
 * The first of the given keys that has a usable value.
 *
 * Several keys because the spelling of the terminal id is the dispatching
 * phase's decision: a reader that accepts `pane` and `pane_id` costs one loop
 * and cannot be wrong about it.
 *
 * `undefined` when the file is missing, unreadable, not JSON, or has none of
 * the keys — never an exception. That is invariant 3.
 */
export function shiftMetaGet(ref: ShiftRef, ...keys: readonly string[]): string | undefined {
  let raw: unknown;
  try {
    raw = readJsonIfPresent(shiftMetaFile(ref));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const meta = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return undefined;
}

export function shiftMetaUnit(ref: ShiftRef): string | undefined {
  return shiftMetaGet(ref, 'unit');
}
export function shiftMetaBranch(ref: ShiftRef): string | undefined {
  return shiftMetaGet(ref, 'branch');
}
export function shiftMetaTree(ref: ShiftRef): string | undefined {
  return shiftMetaGet(ref, 'tree');
}
export function shiftMetaAgent(ref: ShiftRef): string | undefined {
  return shiftMetaGet(ref, 'agent');
}

/**
 * The terminal id the seam printed. A pane id is preferred over a window id
 * because it is the more precise of the two. NEVER a label: a label is not a
 * source of truth (agents.md §5.7 practice 1, terminal.md §3).
 */
export function shiftMetaAgentId(ref: ShiftRef): string | undefined {
  return shiftMetaGet(ref, 'pane', 'pane_id', 'window', 'window_id', 'agent_id', 'term_id');
}

export function shiftMetaMr(ref: ShiftRef): string | undefined {
  return shiftMetaGet(ref, 'mr', 'mr_url');
}

/**
 * The merge request URL the shift reported, if any.
 *
 * delivery.md §8.2 gives `mr` mode the final state `done: mr <url>`, so the URL
 * reaches yan through the note of a `done` event. This does NOT break invariant
 * 2: the verdict "has it merged?" still comes from the forge and only from the
 * forge. What is read here is a FACT the shift recorded — an address — which is
 * exactly what an event log is for. The last URL wins because a shift that
 * reopened its MR reported the newer one later.
 */
export function shiftReportedMr(ref: ShiftRef): string | undefined {
  const file = shiftStatusFile(ref);
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const urls = text.match(/https?:\/\/\S+/g);
  return urls === null ? undefined : urls[urls.length - 1];
}

// --- run/status -------------------------------------------------------------

/**
 * How many events have been reported.
 *
 * A count, not a verdict. It tells you whether anything has happened; it says
 * nothing about what the shift is doing now (invariant 2).
 */
export function shiftEventCount(ref: ShiftRef): number {
  const file = shiftStatusFile(ref);
  if (!existsSync(file)) return 0;
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').length;
  } catch {
    return 0;
  }
}

/**
 * One event, then the wake marker, in that order and in one call.
 *
 * THE ORDER IS NOT ARBITRARY. Signal first would mean a crash in between leaves
 * a marker pointing at nothing: yan wakes, finds no new event, clears the
 * signal — and the event that lands afterwards is then never announced to
 * anyone. Event first means a crash in between leaves a recorded event that
 * nobody was woken for, and supervision's other source catches a shift that
 * crashed mid-report.
 *
 * The line is written by ONE append on purpose. A short single write to a file
 * opened with O_APPEND is not interleaved with another writer's, whereas three
 * writes into the same file are three chances to end up with half a line.
 */
export function shiftEventAppend(ref: ShiftRef, state: string, note = ''): void {
  if (!state) throw ShiftError.usage('an event needs a state');
  if (`${state}${note}`.includes('\n')) {
    throw ShiftError.usage('an event is one line - a newline would forge a second event');
  }
  mkdirSync(ref.run, { recursive: true });

  const ts = `${new Date().toISOString().slice(0, 19)}Z`;
  appendFileSync(shiftStatusFile(ref), `${ts}\t${state}\t${note}\n`);

  const signal = shiftSignalFile(ref);
  if (existsSync(signal)) {
    const now = new Date();
    utimesSync(signal, now, now);
  } else {
    closeSync(openSync(signal, 'a'));
  }
}

/** Every live shift of a task, in id order. `run/` present is the fact. */
export function liveShifts(task: string): ShiftRef[] {
  const dir = join(taskDir(task), 'shifts');
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((sid) => isShiftId(sid) && existsSync(join(dir, sid, 'run', 'meta.json')))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((sid) => shiftUse(task, sid));
}
