# Boundaries

## 9. What `yan` may write

### 9.1 The file system

`yan` writes only its own bookkeeping: `task.json`, `log.md`, the `brief.md` files at each level, `run/meta.json`, `mem/learnings/`, and `mem/repos.json`.

There are four groups it does not write. The main clones under `repos/` (the only write allowed there is `git fetch`; never check out, never touch the working tree, never commit). The files a `shift` writes for itself: `status`, `outcome.md`, `artifacts/`. `user`'s local choices in `conf/`. And `yan`'s own `bin/` and `AGENTS.md`, which it does not modify at runtime. It also does not read other tasks' directories ([§5.2](agents.md#52-one-yan-per-task)).

The full list is in [Appendix B](appendix.md#appendix-b-file-system-boundary-for-yan).

### 9.2 External side effects

| Action | Who does it | Authority |
| --- | --- | --- |
| `yan tree get / return` without force | `yan`, `shift` | on its own |
| forcing a tree back past the orphan-commit guard | `yan` | `user` has to ask for it — the changes are thrown away. V2 spells it `yan done --force`, and `yan tree return` deliberately has no flag for it |
| open or close a terminal | `yan` | on its own |
| push a shift branch | `shift` | on its own |
| push the integration branch, after `yan sync` | `yan` | on its own |
| `git push --force` anywhere | — | forbidden |
| open a shift branch MR into the integration branch | `shift` | on its own |
| merge a shift branch MR into the integration branch | `yan` | on its own — this is the internal checkpoint, on a branch `user` owns |
| open the outbound MR from the integration branch to `target` | `yan` | on its own, because opening an MR is reversible |
| merge the outbound MR into `target` | `yan` | `user` has to ask for it |
| delete a merged shift branch | `yan` | on its own, and it must come after the tree is returned ([§7](worktree.md#7-worktrees)) |
| delete any unmerged branch | — | forbidden |
| `yan unit set`, changing `branch`, `target`, `mode`, or `scope` | `yan` | `user` has to ask for it, because every one of these is a decision |
| comment on an MR, or mention someone | — | `user` has to ask for it, because it interrupts colleagues |

> Inside your own branches and your own machine, act on your own. Anything that affects `target`, or that a colleague will see, requires `user` to say so.

### 9.3 What a `shift` may write

A `shift` writes in three places: the `status` and `outcome` files under its own `shifts/<sid>/`, `tasks/<id>/artifacts/`, and the code in the tree it leased. It never touches `mem/`, `task.json`, the integration branch, or a main clone.

In the other direction, `yan` never goes into a worktree to edit code. The one time it enters a tree is `yan sync`, which is a script action, and which exits immediately on a conflict and hands the job to a `shift`. This keeps "who changed what" always attributable.

---

## 10. Seams for outside authorities

> Keep this separate from the harness lifecycle hooks in [§5.5](supervision.md#55-supervision) (Claude Code and Codex). Those are harness hooks. These are seams for decisions `user` may want answered outside `yan` — what the integration branch should be called, whether it may be merged. Same word, different things.

`user` may already have branch-naming or merge rules (a local script, a skill, team tooling). None of that belongs inside `yan`'s code. Opt-in hooks under `conf/hooks/` are the seam: `yan` asks, records the answer, and assumes nothing about the name's shape.

```
conf/hooks/
  branch-name      name the integration branch (or create it outright)
  merge-check      decide whether it may be merged   ← reserved name; unused
```

`conf/` is local and gitignored. It represents the choices of this machine and this team, and is not part of `yan`. The full inventory and a sample are in [Appendix D](appendix.md#appendix-d-configuration).

### The branch-name contract

**It is called for the integration branch only.** Shift branches are always named by `yan` ([§6.5](branching.md#65-who-names-branches)). How the integration name is produced is `user`'s decision; the hook is one way to supply that decision, not a second owner of shift branches.

The input is JSON on stdin, so fields can be added later without breaking an existing hook. The output is one line on stdout, the branch name. The asymmetry is deliberate.

```json
{ task: t042, task_title: unify the auth header,
  unit: auth, repo: monorepo-x, target: master,
  scope: [apps/auth] }
```

The hook may create or register the branch itself, as long as it prints the branch name on stdout at the end. That covers both "return a name" and "create the branch, then return its name":

```
name=$(hook branch-name <<< "$ctx") || die "branch naming was refused"
the branch already exists (locally or on the remote) → check it out
the branch does not exist                            → cut it from the base
```

Failure semantics: if the hook exits non-zero, `yan` stops and reports the error. It never falls back to the built-in default. Otherwise, after the hook refused, `yan` would quietly create a branch that breaks the team's rules and may not be mergeable at all — which is much worse than failing outright.

**Why this is a hook rather than built in:** the integration branch's name is `user`'s decision ([§6.5](branching.md#65-who-names-branches)). `yan`'s job is to record it and to assume nothing about its shape. `merge-check` will work the same way when it arrives: whether something may be merged is a decision `user` may outsource; `yan` only carries it out and records it.
