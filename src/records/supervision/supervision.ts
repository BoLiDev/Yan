import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claim, isHeld, isStale, owner, pidAlive, release } from '../../util/lock.js';
import { Shift } from '../shift/index.js';
import { Task } from '../task/index.js';
import { SupervisionError } from './errors.js';
import { beaconAge, readBeacon, writeBeacon, type WatcherState } from './beacon.js';

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
   * @throws SupervisionError when `task` is empty.
   */
  public constructor(task: string) {
    if (task === '') throw SupervisionError.usage('a task id is required');
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
   * is gone is reclaimed rather than obeyed.
   */
  public claimLock(): boolean {
    this.ensureRun();
    if (claim(this.lock, this.identity())) return true;
    if (!isStale(this.lock)) return false;
    release(this.lock);
    return claim(this.lock, this.identity());
  }

  public releaseLock(): void {
    release(this.lock);
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

    const shellPid = this.shellLockPid();
    const alive = shellPid === undefined ? isHeld(this.lock) : pidAlive(shellPid);
    if (!alive) {
      this.lastWhy = `the lock at ${this.lock} is there but its owner is gone`;
      return false;
    }

    const got = shellPid === undefined ? owner(this.lock)?.identity : this.shellLockIdentity();
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

    const held = owner(this.lock)?.pid ?? this.shellLockPid();
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
   * @throws SupervisionError when `reason` is empty or the file cannot be written.
   */
  public wakeWrite(reason: string): void {
    if (reason === '') throw SupervisionError.usage('a wake needs a reason');
    this.ensureRun();
    try {
      appendFileSync(this.wake, `${reason}\n`);
    } catch (cause) {
      throw new SupervisionError('unwritable', `cannot write the wake file at ${this.wake}`, {
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
      throw new SupervisionError('unwritable', `cannot create ${this.run}`, { cause });
    }
  }

  /**
   * The identity of a directory-shaped lock — a directory holding `pid` and
   * `identity` files, which older watchers wrote. Read, never written.
   */
  private shellLockIdentity(): string | undefined {
    return this.readShellLockFile('identity');
  }

  private shellLockPid(): number | undefined {
    const raw = this.readShellLockFile('pid');
    return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
  }

  private readShellLockFile(name: string): string | undefined {
    try {
      return readFileSync(join(this.lock, name), 'utf8').replace(/\r/g, '').split('\n')[0];
    } catch {
      return undefined;
    }
  }
}
