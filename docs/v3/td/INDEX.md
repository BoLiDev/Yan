# `yan` V3 design

> This document records design decisions. It is not an implementation specification. Each decision tries to carry its "why" with it, because when you come back to change something six months later, the reasoning matters more than the conclusion.

V2 changed the material `yan` is built from — TypeScript, Herdr, a new entry. V3 changes nothing about how `yan` works and everything about **where its data lives**. One sentence: `$YAN_HOME` stops being three things at once.

Everything the [MVP design](../../mvp/td/INDEX.md) says about `task` / `unit` / `shift`, branching, scope, delivery, boundaries and memory is carried over unchanged, and so is all of [V2](../../v2/td/INDEX.md). If a V3 document seems to contradict one of those, it is wrong — except where it explicitly retires a layout rule, and there are exactly two of those, both in §2.

---

## 0. The problem

`$YAN_HOME` is this clone. [MVP td §3](../../mvp/td/architecture.md#3-repository-layout) said so on purpose — *"bootstrapping is simplest that way, and a single-person tool does not need install once, run N homes"* — and for one person on one machine with one kind of project it was right.

It stops being right the moment there are two contexts. Personal projects at home on GitHub, company projects at work on an internal GitLab: those two sets of tasks must not mix, their `remote_git` hosts are different, and their assets belong in different remotes — one of which you are not allowed to push the other into. Today they would share `tasks/`, share `mem/repos.json`, and share the single `conf/config.json` that names the forge.

There is a second cost, quieter. `tasks/` and `mem/` are gitignored inside the code repository, so **task assets are not versioned at all**. A brief, an `outcome.md`, a `log.md` — the record of what was tried and why — exists on exactly one disk. Sitting down at a different machine means starting blind.

---

## 1. What V3 changes

| | V2 | V3 | Why |
| --- | --- | --- | --- |
| where data lives | `$YAN_HOME/{tasks,mem,conf,repos}`, gitignored | a separate **vault** repository, versioned and pushed | assets are worth keeping and must not mix across contexts |
| how many contexts | one | as many as you register; one active at a time | home GitHub and work GitLab are different worlds ([vault.md](vault.md)) |
| main clones | `$YAN_HOME/repos/<name>/`, cloned by yan | your own clones, wherever they are; `repos.json` records them | one clone per repository per machine, not two ([repos.md](repos.md)) |
| machine-specific state | mixed into the same files | `~/.yan/` plus `<vault>/.local/`, never in git | a path that is true here is false on the other machine |
| the code repository | code + private data in one tree | code only; `git status` is clean after a year of tasks | it can be shared with a colleague as-is |

**What V3 does not change.** Every command name and flag except the two in [cli.md](cli.md). The task / unit / shift model. The worktree pool and its root at `~/.yan-trees`. The authority table, other than one new row. `log.md` as the narrative. "Ask, do not infer."

---

## 2. The three layers

This is the whole design, and every placement question below is answered by it.

| layer | holds | lives in | in git? |
| --- | --- | --- | --- |
| **mechanics** | the code, the docs, the hook templates | `$YAN_HOME` — this clone | yes, and it is now shareable |
| **vault** | tasks, briefs, outcomes, logs, artifacts, memory, the repository registry, the forge choice | a repository you own, one per context | yes, and it is pushed |
| **machine** | which vault is active, where each clone is on *this* disk, locks, beacons, panes | `~/.yan/` and `<vault>/.local/` | never |

The test for which layer something belongs to:

- Would a colleague using the same mechanics have their own copy of it? → **vault**.
- Would it be *wrong* if you opened the same vault on a different machine? → **machine**.
- Otherwise → **mechanics**.

That test puts one thing where it may not be expected: **`conf/config.json` moves into the vault, not the machine.** Its `remote_git: {kind, host}` section *is* the boundary between home and work — GitHub at home, an internal GitLab at the office. It follows the context, not the disk. `agents.*` goes with it because "which CLI runs a shift" is a project-shaped choice too, and a per-machine override was never asked for.

It also splits one file in half, and that half-split is the only genuinely fiddly part of V3: `repos.json` records both a remote URL (portable, belongs to the vault) and a local path (not portable, belongs to the machine). [repos.md](repos.md) does the splitting.

### The two layout rules V3 retires

1. **[MVP td §3](../../mvp/td/architecture.md#3-repository-layout): "`$YAN_HOME` is this clone itself, so the tracked code and the gitignored private data live in one tree."** Half of it stands — `$YAN_HOME` is still this clone, and `yanHome()` still derives it the same way. The rest is replaced by §2 above.
2. **[MVP td §4.3, "artifacts go in `$YAN_TASK_DIR/artifacts/`"](../../mvp/td/memory.md#43-artifacts)** — unchanged in wording, but `$YAN_TASK_DIR` now resolves inside the vault. Nothing that reads it needs to know.

---

## 3. What this buys, concretely

- Two contexts on one machine, or one context on two machines, with `yan use <name>`.
- A colleague clones the mechanics, runs `npm run setup`, points at their own vault, and shares none of your data — the mechanics repository has no private data left in it to leak.
- `outcome.md` and `brief.md` become durable. "What has already been tried" — [the third thing every brief must carry](../../mvp/td/agents.md) — stops depending on one disk surviving.
- The code repository becomes reviewable again: a diff is a change to yan, never a task that happened to run.

---

## 4. What V3 deliberately does not do

| Not doing | Because |
| --- | --- |
| a vault per repository, or per task | the unit of separation is a *context*, and a context is "whose forge, whose machine, whose colleagues" |
| automatic push | writes to a remote are the user's call, and an auto-commit on every `log.md` line would make the history unreadable ([vault.md §5](vault.md#5-sync)) |
| conflict resolution beyond `pull --rebase` | one person, one machine at a time. `log.md` is append-only and `task.json` is small; when a rebase does conflict, git's own message is the right interface |
| a vault schema migration tool | `vault.json` carries a `version`; the first bump is the first time we need one |
| multi-vault at once (`--vault` on every command) | one active vault, switched explicitly. Two actives is a state you can be wrong about silently |

---

## 5. Reading order

1. [`vault.md`](vault.md) — the vault repository: structure, what is tracked, bootstrap, sync
2. [`repos.md`](repos.md) — `repos.json`, its machine-local half, and `yan repo add`
3. [`cli.md`](cli.md) — the new and changed commands, and the authority table row
4. [`migration.md`](migration.md) — how today's `$YAN_HOME` becomes mechanics plus one vault
5. [`../plan/INDEX.md`](../plan/INDEX.md) — the delivery cut
