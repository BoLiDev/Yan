/**
 * `tasks/<id>/run/` — the supervision files, and the one definition of
 * "the watcher is healthy" (supervision.md §4, §5).
 *
 * What this module provides, in full:
 *
 *   new Supervision(task)
 *     .run .wake .lock .beacon .guard   where the four files are
 *     .identity()                       what a watcher's lock says
 *     .claimLock() · .releaseLock()     single flight
 *     .lockTaken()                      is a watcher's lock held right now
 *     .healthy(maxBeaconAge?)           …and is it still going round
 *     .why()                            why the last question was answered no
 *     .touchBeacon(state) · .beaconAgeSeconds()
 *     .wakeWrite(reason) · .wakeHas(reason)
 *     .guardCount() · .guardBump() · .guardReset()
 *     .liveShifts() · .liveCount()      remaining supervision responsibility
 *
 *   GUARD_BUDGET   what the turn-end guard may block before it fails open
 *
 * The absence that matters: there is no `subscribed()`. A watcher that is
 * mid-reconnect is not a broken watcher, so health is asked of the LOOP and
 * never of the socket — see `beacon.ts` for the Phase 6 decision that says why.
 */

export { Supervision, GUARD_BUDGET } from './supervision.js';
export { SupervisionError } from './errors.js';
export type { Beacon, WatcherState } from './beacon.js';
