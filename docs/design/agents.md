# 5. Agents

## 5.1 Lifetime tiers

| Lifetime | Who | How its state is stored |
| --- | --- | --- |
| Long | a `task` and everything belonging to it | files, kept, trimmed by hand |
| Medium | `yan` | no state files of its own |
| Short | a `shift` and its sub-agent | throwaway files, deleted when the `shift` clocks out |

The middle row is the important one: `yan` should hold no persistent running state. Every time it starts, it rebuilds its picture of the world from scratch — it scans `tasks/`, asks the terminal what is running, and asks the tree pool what is leased. Whatever those say is the answer. This is what makes "close it and open a new one" a non-event: there is nothing to hand over and nothing to resume.

It also means most of a task's state never has to be stored. "No `shift` has ever been dispatched" is `shifts/` being empty. "A `shift` is running" is a scan of `run/` plus a terminal query. "No `shift` is running but the task is not finished" is what is left over. All of it can be derived. The one thing that must be stored is "`user` has declared this task finished", because that is a decision, not a fact about the world. So `task.json` needs exactly one completion flag, and there is nothing that can drift out of sync.

## 5.2 One `yan` per `task`

The reason is context budget. A task-scoped `yan` has a bounded one, and its size does not depend on how many tasks exist.

What a task-scoped `yan` sees:

```
always      AGENTS.md · mem/user.md · tasks/<id>/{task.json,brief.md,log.md}
            tasks/<id>/shifts/*/run/          (to rebuild the current picture)
on demand   mem/repos.json                    (to find a clone path)
            mem/learnings/<repo>.md           (only the parts that apply)
            tasks/<id>/shifts/*/outcome.md    (when starting a new shift)
            repos/<repo>/                     (read-only: to judge scope, to read code)
never       anything belonging to another task
```

The command that starts it:

```sh
cd "$YAN_HOME" && YAN_TASK=t042 claude \
  --add-dir "$YAN_HOME/repos/monorepo-x" --add-dir "$YAN_HOME/repos/proto"
```

The working directory is `$YAN_HOME`, because `yan` needs to run things in `bin/` and read `mem/`. Each `--add-dir` is a clone this task actually touches; repositories that are not listed are invisible to it.

So who handles the things that cross task boundaries? In every case the answer is a script, not an agent:

- **Two tasks changing the same `scope`.** No mechanism is needed. Worktrees already keep the file systems apart, and git conflicts and semantic conflicts are a normal part of development — rebase, CI, and review deal with them, and GitLab will say so at merge time. Overlapping files are not a reason to serialise work.
- **Seeing every running task at once.** `yan ls` scans the directory; `user` runs it. Showing a `scope` column is useful information, and `user` decides whether to care. Having `yan` scan for overlaps and warn about them would be noise: overlap is common, the warning would fire again and again, and it would be ignored. **Looking inside one task** is the same command with an id: `yan ls <id>` prints that task's units and every live `shift`'s shift branch and worktree absolute path — the inspect view `user` and `yan` both need when something has gone missing or died.
- **Several `yan` instances writing `mem/` at once.** `user.md` is only written on request, and `user` talks to one `yan` at a time. If that ever stops being true, add an `flock`.

The lock is per `task`, not per home directory. Running two `yan` instances for two different tasks is fine. Only a second `yan` on the same task is refused.

## 5.3 The life of a `shift`

- **Start.** `yan` writes `shifts/<sid>/brief.md`, leases a tree with `yan tree get --base <integration branch> --branch <shift branch>` (the holder string is `<task>/<unit>/<sid>`), opens a terminal, and sets `YAN_TASK_DIR`.
- **Work.** The sub-agent works only inside its own tree. It appends a line to `run/status` when, and only when, something needs `yan` to act.
- **Clock out.** Once the shift branch's MR has been merged into the integration branch: write `outcome.md` → `rm -rf run/` → `yan tree return` → delete the remote shift branch.

