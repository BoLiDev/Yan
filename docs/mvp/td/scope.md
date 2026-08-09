# Scope and open questions

## 11. Scope of the first version

Throughout the design, "0→1" means the first version that works end to end. "1→2", "2→10", and "10→100" are the stages after it.

### What is in it

One `yan` entry point plus the subcommands in [Appendix C](appendix.md#appendix-c-script-inventory), 2 hook scripts, dual harness registration (`.claude/settings.json` and `.codex/hooks.json`), 8 libraries, `AGENTS.md`, and the human soft path (`ui/` + `@clack/prompts`) described in [`cli-ux.md`](cli-ux.md). How subcommands are arranged is in [`architecture.md` §3](architecture.md#3-repository-layout) and [`architecture.md` §5](architecture.md#5-subcommands).

The two heaviest pieces are the built-in worktree pool ([§7](worktree.md#7-worktrees)) and the forge layer supporting two remotes ([§8.4](delivery.md#84-the-forge-layer)). Of the pool, the branch awareness, the test for returning a tree, and the orphan-commit guard all had to be written anyway; the genuinely extra parts are reuse and leases. What that buys is zero outside dependencies for the hard path, and a first version that can be accepted against `yan`'s own repository. Node is required only for the soft path.

**The acceptance test for 0→1:** `yan task new` (interactive or flagged) produces a task with monorepo-aware `scope` when applicable, enters the container, then: one `unit` → one `shift` → the shift branch's MR merges into the integration branch → the `shift` clocks out and returns its tree → the outbound MR is opened → `user` says to merge → it is merged → `log.md` records the whole chain. Reopening with `yan continue` must reattach. At least one harness path (Claude or Codex) must complete that chain end to end; the other must pass its hook-contract tests in P4 ([§5.5](supervision.md#55-supervision), [§5.6](agents.md#56-harness-requirements)).

### Why the first version stays small

The surface area is the sum of what was deliberately left out:

| Ruled out | Note |
| --- | --- |
| a separate triage layer above the wake pipeline | the three sources live inside `yan wait` ([§5.5](supervision.md#55-supervision)) |
| many terminal backends plus an abstraction layer | `yan` needs a second `lib-term.sh` for Herdr later; for `yan`'s own harness it only binds Claude and Codex ([§5.6](agents.md#56-harness-requirements)) |
| X mode and public-followup style features | not done at all |
| PR poll registration and trust binding | a `shift` does not wait for CI before clocking out, so this is unnecessary |
| a second-level agent tree, AFK modes, automated quality pipelines | one `yan` per `task`; quality stays with `user`, CI, and review |
| wrapping an outside worktree tool | the pool is built in |

The scripts stay thin because those multi-backend branches, journals, and migration paths are not required here.

### On automated quality pipelines

Not adopted. An automated pipeline for review, adding tests, adding documentation, and fixing CI is out of scope. Quality control falls back to `user`, CI, and review by colleagues — which is how a normal team already works.

A consistency check: `yan`'s `mode` system has no such level, and the default `mr` opens an MR directly. When CI goes red, `yan` finds out by asking the forge and dispatches a new `shift` to fix it ([§5.3](agents.md#53-the-life-of-a-shift)). Nothing in that chain depends on an automated quality pipeline.

### Roadmap

| Stage | What gets added |
| --- | --- |
| 0→1 | everything above, including soft-path create/`continue`, monorepo package multiselect into `scope` / units at create time ([cli-ux.md](cli-ux.md)). Acceptance still stresses one live `shift` end to end |
| 1→2 | `needs` ordering across several units, several concurrent shifts, and a fourth source for `yan wait` that polls the forge |
| 2→10 | Herdr (the second implementation of `lib-term.sh`), `scout` deliverables, and a recovery procedure for a stuck `shift` |
| 10→100 | choosing model and effort per task, the `merge-check` hook, and periodic trimming of `learnings` |

Herdr will definitely be supported; it is only postponed for lack of time. It brings two things tmux cannot give:

1. Native per-pane agent status, so `term_agent_alive` goes from guessing to asking ([§5.7](agents.md#57-terminal-topology)).
2. Push events (`pane.agent_status_changed`). The third source of `yan wait` — an unchanged pane hash meaning the agent may be stuck — is a heuristic, whereas Herdr's native `blocked` status is a fact. Polling could be replaced by subscribing to a socket.

Gathering terminal operations into seven functions in [§5.7](agents.md#57-terminal-topology) is preparation for that day: adding Herdr means writing a second implementation, with no change to the data model.

### Explicitly out of scope

- Running `yan` on harnesses other than Claude Code and Codex ([§5.6](agents.md#56-harness-requirements)). Kimi and the rest remain shift-only CLIs.
- A backend abstraction layer or plugin framework. Herdr arrives as a second implementation of `lib-term.sh`, and needs no framework. Dual harness for `yan` is two hook registrations plus `conf/config.json`, not a plugin system.
- Entry points from social platforms.
- Routing quota across providers.
- A second-level agent tree; `yan` never spawns another `yan`.
- An automated quality pipeline (review / tests / docs / CI-fix as a built-in product mode).

These are not `yan`'s circumstances.

---

## 12. Open questions

Everything still undecided across the system, including the ones about code structure.

1. **Should `$YAN_HOME` be under git?** Having commit history for `mem/user.md` and `learnings/` would be valuable, because you could see how preferences evolved. If it is versioned, does `tasks/` go in too, which would be very noisy? Current leaning: `mem/` in, `tasks/` out. This does not block the first version — it can be added at any time with a `git init`.
2. **How to trim `tasks/`.** Current leaning: delete nothing automatically, trim semi-manually with `yan prune`, and keep `artifacts/` even when the rest of a task is trimmed. This does not block the first version, since there will be nothing accumulated yet.
3. **The format of a `task` id.** A plain sequence number like `t042`, or a slug with meaning in it? A number is short but says nothing; a slug reads well but duplicates the brief's title. Note that it goes into branch names ([§6.5](branching.md#65-who-names-branches), `yan/<task>-<unit>-<sid>`), so being short has a practical benefit. Current leaning: numbers in the `t042` style, with the readable title living in the title lines of `brief.md` and `log.md` (and collected by `yan task new`'s title prompt). This has to be settled before `yan task new` is written.
4. **Should `lib-pool`'s pool root be configurable?** `~/.yan-trees/<repo>-<hash>/N/<repo>` ([§3](INDEX.md#3-directory-layout)) is what is written today.

### Settled: shift branches are pushed to the remote

**Decided: they are pushed.** Both levels of MR are kept.

The reason is not on any list of pros and cons. It is this: **one independent MR per `shift` is how `user` reviews the work** — going through it one `shift` at a time, reading each diff against the integration branch, with almost no need to read code locally. That turns the two levels of review in [§6.2](branching.md#62-two-levels-of-review) from a by-product of the structure into one of the reasons for wanting the system at all.

The accepted cost: the server accumulates a pile of `yan/*` branches and a pile of internal MRs. The cleanup is the clock-out order in [§5.3](agents.md#53-the-life-of-a-shift) and [§7](worktree.md#7-worktrees) — once merged, delete, and the deletion comes after the tree is returned. `user` judged the cost of the repeated CI runs to be negligible, so nothing is done about it.

### Settled: human CLI soft path

**Decided:** TTY prompts via `@clack/prompts`; `yan task new` creates units (including monorepo package scope) and enters the session; `yan start` is renamed `yan continue`; full flags or non-TTY skip prompts. Details in [`cli-ux.md`](cli-ux.md).
