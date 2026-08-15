/**
 * `tasks/<id>/run/` — the supervision files, and the one definition of
 * "the watcher is healthy".
 */

export { Supervision, GUARD_BUDGET } from './supervision.js';
export { SupervisionError } from './errors.js';
export type { Beacon, WatcherState } from './beacon.js';
