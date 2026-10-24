---
name: recap
description: Use at the start of every session on a task kept by yan ($YAN_TASK is set), before other work, to learn what the task is and where it stands, and whenever the user asks where a task stands. Reads yan's notes and the code, and holds the rules for keeping the notes as the work goes.
---

# recap

A task kept by yan has its notes in the vault, a git repository yan commits and pushes as the session goes. We think about a task in three parts, each with its note:

- the **problem**, problem.md: the background, and what is wrong or wanted
- the **solution**, the deliverables: how things must be once it is solved
- the **decisions** that steered it, the log

The problem and the solution are worked out with the user, not assumed, and either may change as the work goes. Which task it is travels in `$YAN_TASK`, which every `yan` command reads.

## Read

- `yan context`: the problem in full, the deliverables, the resources, the task's folder and its artifacts, how many deliverables have something to check them by, and for each repository the worktree, the branch it is on and where it stands.
- `yan log`: the decisions, oldest first. The latest `paused` and `changed` lines usually say where the work stopped.
- `yan uat`: which deliverables have something to check them by.

It is where to start, not all there is: for more, go to the task's files and the code itself. Where the notes and the code disagree, **the code wins**: a branch the log calls unpushed that is on origin, a log line waiting on something the code has since done. Check the worktree and its git history before saying something is or is not done.

## Say

**At the start of a session**, on your own: read, and say nothing about it unless the notes are out of date, then say where in a line, and go on with what the user asked. Don't fix the notes on your own.

**When the user asks where the task stands**: in the user's language, short and plain, in this order:

1. **The problem**: what is wrong or wanted, in two or three sentences.
2. **The solution**: the agreed approach in one paragraph, not the deliverable list again.
3. **Done**: what is finished and where it is (merged, pushed, on a branch only).
4. **Not done**: what is left, each in a line.
5. **Waiting on the user**: decisions and questions left open, each in a line, with your recommendation where you have one.

Name deliverables by id with a few words (d5 launch test) so the user can find them, and keep it to what fits on one screen. Skip a section with nothing in it. This changes nothing: no deliverable is marked, no note rewritten, nothing committed.

## Working in the task

These hold for the whole session.

- **Notes.** When the problem or the solution changes, rewrite its note to say how things stand now, as if writing it for the first time; what it used to say goes in the log with `yan log`. Working them out with the user is `yan:define`.
- **Files.** The task's own files are in its folder, which `yan context` names: problem.md, and artifacts/ for whatever the work produces worth keeping. Designs of what the user sees (pages, canvases, mockups, palettes, icons, and the scripts that build them) go in artifacts/design/. Written documents (a technical design, research notes, a review, a handoff, a diagram of a system) go in artifacts/docs/. artifacts/uat/ is `yan:uat`'s. Anything else worth keeping, such as a script, a query or data pulled for a check, goes in artifacts/misc/; nothing sits loose in artifacts/ but the report `yan:uat` writes. What can be made again and only takes room, such as installed dependencies, a checkout of old code or frames decoded from a video, stays out of the task's folder. An artifact redone replaces its file rather than sitting beside it; the vault's history keeps the old one.
- **Resources.** What the work refers to is kept under a name with `yan resource`, for later sessions to find, each as its kind: spec (the ticket, PRD or design the task comes from), mr (as soon as one is opened), preview (a test link to the deployed version, after each deploy the user is to look at), run (a sub-task started elsewhere), or general.
- **Branches.** yan never makes a branch: a worktree on a detached HEAD has to be put on a branch, named the way this repository and this machine expect, before committing in it. yan keeps every branch the worktree is on for the task, so a later session starts the worktree on the last one; a task may have several in progress in one repository, the worktree switching between them. Each stays in progress until it is merged: when the work leaves one for good, for another branch, mark it with `yan branch abandon <name>`.
- **Once it is built.** When an implementation is done and its result can be verified interactively, use `yan:uat`: it gathers what the user checks each deliverable by and hands the task to them.

`yan --help` lists every command, and `yan <command> --help` says how each is used.
