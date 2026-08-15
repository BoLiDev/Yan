import { Task } from '../../records/task/index.js';

/**
 * Run a call that only affects what Herdr displays. Never throws: a failure
 * becomes one line on stderr and the caller carries on.
 */
export function display(what: string, call: () => void): void {
  try {
    call();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`yan: ${what} (display only, carrying on): ${message}\n`);
  }
}

/** The display tokens describing one unit. */
export function unitTokens(task: string, unit: string, branch: string): Record<string, string> {
  return { task, unit, branch };
}

/**
 * The display tokens for a task: the unit and branch too when it has exactly
 * one unit, and the task alone otherwise.
 */
export function taskTokens(task: string): Record<string, string> {
  let units;
  try {
    units = new Task(task).read().units;
  } catch {
    return { task };
  }
  const only = units.length === 1 ? units[0] : undefined;
  return only === undefined ? { task } : unitTokens(task, only.name, only.branch);
}

export const UNIT_TOKEN_NAMES = ['task', 'unit', 'branch'] as const;
