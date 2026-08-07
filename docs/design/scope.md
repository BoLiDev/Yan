# Scope and open questions

## 11. Scope of the first version

Throughout the design, "0→1" means the first version that works end to end. "1→2", "2→10", and "10→100" are the stages after it.

### What is in it

One `yan` entry point plus 20 subcommands, 2 hook scripts, and 8 libraries, plus `AGENTS.md`. The list of subcommands and hooks is in [Appendix C](appendix.md#appendix-c-script-inventory); the 8 libraries and how they are arranged are in [`architecture.md` §3](architecture.md#3-repository-layout) and [`architecture.md` §5](architecture.md#5-subcommands).

The two heaviest pieces are the built-in worktree pool ([§7](worktree.md#7-worktrees)) and the forge layer supporting two remotes ([§8.4](delivery.md#84-the-forge-layer)). Of the pool, the branch awareness, the test for returning a tree, and the orphan-commit guard all had to be written anyway; the genuinely extra parts are reuse and leases. What that buys is zero outside dependencies, and a first version that can be accepted against `yan`'s own repository.

**The acceptance test for 0→1:** a one-sentence request → one `unit` → one `shift` → the shift branch's MR merges into the integration branch → the `shift` clocks out and returns its tree → the outbound MR is opened → `user` says to merge → it is merged → `log.md` records the whole chain.

### Why this is much smaller than firstmate

firstmate has 109 files and 19 skills. The gap is not a miracle; it is the sum of the things ruled out:

| firstmate has it, `yan` does not | Note |
| --- | --- |
| a watcher plus a separate triage layer | the wake pipeline is copied one for one; what is dropped is the separate triage layer ([§5.5](supervision.md#55-supervision)) |
| several backends (Herdr, zellij, orca, cmux, codex-app) plus an abstraction layer | `yan` will only ever need a second implementation of `lib-term.sh` |
| X mode and public-followup | not done at all |
| PR poll registration and trust binding | a `shift` does not wait for CI before clocking out, so this is unnecessary |
| secondmate, config inheritance, AFK, no-mistakes integration | one `yan` per `task`, so there is no second-level agent tree |
| install / lint / doc-check / treehouse | the pool is built in, the rest is not done |

The gap is not only in the number of files but in how thick each one is: every firstmate script carries multi-backend branches, a safety journal, and migration paths. **`yan` does not have those, not because it is written better, but because none of the things that made firstmate grow apply here.**

### On no-mistakes

Not adopted. In firstmate, no-mistakes is an automated pipeline for review, adding tests, adding documentation, and fixing CI. The cost of leaving it out is that quality control falls back to `user`, CI, and review by colleagues — which is how a normal team already works.

A consistency check: `yan`'s `mode` system has no no-mistakes level, and the default `mr` opens an MR directly. When CI goes red, `yan` finds out by asking GitLab and dispatches a new `shift` to fix it ([§5.3](agents.md#53-the-life-of-a-shift)). Nothing in that chain depends on it.

### Roadmap

| Stage | What gets added |
| --- | --- |
| 0→1 | everything above. One `unit`, one `shift`, working end to end |
| 1→2 | several units (across repositories, or across a monorepo's sub-applications), `needs` ordering, several concurrent shifts, and a fourth source for `yan wait` that polls GitLab |
| 2→10 | Herdr (the second implementation of `lib-term.sh`), `scout` deliverables, and a recovery procedure for a stuck `shift` |
| 10→100 | choosing model and effort per task, the `merge-check` hook, and periodic trimming of `learnings` |

Herdr will definitely be supported; it is only postponed for lack of time. It brings two things tmux cannot give:

1. Native per-pane agent status, so `term_agent_alive` goes from guessing to asking ([§5.7](agents.md#57-terminal-topology)).
2. Push events (`pane.agent_status_changed`). The third source of `yan wait` — an unchanged pane hash meaning the agent may be stuck — is a heuristic, whereas Herdr's native `blocked` status is a fact. Polling could be replaced by subscribing to a socket.

Gathering terminal operations into seven functions in [§5.7](agents.md#57-terminal-topology) is preparation for that day: adding Herdr means writing a second implementation, with no change to the data model.

### Explicitly out of scope

- Running `yan` itself on a harness other than Claude Code ([§5.6](agents.md#56-harness-requirements)). Codex, Kimi Code, and the rest are only harnesses for a `shift`.
- A backend abstraction layer or plugin framework. Herdr arrives as a second implementation of `lib-term.sh`, and needs no framework.
- Entry points from social platforms.
- Routing quota across providers.
- A second-level agent tree; `yan` never spawns another `yan`.
- A quality pipeline of its own, the slot firstmate fills with no-mistakes.

These are firstmate's circumstances, not `yan`'s.

---

## 12. Open questions

Everything still undecided across the system, including the ones about code structure.

1. **Should `$YAN_HOME` be under git?** Having commit history for `mem/user.md` and `learnings/` would be valuable, because you could see how preferences evolved. If it is versioned, does `tasks/` go in too, which would be very noisy? Current leaning: `mem/` in, `tasks/` out. This does not block the first version — it can be added at any time with a `git init`.
2. **How to trim `tasks/`.** Current leaning: delete nothing automatically, trim semi-manually with `yan prune`, and keep `artifacts/` even when the rest of a task is trimmed. This does not block the first version, since there will be nothing accumulated yet.
3. **The format of a `task` id.** A plain sequence number like `t042`, or a slug with meaning in it? A number is short but says nothing; a slug reads well but duplicates the brief's title. Note that it goes into branch names ([§6.5](branching.md#65-who-names-branches), `yan/<task>-<unit>-<sid>`), so being short has a practical benefit. Current leaning: numbers in the `t042` style, with the readable title living in the title lines of `brief.md` and `log.md`. This has to be settled before `yan task new` is written; see [`implementation-plan.md` §4](../implementation-plan.md#4-what-is-blocking-right-now).
4. **Should `lib-pool`'s pool root be configurable?** `~/.yan-trees/<repo>-<hash>/N/<repo>` ([§3](INDEX.md#3-directory-layout)) is what is written today.

### Settled: shift branches are pushed to the remote

**Decided: they are pushed.** Both levels of MR are kept.

The reason is not on any list of pros and cons. It is this: **one independent MR per `shift` is how `user` reviews the work** — going through it one `shift` at a time, reading each diff against the integration branch, with almost no need to read code locally. That turns the two levels of review in [§6.2](branching.md#62-two-levels-of-review) from a by-product of the structure into one of the reasons for wanting the system at all.

The accepted cost: the server accumulates a pile of `yan/*` branches and a pile of internal MRs. The cleanup is the clock-out order in [§5.3](agents.md#53-the-life-of-a-shift) and [§7](worktree.md#7-worktrees) — once merged, delete, and the deletion comes after the tree is returned. `user` judged the cost of the repeated CI runs to be negligible, so nothing is done about it.
