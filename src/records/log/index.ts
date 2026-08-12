/**
 * `tasks/<id>/log.md`.
 *
 * The absences are the design: no set, no replace, no delete, no line index.
 * log.md is append-only, and that is enforced by there being no method capable
 * of breaking it.
 */

export { Log } from './log.js';
export { LogError } from './errors.js';
