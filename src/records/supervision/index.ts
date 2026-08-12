/**
 * `tasks/<id>/run/` — the supervision files, and the one definition of
 * "the watcher is healthy".
 *
 * The absence that matters: there is no `subscribed()`. Health is asked of the
 * LOOP — is the beacon still being touched — and never of the socket, because a
 * watcher that is mid-reconnect is still watching and would fail a socket
 * check.
 */

export { Supervision, GUARD_BUDGET } from './supervision.js';
export { SupervisionError } from './errors.js';
export type { Beacon, WatcherState } from './beacon.js';
