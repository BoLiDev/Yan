# Orchestration, second cut

> This document revises [td §5.1–5.4](../../mvp/td/agents.md#51-lifetime-tiers) — the life of a `shift` and how `yan` talks to it. Most of it survives unchanged and is not repeated here; what follows is what Herdr, the records classes and the Phase 5 spike changed, and the invariants Phase 7 must not lose while moving eleven commands.

---

## 1. What did not change, and why it matters most

**Lifetime tiers.** A task's files are long-lived, a shift's `run/` is throwaway, and **`yan` holds no state of its own** ([td §5.1](../../mvp/td/agents.md#51-lifetime-tiers)). That middle row is not a nicety: it is the property that let this whole migration be a strangler instead of a flag day, because it makes the file system the interop boundary between the bash half and the TypeScript half ([plan §2](../plan/INDEX.md#2-why-this-can-be-a-strangler-and-not-a-rewrite)). Phase 7 is the phase most able to break it by accident — an orchestrator is exactly where someone caches "the shift I just started".

**One `yan` per task**, and the lock is per task ([td §5.2](../../mvp/td/agents.md#52-one-yan-per-task)). Unchanged.

**The clock-out condition.** A shift clocks out when its merge request has merged into the integration branch — asked of the host, never inferred from git ancestry, because a squash merge is not an ancestor of what it landed on. Unchanged, and now load-bearing in a second place: see [§4](#4-done-is-not-a-verdict).

**The order of teardown.** `outcome.md` → `rm -rf run/` → return the tree → **then** delete the remote branch. Unchanged ([td §7](../../mvp/td/worktree.md#7-worktrees)).

---

## 2. Starting a shift is now five steps, and the fifth is new

The MVP's `shift new` was: sync → lease a tree → write the brief → open a terminal → set `YAN_TASK_DIR`. Under Herdr it is:

| | |
| --- | --- |
| 1 | `yan sync` — always first, so the shift branch is cut from a current integration branch |
| 2 | `new WorktreePool(clone).get(size, base, branch, holder)` — the lease, holder `<task>/<unit>/<sid>` |
| 3 | write `brief.md` |
| 4 | `terminal.startAgent({ container, name, kind, cwd: <the leased tree>, env, argv })` |
| 5 | **confirm, then record** |

Step 4 hides two Herdr facts worth knowing at this level. The pane is split with `--cwd` at the leased tree and `--env` carrying `YAN_TASK` / `YAN_TASK_DIR`, so there is no wrapper script; and everything after `--` reaches the agent as **argv**, so a brief pointer or `--append-system-prompt` needs no quoting ([evidence §2](evidence.md#2-argv-passthrough)).

Step 5 is new and it is not optional. `agent start` returned `interactive_ready: true` for a codex that had already exited, because Herdr's screen detection matched the bare shell prompt it left behind ([evidence §11.7](evidence.md#117-agent-start---kind-codex)). The seam confirms and refuses, so `shift new` gets an exception rather than a phantom shift — but **the orchestrator is what decides what to do about it**: the tree is already leased, and a `shift new` that throws after step 2 must return it before it exits, or the pool leaks a slot on every failed dispatch.

**And the assertion the MVP made stays exactly as it is:** the sub-agent's working directory is not the main clone's path, and `shift new` refuses to start otherwise. `repos/<repo>/` is read-only ([CLAUDE.md](../../../CLAUDE.md) rule 4). The leased path comes from the pool and is never constructed.

---

## 3. Telling Herdr what it is looking at

`shift new` and `shift done` are where [display.md](display.md) is wired in: a pane title naming the shift and its unit, workspace tokens naming the task, unit and branch, cleared on teardown.

These calls are **display-only and never fatal**. If Herdr refuses one, log a line and carry on: the work is correct with ugly labels, and an orchestrator that will not dispatch a shift because a title did not stick is a worse orchestrator.

---

## 4. `done` is not a verdict

The single most dangerous thing in this phase.

The spike found the plan-approval prompt arriving as **`done`** rather than `blocked` ([evidence §11.3](evidence.md#113-which-prompts-herdr-recognises)). `done` is also the word for "this shift finished its work" — and what follows "finished" is destructive: delete `run/`, return the tree, delete the branch.

**So every path that could tear a shift down re-checks the objective condition first**: has the merge request merged into the integration branch? That is rule 3, unchanged; what is new is that a wake reason is now a plausible-looking way to skip it.

The shape to keep in mind:

```
a done wake            →  look
the MR has merged      →  clock out
anything else          →  it is still working, or it is stuck, or it wants an answer
```

Nothing else is allowed to stand in for the middle line.

---

## 5. `yan send`, and what the MVP's two-step was for

`send` was two operations — type the text, then send Enter, retryable separately — because tmux `send-keys` could not do both atomically. Herdr's `agent prompt` submits text and Enter in one call, honouring the pane's live bracketed-paste mode, so the split has nothing left to do and is gone.

What replaces it is a different guard: **nothing is sent to a pane without a live agent.** A prompt to a pane whose agent has died is typed into whatever shell is there, which then tries to run it as a command ([evidence §11.7](evidence.md#117-agent-start---kind-codex)). The seam refuses; the orchestrator decides — a dead shift is a `died:` wake, not a retry.

Everything else in [td §5.4](../../mvp/td/agents.md#54-communication) stands: the brief is written once and is the long contract, anything long goes in a file and only the path is sent, and `yan report` is a script because a brief telling an agent to do two things gets one of them done.

**`yan report` matters more than it did.** It is no longer only the shift's courtesy channel: it is the half of supervision that does not depend on Herdr recognising a screen ([supervision.md §1](supervision.md#1-what-was-inferred-and-what-is-now-known)). A shift that says it is blocked is believed whether or not any manifest matched.

---

## 6. Deriving state, with a two-step in it

`yan state <sid>` still derives — never reads the last line of `run/status` — from `run/meta.json`, the terminal, git and the host.

One input changed shape. `alive | dead | unknown` needs **two** Herdr calls, because `agent get` answers `agent_not_found` both when an agent died and when it never existed ([terminal.md §5](terminal.md#5-alive-dead-unknown)). The seam does the derivation; `yan state` must not re-implement it, and in particular must not treat `unknown` as `dead`. `unknown` means yan could not find out, and clocking a shift out on "could not find out" is how work gets deleted.

---

## 7. The records classes changed the writing, not the rules

`unit set --branch` is one atomic operation — archive the current round into `history[]`, overwrite the branch, clear `mr`, in a single `tmp → mv` — because a task that crashed between the two would lose the round it was in. That is now `unit.rotate(end, newBranch)`, and the atomicity lives inside the record rather than in the command ([records/task](../../../src/records/task/index.ts)).

The commands get correspondingly thinner, and that is the test of whether the last five phases were worth it: `yan unit set` should read as argument handling plus one call.

---

## 8. What Phase 7 must not lose

The four the MVP named, each guarding something that does not fail loudly:

1. after returning a tree, gitignored directories are still there
2. `shift done` returns the tree **before** deleting the remote branch
3. `shift new`'s working-directory assertion really refuses
4. `sync` really exits on a conflict and never resolves one

To which this phase adds two of its own:

5. a `done` wake never tears down a shift whose MR has not merged ([§4](#4-done-is-not-a-verdict))
6. a `shift new` that fails after leasing returns the tree ([§2](#2-starting-a-shift-is-now-five-steps-and-the-fifth-is-new))

---

## 9. Open

**Codex cannot currently be a shift agent.** `agent start --kind codex` reports ready for a codex that has exited, and the root cause is unestablished ([evidence §11.7](evidence.md#117-agent-start---kind-codex)). This does not block Phase 7 — `agents.shift` naming `claude` works — but it does mean the Codex path is unexercised end to end, and `yan doctor` should say so rather than let it be discovered at dispatch time.
