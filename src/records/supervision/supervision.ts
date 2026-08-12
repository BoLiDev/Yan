import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claim, isHeld, isStale, owner, pidAlive, release } from '../../util/lock.js';
import { Shift } from '../shift/index.js';
import { Task } from '../task/index.js';
import { SupervisionError } from './errors.js';
import { beaconAge, readBeacon, writeBeacon, type WatcherState } from './beacon.js';

/**
 * `tasks/<id>/run/` — the four files supervision keeps, and the predicates that
 * read them.
 *
 * This is not a layer over the wait sources. Nothing here polls and nothing
 * here decides; the sources live in `yan wait`. What is here is the format, so
 * that `yan wait`, the Stop autoarm and the turn-end guard cannot drift about
 * where the files are or about what "the watcher is healthy" means. Three
 * private copies of that predicate is exactly how a guard and a watcher end up
 * disagreeing about who is on duty.
 *
 *   run/wake            the reason, carried from "wait exited" to the model's
 *                       next turn. `yan wait` writes it, `yan drain` clears it
 *   run/wait.lock       the single-flight lock, on util/lock.ts's scheme and
 *                       never a second one
 *   run/beacon          attendance for the watcher; see beacon.ts
 *   run/guard-failures  the turn-end guard's own count, because Claude's
 *                       `stop_hook_active` cannot be trusted as a one-shot
 *
 * All four belong to the task, because supervision is per-yan and a yan is
 * per-task — which is also where `yan drain` already looks.
 */

/** How old the beacon may be before the watcher stops counting as healthy. */
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

  /**
   * Why the last health question was answered no.
   *
   * Read it straight after asking, because every later predicate overwrites it.
   * It is a sentence for a human or for the model; nothing branches on it.
   */
  private lastWhy = '';

  public constructor(task: string) {
    if (task === '') throw SupervisionError.usage('a task id is required');
    this.task = task;
    // $YAN_WATCH_DIR and $YAN_WAKE_FILE override exactly as they do in
    // `yan drain`, so no test can point the two commands at different files.
    this.run = process.env.YAN_WATCH_DIR ?? join(new Task(task).dir, 'run');
    this.wake = process.env.YAN_WAKE_FILE ?? join(this.run, 'wake');
    this.lock = join(this.run, 'wait.lock');
    this.beacon = join(this.run, 'beacon');
    this.guard = join(this.run, 'guard-failures');
  }

  public why(): string {
    return this.lastWhy;
  }

  /**
   * What the single-flight lock must say to count as a watcher.
   *
   * `tasks/<id>/.enter.lock` proves why this is needed: a live lock in the same
   * tree that has nothing to do with supervision.
   */
  public identity(): string {
    return `yan-wait ${this.task}`;
  }

  /** Take the single-flight lock, stamped so it can be told from any other lock. */
  public claimLock(): boolean {
    this.ensureRun();
    if (claim(this.lock, this.identity())) return true;
    // A lock left behind by a process that is gone is reclaimed, not obeyed: a
    // machine that lost power mid-watch should not need a manual `rm`.
    // `isStale` only ever says yes about a lock file whose owner is gone, so
    // this cannot delete a directory-shaped lock somebody is standing in.
    if (!isStale(this.lock)) return false;
    release(this.lock);
    return claim(this.lock, this.identity());
  }

  public releaseLock(): void {
    release(this.lock);
  }

  /**
   * The lock exists, its owner is alive, and it is a watcher's lock.
   *
   * Deliberately says nothing about the beacon. This is the guard's 800 ms
   * question — "was the lock taken while I waited?" — and a watcher that has
   * just claimed the lock has not necessarily finished its first loop yet.
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
   * "The watcher is healthy": the lock exists and its owner is alive, the
   * identity matches, and the beacon is fresh — and the beacon belongs to the
   * process holding the lock, so that neither half can vouch for the other:
   *
   *   live watcher pid + stale beacon      not healthy (it stopped looping)
   *   fresh beacon + no/dead/foreign lock  not healthy (a leftover file)
   *
   * A watcher whose subscription has dropped and is being re-established is
   * healthy. It is still going round the loop, and its liveness poll never went
   * through the socket in the first place; blocking a turn for the seconds it
   * takes to reconnect would be the guard inventing a fault (beacon.ts).
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

  /** One turn of the watcher's loop happened, just now. */
  public touchBeacon(state: WatcherState, now = Date.now()): void {
    this.ensureRun();
    writeBeacon(this.beacon, this.task, state, now);
  }

  public beaconAgeSeconds(now = Date.now()): number | undefined {
    return beaconAge(this.beacon, now);
  }

  /**
   * One reason, appended.
   *
   * Appended rather than overwritten: two shifts can become interesting between
   * one drain and the next, and the second must not erase the first. `yan drain`
   * prints the file whole and then clears it.
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

  /**
   * Is this exact reason already waiting to be drained?
   *
   * The level-triggered sources — the agent is gone, the agent is blocked —
   * stay true until somebody acts on them, so without this a rearmed watcher
   * would wake the model again the instant it started, for ever. An undrained
   * reason means the model has already been told.
   */
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

  /** Count one blocked attempt and answer with the new total. */
  public guardBump(): number {
    const next = this.guardCount() + 1;
    this.ensureRun();
    writeFileSync(this.guard, `${next}\n`);
    return next;
  }

  /**
   * The watcher is healthy again, or there is nothing left to supervise. Either
   * way the budget starts over.
   */
  public guardReset(): void {
    rmSync(this.guard, { force: true });
  }

  /**
   * The shifts still being supervised.
   *
   * Derived by scanning every time it is called, so a shift dispatched while
   * the watcher is already looping is picked up on the next turn, and one that
   * clocks out drops off it. "Live" is the shift record's own rule — `run/` is
   * deleted whole at clock-out — and not a second copy of it.
   */
  public liveShifts(): Shift[] {
    return Shift.liveIn(this.task);
  }

  /**
   * How many shifts are still being supervised.
   *
   * This is "supervision responsibility": the guard's primary question on
   * Codex, and half of it on Claude.
   */
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
   * The identity of a directory-shaped lock: a directory holding `pid` and
   * `identity` files, rather than the single file `util/lock.ts` writes.
   *
   * Read, never written. Nothing in this repository takes a lock this way any
   * more; what it buys is that a guard meeting one does not conclude "no
   * watcher is on duty" and block every turn.
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
