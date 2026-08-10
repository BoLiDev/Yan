# Display: `yan` owns, Herdr shows

> Herdr can create and remove git worktrees. `yan` has a worktree pool. This document says why the pool stays where it is, and what `yan` hands to Herdr instead.

---

## 1. The decision

**`yan` keeps the worktree pool. Herdr is told what to display and is given no authority over it.**

Herdr offers `worktree create | open | remove | list`, backed by workspaces. It would be easy to read that as "the pool is now someone else's problem". It is not the same problem:

| `yan`'s pool ([td §7](../../mvp/td/worktree.md#7-worktrees)) | Herdr's worktrees |
| --- | --- |
| leases with holders and conditional return (`--if-lease-id`) | open a worktree as a workspace |
| a pool size limit, so a full pool is backpressure rather than silent growth | — |
| warm reuse: return is `reset --hard` + `clean -fd`, **never** `-x`, so gitignored installs survive | — |
| the orphan-commit guard: refuse to return a tree that would lose work | — |
| lives at `~/.yan-trees/…`, deliberately outside `$YAN_HOME` | follows Herdr's own layout |

Those left-hand rows are `yan`'s policy, and one of them — the guard — is the only thing standing between a returned tree and lost work. Handing worktree lifetime to a UI tool would also put [rule 4](../../../CLAUDE.md) (*never work in a main clone; `repos/<repo>/` is read-only*) behind someone else's decisions.

So the flow is: **`yan tree get` leases a path → `yan` passes that path as `pane split --cwd <path>`.** Herdr hosts the terminal; it does not own the checkout. `herdr worktree *` is not called by `yan` at all.

---

## 2. What `yan` reports for display

Two `report-metadata` calls, both **display-only** by Herdr's own definition, both idempotent, both revocable. This is the whole integration.

Source note: `report-metadata` is documented by the binary only — `herdr workspace report-metadata --help`, `herdr pane report-metadata --help`, and the `WorkspaceReportMetadataParams` / `PaneReportMetadataParams` shapes in `herdr api schema --json`. The website does not cover it ([sources.md §1](sources.md#1-order-of-authority)), so the flags below were verified by running them ([evidence §4](evidence.md#4-display-metadata)).

### Workspace tokens — which unit this workspace is delivering

```
herdr workspace report-metadata <workspace_id> --source yan \
  --token task=t042 --token unit=auth --token branch=feat/auth-round2 \
  --ttl-ms <n>
```

Surfaces as `workspace get` → `"tokens": {"branch":"feat/auth-round2","task":"t042","unit":"auth"}`.

### Pane title — which shift this pane is

```
herdr pane report-metadata <pane_id> --source yan \
  --title "s3-auth · unit=auth" --display-agent "yan:shift"
```

Surfaces as `agent list` → `{"name":"s3-auth","display_agent":"yan:shift","title":"s3-auth · unit=auth"}`, and, when `ui.show_agent_labels_on_pane_borders` is on, is drawn on the pane border.

---

## 3. Why this shape is safe

Three properties of `report-metadata`, and each one is load-bearing:

1. **`--source yan` names the reporter.** Herdr tracks who said what, so `yan`'s labels never collide with another tool's and can be withdrawn as a set.
2. **`--ttl-ms` expires.** A `yan` that dies mid-task leaves labels that clean themselves up. This is the same instinct as [design principle 1](../../mvp/td/INDEX.md#0-what-yan-is) — do not store state you can derive — applied to a place `yan` does not own.
3. **`--clear-token` / `--clear-title` withdraw.** Teardown is explicit and complete.

And the property that matters most: **Herdr receives presentation, never truth**. Nothing `yan` reports here is ever read back as a fact. `task.json` remains the only record of which unit is on which branch; the tokens are a copy for human eyes, and a copy that goes stale is a cosmetic bug rather than a correctness one.

That is the line the MVP already drew between facts, state, and decisions ([td §2](../../mvp/td/INDEX.md#2-storage-criteria)). Display is a fourth thing, and it is the only one allowed to be duplicated.

---

## 4. When each call happens

| Moment | Call |
| --- | --- |
| Moment | Call | Owner |
| --- | --- | --- |
| `yan continue` / `yan task new` starts the main agent | workspace tokens for the task and its current unit | Phase 8 |
| `yan unit set --branch` starts a new round | workspace tokens rewritten — **if the workspace can be identified**, see below | Phase 7 |
| `yan shift new` splits the pane | pane title and `display_agent` for the new shift | Phase 7 |
| `yan shift done` | pane title cleared before the pane is closed | Phase 7 |
| task complete, or `yan` exits | `--clear-token` for every token it set | **unowned** until Phase 8 |

**Which workspace?** There are exactly two ways to know, and one of them is unusable here: `workspace create` returns the id but *creates*, so a relabel must never call it; and a live shift's `run/meta.json` records the container it was dispatched into. So `unit set --branch` derives the workspace from a live shift of that unit and **silently does nothing when there is none** — a task with no shift running has no workspace to label, and inventing one would be worse than an unlabelled tab.

The last row has no owner yet, and saying so is better than implying it happens. Clearing on exit needs someone who knows the workspace's lifetime, and that is `yan continue` — Phase 8.

Failures here are **never fatal**. If Herdr refuses a metadata call, `yan` logs one line and carries on: the work is correct with ugly labels, and a tool that will not dispatch a shift because a title did not stick is a worse tool.

---

## 5. Notifications

`herdr notification show <title> --body --sound none|done|request` is available and is the natural place for the moments where `yan` needs `user` and `user` is not looking — a `blocked` shift, a merge conflict, an escalation from the authority table.

It is **opt-in** and off by default (`conf/config.json`). The reason is the one already in [CLAUDE.md](../../../CLAUDE.md): interrupting is a cost, and a tool that decides on its own when to interrupt gets muted. `yan` may notify for the events `user` has said it may notify for, and for nothing else.
