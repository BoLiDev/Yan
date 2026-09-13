import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claim, evict, isHeld, isStale, owner, release } from '../../util/lock.js';
import { Shift } from '../shift/index.js';
import { Task } from '../task/index.js';
import { beaconAge, readBeacon, writeBeacon, type WatcherState } from './beacon.js';
import { YanError } from '../../util/error.js';

/**
 * The four files under `tasks/<id>/run/` that supervision keeps, and the
 * predicates that read them. Nothing here polls or decides; the wait sources
 * live in `yan wait`.
 *
 *   run/wake            wake reasons, written by `yan wait`, cleared by `yan drain`
 *   run/wait.lock       the single-flight lock, on util/lock.ts's scheme
 *   run/beacon          the watcher's attendance; see beacon.ts
 *   run/guard-failures  how often the turn-end guard has blocked
 */

/** How old the beacon may be, from `$YAN_WATCH_BEACON_MAX` or 300 seconds. */
function beaconMaxSeconds(): number {
  const configured = Number(process.env.YAN_WATCH_BEACON_MAX ?? '');
  return Number.isFinite(configured) && configured > 0 ? configured : 300;
}

/** What the turn-end guard may block before it gives up and fails open. */
export const GUARD_BUDGET = 3;

export class Supervision {
  public readonly task: string;
  public readonly run: string;
  public readonly wake: string;
  public readonly lock: string;
  public readonly beacon: string;
  public readonly guard: string;

  private lastWhy = '';

  /**
   * `$YAN_WATCH_DIR` and `$YAN_WAKE_FILE` override where the files are looked
   * for, and `yan drain` honours the same two.
   *
   * @throws YanError when `task` is empty.
   */
  public constructor(task: string) {
    if (task === '') throw YanError.usage('supervision_usage', 'a task id is required');
    this.task = task;
    this.run = process.env.YAN_WATCH_DIR ?? join(new Task(task).dir, 'run');
    this.wake = process.env.YAN_WAKE_FILE ?? join(this.run, 'wake');
    this.lock = join(this.run, 'wait.lock');
    this.beacon = join(this.run, 'beacon');
    this.guard = join(this.run, 'guard-failures');
  }

  /**
   * Why the most recent `lockTaken` or `healthy` answered no — a sentence for
   * a reader, overwritten by every later call, empty after a yes.
   */
  public why(): string {
    return this.lastWhy;
  }

  /** The stamp a lock must carry to count as this task's watcher. */
  public identity(): string {
    return `yan-wait ${this.task}`;
  }

  /**
   * Take the single-flight lock, stamped with `identity()`. A lock whose owner
   * is gone is reclaimed rather than obeyed, and so is one whose owner is a
   * watcher that has stopped looping: it is killed first, because a watcher
   * holds nothing that a fresh one cannot rebuild from disk, and a session
   * with a hung watcher is a session nothing is supervising.
   */
  public claimLock(): boolean {
    this.ensureRun();
    if (claim(this.lock, this.identity())) return true;
    if (!isStale(this.lock)) {
      if (this.stoppedLooping() === '' || !evict(this.lock)) return false;
    }
    release(this.lock);
    return claim(this.lock, this.identity());
  }

  /**
   * Give the lock back, when it is this process's to give. A watcher on its
   * way out after being evicted must not take the lock its replacement holds.
   */
  public releaseLock(): void {
    if (owner(this.lock)?.pid === process.pid) release(this.lock);
  }

  /**
   * `lockTaken()`, and the holder has not stopped looping. This is the
   * question before arming a watcher: a lock held by a hung one is not a
   * reason to stand down, since `claimLock()` will replace it. Sets `why()`.
   */
  public onDuty(): boolean {
    if (!this.lockTaken()) return false;
    const why = this.stoppedLooping();
    this.lastWhy = why;
    return why === '';
  }

  /**
   * Why the lock's holder, alive and stamped as this task's watcher, is not
   * looping any more — or `''` when it is, or when the holder is this
   * process, which cannot judge itself. A watcher's first act in its loop is
   * to write the beacon, so a lock older than the beacon's limit with no
   * beacon at all is a watcher that hung before its first turn.
   */
  private stoppedLooping(maxBeaconAge = beaconMaxSeconds()): string {
    const holder = owner(this.lock);
    if (holder === undefined || holder.pid === process.pid || holder.identity !== this.identity()) return '';

    // A beacon from another pid is a previous watcher's, not this holder's.
    const age = readBeacon(this.beacon)?.pid === holder.pid ? beaconAge(this.beacon, Date.now()) : undefined;
    if (age === undefined) {
      const lockAge = Math.floor(Date.now() / 1000) - holder.at;
      return lockAge > maxBeaconAge
        ? `the watcher (pid ${holder.pid}) took the lock ${lockAge}s ago and has never written a beacon`
        : '';
    }
    if (age > maxBeaconAge) {
      return `the watcher (pid ${holder.pid}) last wrote its beacon ${age}s ago (more than ${maxBeaconAge}s)`;
    }
    return '';
  }

