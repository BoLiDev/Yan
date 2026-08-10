import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { YanError } from './error.js';

/**
 * The one locking primitive in yan. The TypeScript half of `bin/lib-lock.sh`.
 *
 * plan/conventions.md §4: `lib-lock.sh` used `mkdir` because Git Bash has no
 * `flock` and `noclobber` is not reliably atomic on MSYS2 filesystems. In Node
 * the primitive is `fs.open(path, 'wx')` — an atomic exclusive create on both
 * platforms — so the lock is a FILE, and the owner's identity is its contents
 * rather than three files inside a directory.
 *
 *   {"pid": 1234, "host": "…", "at": 1786342616}
 *
 * Stale locks: a holder that died leaves the file behind. `process.kill(pid, 0)`
 * is the liveness test; it reports success for a live process we may not signal
 * (EPERM), which is the conservative direction — we would rather leave a lock
 * alone than steal one that is still held. Only locks taken on THIS machine are
 * reclaimed, because a pid from another host means nothing here.
 *
 * Two callers, and there must never be a third without a reason written down:
 * the worktree pool, and supervision's single-flight. See `src/seams/pool/`
 * for why the pool needs one at all — the short version is that
 * `git worktree add` writes the shared clone's `.git/config`, so it is not
 * concurrency-safe against one repository even when the slot allocation is.
 */

export const LOCK_TIMEOUT = 'lock_timeout';

interface LockRecord {
  pid: number;
  host: string;
  at: number;
}

/** A lock with no pid stamp yet is given this long before it is reclaimable. */
const UNSTAMPED_GRACE_SECONDS = 10;

function sleepMs(ms: number): void {
  // Synchronous on purpose: everything around it is synchronous file I/O, and
  // an async lock would infect every caller for no benefit.
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

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the file exists but nobody owns it any more. */
export function isStale(file: string): boolean {
  if (!existsSync(file)) return false;
  const record = readRecord(file);
  if (record === undefined || typeof record.pid !== 'number') {
    // No stamp. Either a competitor is between its create and its write, or a
    // crash left a truncated file. Age decides, and the answer is "not stale"
    // while it could still be the former.
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

/** True when the lock exists AND its owner is still alive. */
export function isHeld(file: string): boolean {
  return existsSync(file) && !isStale(file);
}

function tryAcquire(file: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o644);
  } catch {
    return false;
  }
  try {
    writeSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), at: Math.floor(Date.now() / 1000) })}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Run `body` while holding `file`, and release it however `body` ends.
 *
 * Throws a `YanError` with code `lock_timeout` when the lock could not be taken
 * within `timeoutSeconds` — a timeout is a real condition a caller has to see,
 * not something to work around.
 */
export function withLock<T>(file: string, timeoutSeconds: number, body: () => T): T {
  const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;

  for (;;) {
    if (tryAcquire(file)) break;
    if (isStale(file)) {
      // Reclaim and try again immediately. A losing racer simply fails its own
      // exclusive create on the next turn of this loop.
      rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const record = readRecord(file);
      throw new YanError(
        LOCK_TIMEOUT,
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
