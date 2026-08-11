import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { YanError, type YanErrorOptions } from './error.js';

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
 * Three callers, and there must never be a fourth without a reason written
 * down:
 *
 *   1. THE WORKTREE POOL, per clone. See `src/externals/worktree/` for why it
 *      needs one at all — the short version is that `git worktree add` writes
 *      the shared clone's `.git/config`, so it is not concurrency-safe against
 *      one repository even when the slot allocation is.
 *   2. SUPERVISION'S SINGLE FLIGHT. Under Claude every Stop can fire autoarm,
 *      and without it several watchers start.
 *   3. `yan continue`'S PER-TASK ENTER LOCK, which is new in Phase 8 and is not
 *      the same kind of thing as the other two. They serialise a critical
 *      section; this one IS THE ANSWER to a question — is a yan already running
 *      on this task? The MVP could not use a lock for that, because the process
 *      holding it exited long before the agent did. V2's `yan continue` lives
 *      exactly as long as the main agent it started, so the file's own pid is
 *      the fact, and `pidAlive` makes a killed yan's lock reclaimable rather
 *      than permanent.
 *
 * They want two shapes of the same lock, which is why there are two entry
 * points and not two schemes: the pool wraps a body (`withLock`), while
 * supervision and `continue` hold it across something long (`claim` /
 * `release`).
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
  /**
   * What the lock is FOR, when the caller said.
   *
   * A lock file records who holds it and cannot know why. `tasks/<id>/run/wait.lock`
   * and `tasks/<id>/.enter.lock` are two live locks in the same tree with nothing
   * to do with each other, so supervision has to be able to ask "is this a
   * WATCHER's lock" and not merely "is a lock there" (supervision.md §5).
   */
  identity?: string;
}

/** What a holder can say about itself when it claims a lock. */
export interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly at: number;
  readonly identity?: string;
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

/**
 * Is this process still there?
 *
 * Signal 0 reports success for a live process we may not signal (EPERM), which
 * is the conservative direction: we would rather leave a lock alone than steal
 * one that is still held.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when a DIRECTORY sits at the lock path.
 *
 * That is `bin/lib-lock.sh`'s scheme, and for the length of the migration both
 * halves are on disk. The two are not compatible and are not meant to be
 * (conventions §4 says port neither scheme onto the other), but a TypeScript
 * caller that finds the shell half's lock must read it as "somebody holds this"
 * and leave it alone — never as a stale file to reclaim, which would mean
 * `rm`-ing a directory another process is standing in.
 */
function isShellLock(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Who holds this lock, as far as the file says. `undefined` when there is no lock. */
export function owner(file: string): LockOwner | undefined {
  if (!existsSync(file)) return undefined;
  const record = readRecord(file);
  if (record === undefined || typeof record.pid !== 'number') return undefined;
  return record;
}

/** True when the file exists but nobody owns it any more. */
export function isStale(file: string): boolean {
  if (!existsSync(file)) return false;
  if (isShellLock(file)) return false;
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

/**
 * Take the lock if it is free, and say so. Never waits, never throws.
 *
 * The scoped `withLock` below is the shape most callers want. This one exists
 * for the single caller that cannot use it: `yan wait` holds the lock for the
 * whole life of an asynchronous watcher, and a body-shaped helper would release
 * it the moment that body returned a promise rather than a result.
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

/** Give the lock back. Releasing a lock that is already gone is not an error. */
export function release(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // A lock we cannot remove is a worse problem than a lock we hold, but not
    // one the holder can do anything about on its way out.
  }
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
    if (claim(file)) break;
    if (isStale(file)) {
      // Reclaim and try again immediately. A losing racer simply fails its own
      // exclusive create on the next turn of this loop.
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
