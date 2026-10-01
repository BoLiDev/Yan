import { spawnSync } from 'node:child_process';

/**
 * What running another program leaves behind: three fields, and a non-zero
 * `code` is a value rather than a throw.
 */
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The code a program that never started comes back with, as a shell has it. */
export const NOT_STARTED = 127;

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Kill it after this long; what is left comes back as a non-zero code. */
  readonly timeoutMs?: number;
}

/**
 * Run a program to its end, capturing both streams. Never throws: a program
 * that will not start is `NOT_STARTED`, with the reason on stderr.
 */
export function runProcess(cmd: string, args: readonly string[], options: RunOptions = {}): ProcessResult {
  const r = spawnSync(cmd, [...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  if (!r.pid) {
    return { code: NOT_STARTED, stdout: '', stderr: r.error?.message ?? `${cmd} did not start` };
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Block the whole thread for `ms`. */
export function sleepMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
