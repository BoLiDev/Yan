import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { YanError, type YanErrorOptions } from './error.js';

/**
 * The one locking primitive in yan: a file created exclusively, holding the
 * owner's stamp.
 *
 *   {"pid": 1234, "host": "…", "at": 1786342616, "identity": "…"}
 *
 * Two shapes of the same lock — `withLock` wraps a body, `claim`/`release`
 * hold one across something longer. A lock whose owner died is reclaimable,
 * but only when it was taken on this machine: a pid from another host is not
 * ours to judge.
 */

const CODES = { timeout: 'lock_timeout' } as const;

export type LockErrorKind = keyof typeof CODES;

/** What waiting for a lock can fail with. */
export class LockError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: LockErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }
}

interface LockRecord {
  pid: number;
  host: string;
  at: number;
  /** What the lock is for, when the claimer said. */
  identity?: string;
}

export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
  readonly identity?: string;
}

/** A lock with no pid stamp yet is given this long before it is reclaimable. */
const UNSTAMPED_GRACE_SECONDS = 10;

/** Blocks the thread. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readRecord(file: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as LockRecord;
  } catch {
    return undefined;
  }
}

/**
 * Is this process still there? A process running as another user counts as
 * alive, so the answer errs towards "held".
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when a directory sits at the lock path — the older scheme, which
 * nothing here writes and which is never reclaimed as stale.
 */
function isShellLock(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Who the lock file says holds it; undefined when absent or unstamped. */
export function owner(file: string): LockOwner | undefined {
  if (!existsSync(file)) return undefined;
  const record = readRecord(file);
  if (record === undefined || typeof record.pid !== 'number') return undefined;
  return record;
}

/**
 * True when the file exists but nobody owns it any more. A directory-shaped
 * lock, one held on another host, and one whose stamp is younger than ten
 * seconds all count as held.
 */
export function isStale(file: string): boolean {
  if (!existsSync(file)) return false;
  if (isShellLock(file)) return false;
  const record = readRecord(file);
  if (record === undefined || typeof record.pid !== 'number') {
    // Unstamped: a competitor may be between its create and its write.
    let age = 0;
    try {
      age = (Date.now() - statSync(file).mtimeMs) / 1000;
    } catch {
      return false;
    }
    return age > UNSTAMPED_GRACE_SECONDS;
  }
  if (record.host !== hostname()) return false;
  return !pidAlive(record.pid);
}

/** True when the lock exists and its owner is still alive. */
export function isHeld(file: string): boolean {
  return existsSync(file) && !isStale(file);
}

/**
 * Take the lock if it is free, and say whether it was taken. Never waits,
 * never throws, and never reclaims a stale lock — the caller decides that.
 * Prefer `withLock` unless the lock outlives a single call.
 */
export function claim(file: string, identity?: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o644);
  } catch {
    return false;
  }
  try {
    const record: LockRecord = {
      pid: process.pid,
      host: hostname(),
      at: Math.floor(Date.now() / 1000),
      ...(identity === undefined ? {} : { identity }),
    };
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Give the lock back. Never throws, including for a lock already gone. */
export function release(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Swallowed: nothing a holder on its way out can do about it.
  }
}

/**
 * Run `body` while holding `file`, releasing it however `body` ends. Waits for
 * a held lock and reclaims a stale one.
 *
 * @throws LockError `lock_timeout` when the lock was still held after
 *   `timeoutSeconds`. `body` never runs in that case.
 */
export function withLock<T>(file: string, timeoutSeconds: number, body: () => T): T {
  const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;

  for (;;) {
    if (claim(file)) break;
    if (isStale(file)) {
      rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const record = readRecord(file);
      throw new LockError(
        'timeout',
        `timed out after ${timeoutSeconds}s waiting for ${file}` +
          (record === undefined ? '' : ` (held by pid ${record.pid} on ${record.host})`),
      );
    }
    sleepMs(50);
  }

  try {
    return body();
  } finally {
    rmSync(file, { force: true });
  }
}
