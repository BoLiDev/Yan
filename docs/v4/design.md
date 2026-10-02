# yan v4: memory, and nothing else

## 1. Why

v3 was a harness: a main agent per task, prompted by a long `AGENTS.md`,
dispatching single-use sub-agents ("shifts") into leased worktrees over
Herdr, with a scenario and tier per dispatch and a report channel back. After
two months of use, the orchestration cost more than it returned. Models
needed less steering than the prompt gave them, and the multi-agent layer was
weight they carried on every turn.

What kept paying was the memory: a task's brief, the log of what was agreed,
the deliverables, and a worktree per task that kept its `node_modules`.

So v4 keeps that and removes the rest. And memory is not always wanted, so
an agent sees yan only when it is started through `yan`.

## 2. Commands

Bare `yan` is the only entry. At a terminal it offers the open tasks and "new
task". A new task asks a title, and, inside a git clone, whether to lease a
worktree. When that repository declares workspace packages (pnpm's workspace
file, package.json's workspaces, `packages/*`, `apps/*`), it also asks which
of them the task is about, as v3's `task new` did for its units. That is
asked once and kept in task.json; no later start asks again. Then the agent starts in this terminal, in the task's tree when it
has one. Without a terminal it prints the help. `--cli` swaps the agent for
one run; after `--`, arguments go to the agent unchanged.

Commands `user` reads and runs: `ls`, `peek`, `done`, `draft`, `ui`, `vault`.
Commands the agent runs: `log`, `deliverable`, `learn`.

Every command that takes a task defaults to `$YAN_TASK`, which bare `yan`
sets for the agent. `peek`, `done` and `draft` take the id as an argument;
`log` and `deliverable` take `--task`, because their positionals are the
entry.

Removed: `continue` and `task new` (bare `yan` does both); `show` (renamed
`peek`, and it no longer prints the log, which is `yan log`'s); `abandon`
(`done --abandon`); `open` (`peek` prints the directory); `session-start` and
its hooks; `shift`, `report`, `send`, `state`; `unit`, `mr`, `land`; `tree`
(leasing is part of `yan`, returning part of `done`); `repo`; `doctor`;
`vault link` and `yan use`.

## 3. What the agent is told

```
Notes from earlier sessions on this work are kept by a CLI.
`yan peek` shows what the work is about; `yan log` shows what was settled. `yan --help` for the rest.
```

A task with a scope gets one more line:

```
This task is about these parts of the repository: `packages/a`, `apps/b`.
```

No task, no id: `$YAN_TASK` carries that, and the agent never needs to name
it. When to do something goes in the prompt, because an agent does not read
help unprompted. How to do it goes in `--help`. A rule that belongs to one
command goes in that command's one-line description, which is the line the
agent reads when it scans `yan --help`. That is where "only when the user asks
for one" lives for `learn`, and "only when the user changes the task's goal"
for `deliverable`.

Each harness takes the prompt where it starts no turn of its own: claude as
`--append-system-prompt`, codex as `-c developer_instructions=…`. agy has no
such place, so it gets the prompt as its first message (`-i`), followed by
"Nothing to do yet; wait for the user."

Every harness is started with its approvals skipped: claude and agy with
`--dangerously-skip-permissions`, codex with
`--dangerously-bypass-approvals-and-sandbox`, which `user` chose over
approving each step. `"skipPermissions": false` in the vault's
`config.json` hands the decision back to the harness's own settings.

When the agent should log, and what, is not settled yet. Today the prompt
says nothing about it.

## 4. Storage

Two rules: every piece of information has one writer, and structured state
belongs to a command while prose belongs to a file the agent edits directly.

- `tasks/<id>/task.json`, version 2: id, title, `state` (open, done,
  abandoned), `createdAt`, `closedAt`, `reason`, `repo` (a remote URL, so it
  means the same on every machine), `scope` (the packages picked when the
  task was created, paths in the repository; absent for all of it),
  `nextDeliverable`, `deliverables`. Written
  by bare `yan` (create), `yan deliverable` and `yan done`.
- `brief.md`: prose, no title line; the title is task.json's. Created empty,
  then the agent's to edit.
- `log.md`: `- MM-DD  type  line`, appended only by `yan log`. It accepts
  `agreed`, `changed` and `paused`. Lines from v3 keep their types, and
  `yan log` reads them like any other.
- `drafts/`: `user`'s, through `yan draft`; moved out of `artifacts/`, which
  is the agent's.
- `artifacts/`: no structure.
- `learnings/<topic>.md` at the vault's top: created by `yan learn add`, the
  text filled in by the agent when `user` asks.
- `vault.json` and `config.json` (`{ cli, model, effort, skipPermissions }`) at the top;
  `~/.yan/config.json` for which vaults this machine has.

Deliverable changes no longer write log lines. task.json already holds their
state and dates, and copying them into the log would bury the decisions that
`yan log` exists to show.

## 5. The worktree pool

One tree per task, leased from a pool per clone under `~/.yan/trees/`. The
pool has no size limit: it grows by a slot when every slot is leased and never
shrinks, and it reuses a free warm slot before cutting a new one. A returned
tree is reset and cleaned with `-fd`, never `-x`, so `node_modules` stays.

A lease names its holder, which is the task id. Neither the tree's path nor
its branch is stored in the vault: the path is the lease's, and the branch is
git's. A task's tree is cut on `yan/<id>` from origin's default branch, or
from `origin/yan/<id>` when another machine already pushed it. That is how a
task opened on one machine gets its tree on the next: run `yan` in a clone of
the same repository, and it offers to open one.

`yan done` returns the tree before it closes the task. It refuses while the
tree has uncommitted changes or commits no remote branch contains, and then
the task stays open. `--force` discards that work. The branch is never
deleted.

The pool used to live at `~/.yan-trees`. That was an accident of order: the
pool shipped three days before `~/.yan` existed, and nothing moved it after.
v4 puts it under `~/.yan`.

## 6. Migration

`scripts/migrate-v4.mjs`, once per machine. Its header lists every change.
It refuses a vault with uncommitted changes and writes `vault.json` last, so a
run that stops halfway can be run again. The pool moves with one rename per
pool directory, which is instant on one disk; a copy is the fallback across
disks. Then `git worktree repair` relinks each clone with its trees. A
standing tree's lease passes to its task. A shift's tree is returned when its
work is pushed, and listed for `user` when it is not.
