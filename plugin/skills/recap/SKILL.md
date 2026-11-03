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

- `yan context`: the problem in full, the deliverables, the resources, the task's folder and its artifacts, how many deliverables have something to check them by, for each repository the worktree, the branch it is on and where it stands, and the user's newest drafts.
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
- **Resources.** What the work refers to is kept under a name with `yan resource`, for later sessions to find, each as its kind: spec (the ticket, PRD or design the task comes from), mr (as soon as one is opened), preview (a link that opens the version with this work for the user to check the result on, which `yan:uat` gives), run (a sub-task started elsewhere), or general.
- **Branches.** yan never makes a branch, and never takes one for the task's by itself: which branches are the task's is yours to say. Put a worktree on a detached HEAD on a branch, named the way this repository and this machine expect, before committing in it, and keep it at once with `yan branch`; later sessions, on any machine, start the worktree on the branch kept last. **One branch is in progress for each app the task changes**: one in a repository of one app, and in a monorepo one for each app or package the task changes, whichever the monorepo is divided into, the worktree switching between them. The work on an app stays on its branch, a fix, a second try or a next step included; cut another only for another app, or once the app's branch is merged and new work on it begins. When the work on an app moves to another branch, or stops, mark the old one with `yan branch abandon <name>` at once, so one stays in progress for it. A branch only to try something out, or to look at old code, stays out of the worktree, in a directory of its own, and is not kept. `yan context` lists the task's branches and where each stands, and says when the worktree is on one the task does not keep.
- **Drafts.** The user's drafts are their own notes, written outside the conversation and shared by every task, so most are about other work: `yan context` lists the newest by title. Read one with `yan draft cat <id>` when its title touches this task, opening the pictures it names by their path, and take it as the user's thinking, not a decision made; raise what it changes with the user. Never write, change or remove one: they are the user's alone.
- **Once it is built.** When an implementation is done and its result can be verified interactively, use `yan:uat`: it gathers what the user checks each deliverable by and hands the task to them.

`yan --help` lists every command, and `yan <command> --help` says how each is used.
