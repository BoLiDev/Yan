# Decision log

> This document records only when a decision was made, what was decided, a summary of the reasoning, and where the full version lives.
> The complete reasoning for each decision lives in the section it governs, not here — and neither do the options that were rejected.
> `design §x` refers to the design documents under `docs/design/`. The backbone is [`design/INDEX.md`](design/INDEX.md); start there to find which file a section lives in.

---

## 2026-08-05. P0 decisions before starting

All three are settled and have already been folded into the design documents.

| | Decision | Reasoning | Written up in |
| --- | --- | --- | --- |
| **P0-1** | `yan` ships its own worktree pool (`yan tree get \| return \| status`) | the project does not need to depend on an outside tool for this. The three things worth taking from treehouse — random `lease_id`, conditional return, `--json` — were copied along with it | [design §7](design/worktree.md#7-worktrees) |
| **P0-2** | support both GitLab and GitHub behind a forge deep module | GitLab at work, GitHub outside it; both are real needs. Side benefit: the acceptance test for the first version can be run against `yan` itself | [design §8.4](design/delivery.md#84-the-forge-layer) |
| **P0-3** | shift branches are pushed to the remote, and both levels of MR are kept | one independent MR per `shift` is how `user` reviews the work | [design §12](design/scope.md#12-open-questions) under "settled", and [design §6.2](design/branching.md#62-two-levels-of-review) |

P0-3 produced one invariant, which is already in the design: **clocking out and deleting a branch are both decided by the MR's state, never by git ancestry** ([design §5.3](design/agents.md#53-the-life-of-a-shift)).

---

## 2026-08-05. What is actually installed

Checked on this machine, to replace assumptions with facts.

| Tool | Status | Effect on the design |
| --- | --- | --- |
| `tmux` | ✅ 3.6 | the first-version path in [design §5.7](design/agents.md#57-terminal-topology) is not blocked. The earlier worry about tmux being missing does not apply |
| `herdr` | ✅ 0.7.5 | there is an environment for the second `lib-term.sh` implementation in 2→10 |
| `treehouse` | ✅ v2.1.1 | installed and in daily use. But its branch model does not match, so it is not used as the pool; the reasoning is in [design §7](design/worktree.md#7-worktrees) |
| `jq` | ✅ 1.8.1 | the hard dependency from [design §2](design/INDEX.md#2-storage-criteria) is satisfied |
| `git` | ✅ 2.53.0 | — |
| `gh` | ✅ 2.97.0 | the GitHub side is ready |
| `claude` | ✅ 2.1.222 | the host for the three hooks in [design §5.5](design/supervision.md#55-supervision) |
| `wtpool` | ❌ not present | it is an unreleased CLI on another machine. [design §7](design/worktree.md#7-worktrees) was originally built entirely on it, which is what led directly to P0-1 |
| `glab` | ❌ not present | the GitLab forge implementation has nothing to test against for now; see [`implementation-plan.md` §4](implementation-plan.md#4-what-is-blocking-right-now) |

---

## 2026-08-05. tmux, not herdr, for the first version

[design §5.7](design/agents.md#57-terminal-topology) already says tmux. These are two pieces of evidence measured on this machine explaining why not to switch now. Both were measured here, on this version (herdr 0.7.5), so they are worth recording in `mem/learnings/` for the day someone writes the second `lib-term.sh` implementation:

1. After the host recovers, herdr loses the agent's startup arguments. The restored agent comes back in manual confirmation mode, so it looks alive but does nothing.
2. Sending keys (`BTab` / `S-Tab`) to the herdr backend has no effect.

tmux is the reference implementation that has been verified, so the first version uses it, as [design §5.7](design/agents.md#57-terminal-topology) says. There is no technical problem with `yan` starting its own tmux session, since two multiplexers do not interfere with each other. The cost is having two sets of containers on screen at the same time.

---

## 2026-08-06. The test for atomic versus orchestrating

| | Decision | Reasoning | Written up in |
| --- | --- | --- | --- |
| **the test** | subcommands are split into atomic and orchestrating, and the test is whether the command represents one indivisible core capability. The earlier test, "does it hold an ordering invariant", is no longer used for this classification | the atomic commands are `yan`'s primitives, and being indivisible is what actually makes something a primitive | [`architecture.md` §5](design/architecture.md#5-subcommands) |

The idea of an ordering invariant is still used; it is just no longer the classifier — for example the one that fell out of P0-3, and the ones each orchestrating command holds.

---

## 2026-08-06. Design principle 6 retired

| | Decision | Reasoning | Written up in |
| --- | --- | --- | --- |
| **design principle 6** | "From 0 to 1, then to 2, 10, and 100. Each step adds only the machinery the current pain actually requires" is no longer listed among the design principles | it describes progress, and progress belongs to the implementation plan rather than the design documents | [`implementation-plan.md` §0](implementation-plan.md#0-how-the-work-is-split) |

---

## 2026-08-09. `yan ls <id>` is the task inspect view

| | Decision | Reasoning | Written up in |
| --- | --- | --- | --- |
| **`yan ls <id>`** | enhance `yan ls` rather than add a new command: no argument keeps the queue; a task id prints that task's related facts, including each live shift's branch and worktree absolute path | the queue and the inspect view are the same kind of thing — a scan of what is already there — so they share one verb. `yan state` stays per-`shift`; `yan session-start` stays the SessionStart rebuild | [`architecture.md` §5.1](design/architecture.md#51-atomic-commands), [design §5.2](design/agents.md#52-one-yan-per-task) |

---

## 2026-08-09. `yan` supports Claude Code and Codex

| | Decision | Reasoning | Written up in |
| --- | --- | --- | --- |
| **dual harness** | `yan` runs on Claude or Codex (`conf/harness`); shifts stay any CLI | company use is Codex-only; personal use stays on Claude. Official Codex hooks still lack Claude's long-lived `asyncRewake` | [design §5.6](design/agents.md#56-harness-requirements), [design §5.5](design/supervision.md#55-supervision) |
| **Codex coverage** | model loops `yan wait --seconds N` (default 180); Stop registers guard only — no autoarm, no detach daemon | wait's return *is* the rewake when the harness cannot hold a long Stop | [design §5.5](design/supervision.md#55-supervision) |

---

## Unchecked settings on the work repository

Both of these need a look at the work repository's settings, and both are cheap to check. Both fall out of P0-3, pushing shift branches to the remote.

1. **Whether branch protection or push rules would reject `yan/*`.** Some teams enforce branch naming rules.
2. **Merged remote shift branches must really be deleted**, otherwise `yan/*` branches pile up on the server. The clock-out order in [design §7](design/worktree.md#7-worktrees) already includes that step; the easiest approach is to tick "delete source branch after merge" when opening the internal MR.
