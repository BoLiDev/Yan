# Human CLI UX, second cut

> This document revises [td cli-ux.md](../../mvp/td/cli-ux.md). The soft/hard path rule, the Clack toolkit, and monorepo-aware scope selection are all unchanged. What changes is the entry: `yan` stops building the place `user` works in, because `user` is already standing in it.

---

## 1. The mistake being corrected

The MVP's create flow ends by **creating a terminal container and putting `user` inside it** ([cli-ux §3](../../mvp/td/cli-ux.md#3-yan-task-new-create-and-enter)). Under tmux that was right: nothing else was going to make the session.

Under Herdr it is backwards. Herdr *is* the multiplexer, and it is where `user` already lives — with other work in other workspaces, running agents that have nothing to do with `yan`. A `yan` that launches its own multiplexer to hold its own session is a tool insisting on its own furniture in someone else's house.

**So the rule for V2 is: `yan` joins, it does not host.** Every place the MVP said "create the container and enter it", V2 says "split a pane here". `attach` disappears from the vocabulary entirely, because there is nothing to attach to — we are already inside.

---

## 2. The flow

```
1  user runs `herdr`                        (once, their own habit, nothing to do with yan)
2  user types `yan` in any pane
3  a select appears:
       › create new task
         t042  unify the auth header          2 shifts live
         t041  gateway retry budget           idle
4  choosing a task starts `yan` for it, in this pane
   choosing "create new task" walks the create prompts, then does the same
```

Step 4 is where the change bites. The MVP would have made a session; V2 starts the main agent **in the pane the user typed in**. A shift dispatched later becomes a sibling pane via `pane split --no-focus`, so `user`'s focus never moves ([terminal.md §2](terminal.md#2-the-seven-functions)).

### Bare `yan`

Today `bin/yan:78` prints usage when given no arguments. That becomes:

| Invocation | Behaviour |
| --- | --- |
| `yan` with a TTY | the select above |
| `yan` without a TTY | usage, exit 0 — unchanged, so scripts and agents see no difference |
| `yan --help` / `yan <cmd> …` | Commander, as always |

This does not weaken "`user` and the agents share one entry point" ([principle 4](../../mvp/td/INDEX.md#0-what-yan-is)). It is the same rule the soft path already followed: an agent knows its arguments and passes them; a person does not and gets asked. The select is a soft path for the *command itself* rather than for one of its options.

### What the select is made of

Derived, never stored — the same scan `yan ls` already does over `tasks/*/task.json`, plus live shift counts. There is no new state, and no menu configuration file. If `yan ls` can render it, the select can offer it.

---

## 3. `yan continue` gets smaller

`yan continue` was: create-or-attach the task's container, then start or reattach the main agent. The first half goes away. What remains:

| Invocation | Soft path | Hard path |
| --- | --- | --- |
| `yan continue` | the select from §2 | refused: pass `--task <id>` |
| `yan continue --task <id>` | start `yan` for that task in the current pane | same, no prompt |

Two semantics carry over unchanged and must be re-tested after the rewrite, because both are easy to lose: **a second `yan` on the same task is still refused** ([td §5.2](../../mvp/td/agents.md#52-one-yan-per-task)), and if a `yan` for that task is already alive somewhere, `continue` says where it is rather than spawning a duplicate.

**Herdr cannot answer the second one, and this document said it could.** `agent list` does report every live agent with its pane id — but an agent Herdr recognised by matching the screen has `name: null`, and nothing in the listing says which *task* an agent belongs to. Only an agent started through `agent start` carries a name, and that needs a pane already at an interactive prompt, which the pane running `yan continue` is not.

So the fact lives where it always did: **the per-task lock**, `tasks/<id>/.enter.lock`. V2's `yan continue` does not `exec` — it spawns the agent as a child, holds this pane's stdio, and waits — so the lock's own pid is the running `yan`, and `pidAlive` makes a killed one's lock reclaimable rather than permanent. The lock records the pane, which is how `continue` says *where* the live one is.

The three `tmux attach` calls in `yan-continue.sh` have no replacement. They are deleted, not ported.

---

## 4. Commander next to Clack

They are not alternatives and they do not overlap:

| | Job |
| --- | --- |
| Commander | parse `argv`, define subcommands and options, generate `--help` |
| Clack | ask a human for a value that `argv` did not carry |

The join is the `resolve()` helper in [runtime.md §3](runtime.md#3-commander): no option is declared required, the action handler decides between running, prompting, and refusing. One implementation, every command, and the soft/hard table from [cli-ux §1](../../mvp/td/cli-ux.md#1-why-prompts-exist) becomes a property of the framework rather than a discipline.

Atomic commands used only by agents — `yan report`, `yan wait`, `yan drain`, `yan send` — stay flag-only and grow no prompts. That rule is unchanged.

---

## 5. What `user` sees while work is running

`yan` does not paint a dashboard. Herdr already has one, and V2's job is to put the right words in it rather than to build a second one: pane titles carry the shift, workspace tokens carry the unit's branch and target, and the agent's own lifecycle colour is already on the pane border.

→ [`display.md`](display.md)

---

## 6. What is unchanged

Stated explicitly so a rewrite does not quietly drop it:

- **`yan task new` is still the strong create path** — contract, involved repos, concrete `scope` including monorepo packages, at least one `unit`, main agent running. Only the last step's mechanics change.
- **Monorepo detection and package multiselect** ([cli-ux §5](../../mvp/td/cli-ux.md#5-monorepo-aware-scope-selection)) — unchanged, including "one selected package → one unit" and the escape to whole-repo.
- **`target` is never defaulted.** The soft path asks. No command invents it.
- **Clack is still the toolkit.** `@clack/prompts` is already pinned in `ui/`; V2 moves it from a separate Node island into `src/ui/`, which removes the whole `lib-ui.sh` node-discovery dance (`ui_node`, the nvm fallback, the three-place search) — Node is now the runtime, not an optional extra.
