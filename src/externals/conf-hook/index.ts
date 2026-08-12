/**
 * `<vault>/hooks/` — `user`'s own tooling, and one of yan's outside authorities
 * (boundaries.md §10, architecture.md §4.3).
 *
 * What this module provides, in full:
 *
 *   callHook(name, context) → string | undefined
 *     the hook's one-line answer, or `undefined` when no such hook is
 *     installed. A hook that exits non-zero throws `HookError` with code
 *     `hook_refused`, and the caller must STOP rather than use its own default.
 *
 *   hookExists(name) · hookPath(name)
 *
 * It is an external and not a utility because it is an outside authority with
 * its own vocabulary: it reports a fact — a name — and decides nothing about
 * what yan then does with it. Being a module is also what makes "only this code
 * may execute anything in there" a rule the boundary lint can hold.
 *
 * Not to be confused with `src/hooks/`, which is yan's own end of the two Stop
 * hooks the agent harnesses run.
 */

export { callHook, hookExists, hookPath, resolveHook } from './hook.js';
export { HookError } from './errors.js';
