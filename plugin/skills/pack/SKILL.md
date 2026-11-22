---
name: pack
description: Pack the current yan task into a zip the user gives by hand to an agent working elsewhere, such as one in the cloud, when the user says to pack it or hand it over.
disable-model-invocation: true
---

# pack

The vault may be local, kept on this machine alone, so an agent working elsewhere cannot read the task from it. The user carries the task to that agent as one zip. That agent has no yan: all it knows of the task is what the zip holds, and all it has of the code is what the repository's remote has.

1. **Push the code.** In each worktree, commit what the task means to keep and has not committed, as a work-in-progress commit if it is not finished, on the task's branch, and push it. Keep that branch with `yan branch` if the task does not keep it yet: `yan context` says when it does not. The pack names the branches the task keeps and carries none of the code.
2. **Bring the notes up to date.** The other agent starts from them alone, with nobody to ask what happened here. Rewrite problem.md if it no longer says how things stand, and say in the log where the work is and what the other agent takes up: `yan log changed "handed to another agent: <where the work is, and what comes next>"`.
3. **Pack it** with `yan pack`. It writes the zip outside the vault and the worktrees and prints where. Add `--no-artifacts` when the artifacts are too large to carry and the work to come does not need them. Add `--drafts` only when the user asks for their drafts to go too.
4. **Tell the user** the zip's full path, in one line, and what to do with it: give it to the other agent, which reads the README.md at its top first.

- **The zip leaves this machine in the user's hands only.** Never upload it, send it or attach it anywhere yourself.
- **Leave the deliverables alone**, and the task open: packing changes nothing in the vault but the notes of step 2.
- **When the user brings back what the other agent did**, put it where it belongs: each decision in the log with `yan log`, a merge request or a link with `yan resource`, a branch it cut with `yan branch`. What it says is met is for the user to mark.
