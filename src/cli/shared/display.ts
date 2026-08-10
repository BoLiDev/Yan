import { Shift } from '../../records/shift/index.js';

/**
 * Telling Herdr what it is looking at (display.md §4).
 *
 * ---------------------------------------------------------------------------
 * THESE CALLS ARE NEVER FATAL
 * ---------------------------------------------------------------------------
 *
 * Herdr receives presentation, never truth. `task.json` remains the only record
 * of which unit is on which branch; a token or a title is a copy for human
 * eyes, and a copy that goes stale is a cosmetic bug rather than a correctness
 * one.
 *
 * So every call goes through here, and here swallows the failure into one line
 * on stderr. An orchestrator that will not dispatch a shift because a title did
 * not stick is a worse orchestrator (orchestration.md §3), and the way to make
 * sure nobody writes that by accident is to give the calls one door that cannot
 * throw.
 */
export function display(what: string, call: () => void): void {
  try {
    call();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`yan: ${what} (display only, carrying on): ${message}\n`);
  }
}

/**
 * Which workspace this task's panes live in, DERIVED from a live shift's
 * `run/meta.json` — never created.
 *
 * `createContainer` would make one, and a command that only wants to relabel
 * has no business creating a workspace. So the answer is "the container a live
 * shift recorded", and `undefined` when nothing is running: there is then
 * nothing on screen to relabel, which is not a failure.
 */
export function containerOf(task: string): string | undefined {
  for (const shift of Shift.liveIn(task)) {
    const container = shift.meta().container;
    if (container !== undefined && container !== '') return container;
  }
  return undefined;
}

/** The tokens display.md §2 defines, in one place so the two writers agree. */
export function unitTokens(task: string, unit: string, branch: string): Record<string, string> {
  return { task, unit, branch };
}

export const UNIT_TOKEN_NAMES = ['task', 'unit', 'branch'] as const;
