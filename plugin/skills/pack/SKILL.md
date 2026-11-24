---
name: pack
description: Hand part of the current yan task to an agent working elsewhere, such as one in the cloud, as a pack the user carries to it by hand, when the user says to pack the task or hand it over.
disable-model-invocation: true
---

# pack

The task's notes may be local, kept on this machine alone, so an agent working elsewhere cannot read them and must not be given a way to. The user carries what it needs to it by hand, as one file. That agent has no yan and nobody to ask what happened here: all it knows is what the pack says.

Agree three things with the user before packing anything. Propose an answer to each from what you know of the task, shortly, and let them correct it; do not pack until they have said yes.

1. **What the other agent takes up.** The whole task, or a part of it: which deliverables, which repository, up to what point. Say what stays here.
2. **What it has to know for that.** The decisions already made that bind it, where the work stands, what to leave alone, which of the task's artifacts it needs, and anything that is only in this conversation or in your head. Leave out what the work does not need: the pack leaves this machine, so less is better.
3. **The form.** A zip, for an agent that can be given files: the task's notes and the artifacts agreed. Or one document, for an agent that is given text: the same notes in a single Markdown file, with no artifact.

Then:

1. **Push the code** the other agent builds on: in each worktree it will work in, commit what the task means to keep, on the task's branch, kept with `yan branch`, and push it. The pack names the branches and carries no code.
2. **Write the brief**, a Markdown file outside the vault and the worktrees (the system's temporary folder will do), saying what was agreed in 1 and 2 as instructions to the other agent: what it is asked to do, what it must know, what it must leave alone. Write it for a reader with no context.
3. **Pack** with `yan pack --brief <file>`, adding `--doc` for one document, `--artifact <path>` for each artifact agreed (without it every artifact goes; `--no-artifacts` for none), and `--drafts` only if the user asked for their drafts to go.
4. **Say where the pack is**, its full path in one line, and that the user gives it to the other agent themselves.
5. **Note the handover** in the log: `yan log progress "handed to another agent: <what it takes up>"`.

- **The pack leaves this machine in the user's hands only.** Never upload it, send it or attach it anywhere yourself.
- **Leave the deliverables alone**, and the task open.
- **When the user brings back what the other agent did**, put it where it belongs: what it did toward a deliverable, and any change of scope, in the log with `yan log`, a merge request or a link with `yan resource`, a branch it cut with `yan branch`. What it says is met is for the user to mark.
