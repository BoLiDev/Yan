# Human CLI UX

> This document records how a person drives `yan` from a terminal. Agents still call the same subcommands with flags; they never sit in a prompt. The interactive layer exists only for `user`.

---

## 1. Why prompts exist

Design principle 4 says `user` and the agents share one entry point. That does not mean they share one *input style*. An agent already knows the arguments. A person does not want to memorise flags for task title, description, which repositories to involve, which monorepo packages belong in `scope`, or which unfinished task to reopen.

So every command that needs a human choice offers two paths:

| Path | When | Behaviour |
| --- | --- | --- |
| Soft (interactive) | stdin is a TTY, and required values are missing | ask with modern prompts: `text`, `select`, `multiselect` |
| Hard (scripted) | all required flags are present, **or** the caller is not a TTY | no prompts; run silently. If required values are missing and there is no TTY, exit non-zero with a short message listing the flags to pass |

The hard path is what agents and CI use. The soft path is what `user` uses day to day. Both end in the same bookkeeping and the same terminal actions.

---

## 2. Prompt toolkit

**Interactive prompts use [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts)** (Clack). Do not hand-roll menus with `read` and numbered lists when Clack already covers `text`, `select`, and `multiselect`.

That choice implies a **Node runtime for the human interactive layer only**. The rest of `yan` stays shell scripts (`jq`, git, the seams). The split:

| Layer | Runtime | May call |
| --- | --- | --- |
| Soft path (missing args + TTY) | Node + `@clack/prompts` | hard-path subcommands / libs via `yan <cmd> …` with full flags |
| Hard path and everything agents run | shell (`bin/yan-*.sh`, libs) | seams and storage as today |

Bootstrap therefore lists **Node** (and the pinned Clack install under `$YAN_HOME`) next to `jq`. Agents never import Clack; they never need Node for ordinary orchestration.

Why not a pure-shell prompt library: the soft path is for people, and the bar is a clear select/multiselect UX. Clack is the modern default for that. Keeping judgements and irreversible steps in scripts still holds — Clack only collects answers; scripts still write `task.json`, open containers, and refuse dangerous defaults.

---

## 3. `yan task new` (create and enter)

`yan task new` is the strong create command. On the soft path it walks `user` through the whole first session setup, then **starts the task container and the main agent** — there is no separate manual start after a successful create.

### Soft-path flow

1. **Title** — if `--title` is absent, ask: what is this task called? (human-readable; stored in `brief.md` / `log.md`, not as the id)
2. **Description** — if `--description` is absent, ask; empty is allowed
3. **Repositories to involve** — multiselect from `mem/repos.json` (must already be registered via `yan repo-add`). At least one
4. **Per repository, refine `scope`** — see [§5](#5-monorepo-aware-scope-selection)
5. **`target` (and unit naming as needed)** — still required explicitly ([§6.4](branching.md#64-the-shape-of-a-unit)); soft path asks rather than inventing a default
6. **Persist** — allocate `tasks/<id>/` (id format: [§12](scope.md#12-open-questions)), write `brief.md`, create the `unit`(s) with `scope` (same invariants as `yan unit add`)
7. **Enter** — create the task's terminal container and start `yan` inside it using `agents.yan` from `conf/config.json` (same terminal action formerly associated with start; see [§4](#4-yan-continue-reopen))

### Hard-path shape (illustrative)

Flags cover the same fields (`--title`, `--description`, repo/scope/`target` selections, etc.). When the set is complete, step 6–7 run with no prompts. Agents that only need a directory can still call lower-level pieces (`yan unit add`, and so on) directly; `task new` is the human-oriented orchestration.

### What "strong" means

Create is not "mkdir + empty brief". It is: contract + involved repos + concrete `scope` (including monorepo packages when detected) + at least one `unit` + multiplexer session with the main agent already running. After `yan task new`, `user` is inside the task.

---

## 4. `yan continue` (reopen)

The old `yan start` idea is renamed **`yan continue`**: attach to an existing task and resume the main agent in that task's container.

| Invocation | Soft path | Hard path |
| --- | --- | --- |
| `yan continue` | select among incomplete tasks (from scanning `tasks/*/task.json`) | refused: pass `--task <id>` (or equivalent) |
| `yan continue <id>` / `yan continue --task <id>` | attach/create container if needed, start or reattach `yan` with `agents.yan` | same, no prompt |

Semantics:

- Container lifetime is still `user` opening and closing it ([§5.7](agents.md#57-terminal-topology))
- A second `yan` on the same task is still refused ([§5.2](agents.md#52-one-yan-per-task))
- If the container and agent are already alive, prefer attaching over spawning a duplicate
- `yan task new` ends by performing this same enter step for the newly created id; `continue` is for coming back later

There is no `yan start` name in the inventory. Docs and scripts say `continue`.

---

## 5. Monorepo-aware scope selection

`scope` remains a list of path prefixes a `unit` may change ([glossary](INDEX.md#1-glossary), [§8.3](delivery.md#83-enforcement)). The soft path helps `user` pick those paths without typing them.

### Detection (best effort)

For each selected clone under `repos/`, treat it as a monorepo when any of these is true (extend later if needed; do not pretend completeness):

- `pnpm-workspace.yaml` (or npm/yarn workspace manifests) exists at the root
- a top-level `packages/` or `apps/` directory exists

If none match, offer the repository as a single choice (scope = repo root / `.`).

### Selection

When a monorepo is detected, list candidate packages/apps (children of `packages/`, `apps/`, and workspace package dirs when cheap to read) and **multiselect**. Each selected path is a scope prefix.

How selections become units (aligned with [§6.4](branching.md#64-the-shape-of-a-unit) / [§6.7](branching.md#67-how-big-a-unit-should-be)):

- **One selected package → one `unit`** with `scope` set to that path (one sub-application, one integration branch, one tree)
- Several packages selected under one repo → several units in the same `task new` run, unless `user` explicitly groups them (hard flags can express grouping later; soft path default is one unit per package)
- A non-monorepo repo → one unit whose `scope` is the repo root

False negatives are acceptable: `user` can still widen `scope` later with `yan unit set`. False positives that offer a noisy list are acceptable if escape to "whole repo" remains one of the choices.

This package-level picking is **in 0→1** ([§11](scope.md#11-scope-of-the-first-version)). It is part of create UX, not a later stage.

---

## 6. Where else soft path applies

Same TTY / flags rule, without expanding this document into a full UI spec:

| Command | Typical soft prompt |
| --- | --- |
| `yan continue` | select task |
| `yan unit add` / `yan unit set` (when widening scope) | repo + monorepo package multiselect as in §5 |
| other commands that today require a bare id or path | select from derived lists (`yan ls` data), never invent state |

Atomic commands used only by agents (`yan report`, `yan wait`, …) stay flag-only and do not grow prompts.
