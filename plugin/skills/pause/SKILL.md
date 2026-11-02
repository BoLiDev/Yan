---
name: pause
description: Put the current yan task aside, its work saved and its worktrees given back, when the user says to pause it.
disable-model-invocation: true
---

# pause

The task is put aside for now, to be taken up again later, here or on another machine: nothing of it may be lost, and nothing of it keeps taking room on this machine.

1. **Save the work.** In each worktree, commit what the task means to keep and has not committed, as a work-in-progress commit if it is not finished, on the task's branch, and push it. Keep that branch with `yan branch` if the task does not keep it yet: `yan context` says when it does not. A worktree with no work of its own needs nothing.
2. **Say where it stands**, in one line a later session can pick up from: `yan log paused "<where the work is, and what comes next>"`.
3. **Pause it** with `yan pause`. That gives the worktrees back and marks the task paused; `yan resume` takes it up again.

- **Leave the deliverables alone.** The user marks them; never run `yan deliverable` here.
- If `yan pause` refuses because a worktree still has uncommitted changes or commits no remote branch has, look at what they are. Work the task means to keep is committed and pushed, as in step 1; when it cannot be, list it for the user and stop. Anything else (build output, debug leftovers, a lockfile touched by an install, scratch files) is thrown away by running it again with `--force`.
