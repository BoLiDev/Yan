/**
 * `log.md` — one of yan's three records (architecture.md §4.2).
 *
 * What this module provides, in full:
 *
 *   new Log(taskId)
 *     .file                  where it is
 *     .init(title?)          create it with its heading, if it is not there yet
 *     .append(text, when?)   the only write there is
 *
 * The absences are the design: there is no set, no replace, no delete, no line
 * index. log.md is append-only, and the way that is enforced is that no method
 * exists to break it.
 */

export { Log } from './log.js';
export { LogError } from './errors.js';
