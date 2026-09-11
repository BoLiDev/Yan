# 4. Memory

`yan` keeps no state of its own, so everything a task knows between sessions is in its files. The instructions (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) each carry a Memory section that tells the main agent what to write and when; this document says why it has that shape. Only the main agent remembers. A shift's `outcome.md` is a handover to `yan`, not memory.

One test decides every write, and every trigger below is a case of it: **if `yan` were killed now, would the next one, reading only these files, ask `user` something already answered, or walk into something already hit?**

## 4.1 Who may write what

`user.md` and the files under `learnings/` are written under different rules. A wrong entry in `learnings/` is cheap: the next time `yan` runs into the same thing, it corrects the file. Asking `user` for permission every time would just mean nothing ever gets written down. `user.md` is different, because it records judgements about a person; a wrong entry there keeps misleading `yan` for a long time.

So `yan` may write `learnings/` on its own, and `user.md` only when `user` explicitly asks for it. A rule `user` states about the environment is a learning too. Most hard-won lessons are hit by a shift, not by `yan`, so a shift's `outcome.md` has a Learnings section — the problems it hit and how it solved them. Whether one becomes a file in `mem/learnings/` is decided by `yan` and `user` together, not by the shift that hit it: a shift sees one task, and it writes nothing to `mem/`, which keeps one writer and one standard. Turning learnings into skills is `user`'s job, done deliberately rather than mid-task: a skill written in passing is a poor skill.