Why the condition for clocking out is "the MR has been merged into the integration branch": once it is merged, the changes are on the integration branch and therefore have a copy on the remote. Nothing in the tree is the only copy of anything, so returning the tree is safe. That test is stronger than "the work is done", it can be checked, and it does not require any judgement.

**Whether it merged is answered by the MR's state, not by git ancestry.** If the internal MR was squash-merged, the integration branch does not contain the shift branch's HEAD, so an ancestry check would say "not merged" even though the work has landed. Deleting the branch has the same problem. This is the same principle as [§6.6](branching.md#66-yan-never-parses-branch-names): do not infer things from names or shapes, ask the source of truth.

Returning the tree must come before deleting the remote shift branch. The reason is in [§7](worktree.md#7-worktrees).

**A `shift` does not wait for the outbound MR's CI.** This is deliberate. If CI goes red, `yan` finds out by asking GitLab, and dispatches a new `shift` to fix it. Polling one source of truth is far cheaper than supervising an agent that is parked.

**A `shift` never spans two tasks.** It may span several `unit`s of the same task — one sub-agent holding two trees, changing `auth` and `gateway` at the same time — but that means two shift branches and two MRs.

## 5.4 Communication

| Direction | Mechanism | Constraints |
| --- | --- | --- |
| `yan` → `shift`, at start | the `brief.md` file | the long contract lives only here, and is written once |
| `yan` → `shift`, while running | `yan send`, which wraps `term_send`; one short line | anything long goes into a file, and only the path is sent. The text and the Enter key are sent separately: type the text once, and retry only the Enter |
| `shift` → `yan` | `yan report <state> "<note>"` | the script appends to `run/status` and touches `run/signal` in one go |

Why `yan report` has to be a script rather than a brief telling the agent to do two things: do not count on an agent remembering step two. Wrapping it in one command also lets it check that the state is one of the five allowed words, add a timestamp, and write atomically. It is the only `yan` command a `shift` needs to call, apart from `yan scope-check`, which a `shift` may run on itself.

Three rules that do not bend:

- Shifts do not talk to each other. Work that needs coordination is given to one `shift` holding several trees.
- A `shift` never talks to `user` directly. Everything it reports goes through `run/status`, and `yan` turns it into plain language.
- *Every line in `run/status` is an event, not the current state.* This has to be clear from the first day. Reading `tail -1` as "the current state" is wrong: it is only the most recent event.

### Deterministic steps should not wake the model

When an event arrives, ask one question first: does this need a judgement call? If it does not, the script finishes the job and the model never has to wake up.

| The script handles it | Needs a judgement call, so wake the model |
| --- | --- |
| a `shift` reports `done`; add a line to `log.md` | the merge has conflicts |
| the shift branch merges cleanly into the integration branch | a `shift` reports `blocked` or `needs-decision` |
| a `unit` whose `needs` are now satisfied and which has no `shift` yet → dispatch the next one | a `shift` has died or is stuck |
|  | CI is red and someone has to decide how to fix it |

The landing order is already declared in the `needs` field of `task.json`, so "A landed, therefore dispatch B" is plain orchestration, not a judgement. `yan report` does that itself, and the chain does not have to stop and wait for the model at every link.

The items on the right, the ones that need a judgement, are also the ones `user` should know about. "Worth waking the model" and "worth interrupting `user`" turn out to be nearly the same line.

## 5.5 Supervision

Supervision is large enough to have its own document: see [`supervision.md`](supervision.md). The question it answers is: when a `shift` finishes or gets stuck, who wakes `yan` up?

## 5.6 Harness requirements

**`yan` itself runs on Claude Code or Codex.** `conf/harness` is `claude` or `codex`; `yan start` launches the matching CLI. Other harnesses for `yan` stay out of scope. The shared supervision core is the same; what differs is how continuous coverage is armed — Claude can hold `yan wait` in a long-lived Stop hook (`asyncRewake`), while Codex cannot (official hooks still parse `async` but do not run async command hooks). Codex therefore uses a model-driven loop of `yan wait --seconds N` instead. The full split is in [§5.5](supervision.md#55-supervision).

The trade is the same either way: quieter Claude coverage versus Codex checkpoints that return control every N seconds, cost tool-round-trip tokens while idle, and cannot wake the model after a turn has truly ended. Personal use can stay on Claude; company use can stay on Codex without inventing a detached watcher daemon.

**A `shift` can still run on any agent CLI.** Everything a `shift` needs from its harness:

1. It accepts an initial prompt at startup, so it can be told to read the brief.
2. It runs inside a terminal pane.
3. It can run shell commands, to call `yan report`, git, and the test suite.
4. It accepts typed input from `tmux send-keys`, so it can be steered.

**No hooks required for a `shift`, no background mode required.** Codex, Kimi Code, and in-house CLIs all qualify at the shift layer. Tokens mostly go there; `yan` only orchestrates.

This does not conflict with Herdr: Herdr is a multiplexer (a backend); Claude Code and Codex are harnesses. Lifecycle hooks belong to the harness and do not care whether tmux or Herdr is outside. They are different axes.

## 5.7 Terminal topology

**One terminal container per `task`.** The first version uses tmux, and Herdr comes later. Their nesting concepts line up one to one, so choosing the right topology now means the migration later changes only which CLI is called, not the data model.

| Concept | tmux | Herdr |
| --- | --- | --- |
| the `task` container | session | workspace |
| one agent | window | tab |
| a terminal | pane | pane |

```
session / workspace "t042 unify the auth header"
├── yan          ← the main agent
├── s3-auth      ← a shift
└── s4-gateway   ← a shift
```

`tmux ls` is the task list, and switching sessions is switching tasks. `yan` and the shifts it dispatched share one container, so the outer level shows only tasks and you see individual agents after switching into one. None of this needs extra machinery: `yan start t042` creates the container and starts `yan` inside it, and dispatching a `shift` adds a window to the container `yan` is already in.

Giving every sub-agent its own throwaway Herdr workspace is not worth it. It carries a whole set of safety boundaries with it. The single fact that "an explicit close in Herdr 0.7.5 steals focus" requires an entire focus-safe emptying-close procedure: verify that closing empties the workspace, move the dying workspace behind the focused one, prove the pane holds nothing but an idle shell, end that shell so it exits through the pane-death path, confirm removal, and roll back on failure — and the design still admits that *grouping is best-effort*. All of that cost comes from wanting a workspace's lifetime to be derived automatically, and `yan` does not have that problem: the container's lifetime is `yan`'s lifetime, and `user` opens and closes it by hand.

### Herdr Practices

1. **A label is not a source of truth; record the id.** Herdr does not require workspace or tab labels to be unique (in its own words, *a label can never decide where a worker goes*). So `run/meta.json` records ids — `$0` and `@3` under tmux, `workspace_id`, `tab_id`, and `pane_id` under Herdr — and nothing is located by name. This is the same principle as [§6.6](branching.md#66-yan-never-parses-branch-names): do not parse names, look them up in storage.
2. **Close exactly one thing.** Only the window or pane that was recorded is closed, never the session or workspace (in its own words, *cleanup closes only the exact recorded task pane and never calls `workspace close`*).
3. **Do not steal focus.** `-d` under tmux, `--no-focus` under Herdr.

### What herdr-readiness should look like

There is no backend abstraction layer; What there is, is cohesion: every terminal operation lives in one file, `bin/lib-term.sh`, as seven functions.

```
term_container_create   create the task container
term_agent_start        start an agent (or a process) in the container, return its id
term_send               send text, then Enter
term_read               read the contents of a pane
term_agent_alive        report whether an agent is alive
term_agent_close        close exactly one recorded agent
term_list               list the agents in a container
```

The first version has only the tmux implementation. Adding Herdr means writing a second implementation and a `conf/backend` switch — not a plugin framework, just a way of keeping `tmux` commands out of fifteen different scripts.

`term_agent_alive` is the hardest and most important function in this seam. Under tmux the only option is to guess from process names, which fails for agents that run inside a generic interpreter. Herdr has native agent registration, which cleanly separates "the pane is there but the agent died" from "the pane is gone" from "alive".
