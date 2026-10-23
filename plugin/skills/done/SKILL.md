---
name: done
description: Close the current yan task and give its worktrees back, when the user says the task is finished.
disable-model-invocation: true
---

# done

Close the task with `yan done`. That marks it done and returns its worktrees to the pool, which resets and cleans them.

- **Leave the deliverables alone.** The user marks them; never run `yan deliverable` here.
- If `yan done` refuses because a worktree has uncommitted changes or commits no remote branch has, look at what they are. When something looks like work the task meant to keep and never committed or pushed (changes to the code the deliverables are about, commits on the task's branch that never reached origin), list it for the user and stop. Anything else (build output, debug leftovers, a lockfile touched by an install, scratch files) is thrown away with `yan done --force`.