The full table of who writes each file, when, who reads it, and when, is in [Appendix A](appendix.md#appendix-a-memory-read-and-write-contract).

## 4.2 Triggers, not frequency

The first version said `log.md` was "one line per event" and left the rest to judgement, partly on purpose — an agent told to record everything floods the log. In practice the main agent sometimes recorded nothing at all: under Claude a long task gathered two hundred hand-written lines, and after the switch to Gemini, whose instructions said nothing about the log, tasks gathered almost none.

"Record often" cannot be followed, because it never says *this* is the moment. A trigger can: *when X happens, write Y*. And a list of triggers is also what keeps the log small, because whatever is not on the list is not written. So every file an agent writes has its triggers named, and so does what it must not write.

## 4.3 `log.md`, the task's story

JSON is a bad fit for "how far along are we". A separate `progress.md` is no better, because it would eventually disagree with everything else. So progress lives in an append-only log, one line per event, and each line carries one of six types:

```markdown
# t110 df-blade-v1.1

- 09-01  agreed     user chose copy-at-creation over live inheritance; solo/squad are the only two values
- 09-01  started    s1 df-blade  dispatched on yan/t110-df-blade-s1 (claude in …) — mark icons bigger and solid
- 09-01  delivered  s1 df-blade  https://github.com/…/pull/34 merged into the integration branch — icons 16px with a knockout
- 09-01  changed    s5 aborted: user kept the two-press C marking; #39 closed, nothing merged
- 09-01  incident   s1–s3 parked on the folder-trust dialog; trusted the clone and pool slots → mem/learnings/claude-folder-trust.md
- 09-01  paused     user is away; standing tree kept for trying it out, nothing landed on main
```

| Type | Written when |
| --- | --- |
| `agreed` | a conclusion, plan or understanding is reached with `user`, a rejection included |
| `started` | a piece of work begins — a shift, or something `yan` does itself |
| `delivered` | it finishes: a merge, or `yan`'s own commit; with any doubt about verification |
| `changed` | what happens departs from what the log said: aborted, dropped, reworked, a deviation accepted, an earlier line corrected, a unit field moved |
| `incident` | something went wrong and was resolved: one sentence, linking a learning when there is a lesson |
| `paused` | work stops with something open |

Read top to bottom, those six are the story: what was agreed, what started, what came of it, where it turned, what got in the way, where it stopped. Work `yan` does itself is logged to the same standard as a shift's.

**Commands log their own events, and `--note` finishes the line.** `shift new`, `shift done`, `unit add`, `unit set`, `mr`, `land` and `done` append a typed line for what they did. What they cannot know — what a shift is for, what its merge changed, why a field moved — arrives through `--note` on that same line. Without it every event became two lines, one mechanical and one written by hand, and since the log is read into every session that is paid for twice.

**Everything else goes through `yan log <type> "<line>"`.** The session-start excerpt filters by type, so the format has to be exact, and hand-appended lines had already drifted from it. The command owns the shape; the agent decides only what to say.

**Not logged:** what a command already logged, housekeeping, ideas still under discussion, the contents of a report (a `delivered` line points at the artifact), and anything the merge request already lists.

Because it is append-only it rarely produces a merge conflict, and a wrong line is answered by a later `changed` line rather than an edit.

## 4.4 `brief.md`, the contract as it stands

A task's scope moves, and mostly grows. If `brief.md` were only the words `user` typed at `yan task new`, knowing what the task delivers now would mean replaying every `agreed` line. So it is the current contract — goal, deliverables, what is not being done — rewritten in the turn `user` adds, drops or replaces a deliverable, even in passing, with an `agreed` line logged beside it. "Not doing" is also current, not final: an item moves back when `user` changes their mind.

It is also the default body of the outbound merge request, which a colleague may read.

## 4.5 `task.json` moves when `user` says so

It is written only by commands, and it is what commands act on: `shift new` cuts from `branch`, `yan mr` aims at `target`, `yan land` orders by `needs`. A stale field is therefore worse than a missing log line — it produces a wrong action. So when `user` says the work is on another branch, names the target, changes the mode or the scope, orders two units, or brings in another repository, `yan` runs the matching `yan unit` command in that turn, before its next action.

## 4.6 Reading

Memory is written to be read, and most of it is read without anyone asking. For one task, `yan session-start` prints `brief.md` in full, every `agreed` and `changed` line of `log.md` with the last 20 of any kind, the index of `mem/learnings/` (path, `name`, `description`, the way skills are indexed), and `mem/user.md`. That is the part that has to happen every time, so it is injected rather than instructed; everything it prints sits in the context for the whole session, which is why the log is an excerpt and learnings are an index.

A shift gets the same index in its brief, with paths it can open, and a pointer at the task's artifacts; what a shift is fighting is exactly what an earlier one may already have solved. The rest depends on judgement and lives in the instructions: before a brief, the log lines and learnings about that area; before working a problem out, the learnings index; when unsure what was agreed, the log rather than recall.

An `agreed` line records what was understood at the time, not a verdict. A later one overrides it, and an option dropped before may be raised again — saying it was dropped before, and why.

## 4.7 Artifacts

A work repository is shared with other people, so you cannot put whatever you like into it. Research, prototypes, designs, screenshots, visuals made to align with `user` — the by-products that help people understand the work — belong to the task, and none of them belong in the repository. The task's real output is code in git, or something running in production; neither is here.

That gives one constraint:

> Artifacts must be written outside the worktree.

The worktree gets wiped by `yan tree return`. If a `shift` writes a prototype inside the tree, both possible endings are bad: the file is deleted, or it gets committed into the work repository. So `yan` sets `YAN_TASK_DIR` when it starts a `shift`, and the brief tells the agent to write artifacts to `$YAN_TASK_DIR/artifacts/`.

The directory is in the vault, so it is versioned and pushed, and it must not become a dump. Build output, browser profiles, scratch databases and logs are not artifacts; a shift is told to put that state in the system temp directory. The rule needs saying because the first version of the brief listed "data" among artifacts and offered no other place outside the tree, and one task's artifacts grew a 60 MB browser profile.

Artifacts live as long as the `task` directory does. `yan open <id>` opens the directory.

## 4.8 What not to store

Temporary paths, version numbers that will change, and copied-in snapshots of state. Anything the repository itself already explains, such as code structure or git history — that belongs in the repository's own `AGENTS.md`. A problem whose fix can be committed to the repository gets the fix, not a learning. And anything git or the forge already holds as the source of truth.
