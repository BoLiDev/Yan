/**
 * Who is running this command. Two variables answer it, and nothing else
 * does: `yan continue` exports `YAN_TASK` into the pane it starts the main
 * agent in, and the spawn step sets `YAN_SID` in every shift's environment.
 * `user`'s own shell carries neither.
 */

/**
 * Whether the caller is the main agent of this task — not `user` at a
 * terminal, not a shift, and not the yan of a different task.
 *
 * It decides who may clear a shift's `run/undelivered`: a report is deleted
 * once it has been read by the one reader it was for, and `user` glancing at
 * `yan show` must not swallow it.
 */
export function isMainAgentOf(task: string): boolean {
  if (task === '') return false;
  if ((process.env.YAN_SID ?? '') !== '') return false;
  return (process.env.YAN_TASK ?? '') === task;
}