  /**
   * The lock exists, its owner is alive, and it carries `identity()`. Says
   * nothing about the beacon, so a watcher mid-first-loop passes. Sets
   * `why()`.
   */
  public lockTaken(): boolean {
    this.lastWhy = '';
    if (!existsSync(this.lock)) {
      this.lastWhy = `no single-flight lock at ${this.lock}`;
      return false;
    }

    if (!isHeld(this.lock)) {
      this.lastWhy = `the lock at ${this.lock} is there but its owner is gone`;
      return false;
    }

    const got = owner(this.lock)?.identity;
    if (got !== this.identity()) {
      this.lastWhy = `the lock at ${this.lock} belongs to '${got === undefined || got === '' ? 'something unstamped' : got}', not to '${this.identity()}'`;
      return false;
    }
    return true;
  }

  /**
   * `lockTaken()`, plus a beacon no older than `maxBeaconAge` seconds written
   * by the same pid that holds the lock. A watcher whose subscription has
   * dropped still counts as healthy. Sets `why()`.
   */
  public healthy(maxBeaconAge = beaconMaxSeconds()): boolean {
    if (!this.lockTaken()) return false;

    const age = beaconAge(this.beacon, Date.now());
    if (age === undefined) {
      this.lastWhy = `the watcher holds the lock but has written no beacon at ${this.beacon}`;
      return false;
    }
    if (age > maxBeaconAge) {
      this.lastWhy = `the beacon is ${age}s old (more than ${maxBeaconAge}s): a live pid is not proof that it is still looping`;
      return false;
    }

    const held = owner(this.lock)?.pid;
    const wrote = readBeacon(this.beacon)?.pid;
    if (held !== undefined && wrote !== undefined && held !== wrote) {
      this.lastWhy = `the beacon was written by pid ${wrote} but the lock is held by pid ${held}`;
      return false;
    }
    this.lastWhy = '';
    return true;
  }

  /** Record that the watcher went round its loop, stamping `state` and `now`. */
  public touchBeacon(state: WatcherState, now = Date.now()): void {
    this.ensureRun();
    writeBeacon(this.beacon, this.task, state, now);
  }

  public beaconAgeSeconds(now = Date.now()): number | undefined {
    return beaconAge(this.beacon, now);
  }

  /**
   * Append one reason to the wake file, keeping any already waiting there.
   *
   * @throws YanError when `reason` is empty or the file cannot be written.
   */
  public wakeWrite(reason: string): void {
    if (reason === '') throw YanError.usage('supervision_usage', 'a wake needs a reason');
    this.ensureRun();
    try {
      appendFileSync(this.wake, `${reason}\n`);
    } catch (cause) {
      throw new YanError('supervision_unwritable', `cannot write the wake file at ${this.wake}`, {
        cause,
      });
    }
  }

  /** Is this exact line already waiting to be drained? */
  public wakeHas(reason: string): boolean {
    if (reason === '' || !existsSync(this.wake)) return false;
    try {
      return readFileSync(this.wake, 'utf8')
        .split(/\r?\n/)
        .some((line) => line === reason);
    } catch {
      return false;
    }
  }

  public guardCount(): number {
    if (!existsSync(this.guard)) return 0;
    try {
      const digits = readFileSync(this.guard, 'utf8').replace(/[^0-9]/g, '');
      return digits === '' ? 0 : Number(digits);
    } catch {
      return 0;
    }
  }

  /** Count one blocked attempt and return the new total. */
  public guardBump(): number {
    const next = this.guardCount() + 1;
    this.ensureRun();
    writeFileSync(this.guard, `${next}\n`);
    return next;
  }

  /** Start the guard's budget over. */
  public guardReset(): void {
    rmSync(this.guard, { force: true });
  }

  /** The task's live shifts, re-scanned on every call. */
  public liveShifts(): Shift[] {
    return Shift.liveIn(this.task);
  }

  /** How many shifts are still live. */
  public liveCount(): number {
    return this.liveShifts().length;
  }

  private ensureRun(): void {
    try {
      mkdirSync(this.run, { recursive: true });
    } catch (cause) {
      throw new YanError('supervision_unwritable', `cannot create ${this.run}`, { cause });
    }
  }
}
