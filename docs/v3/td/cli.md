# The CLI, after V3

> [`vault.md`](vault.md) and [`repos.md`](repos.md) introduce the commands in passing. This document is the flat list — what is new, what is renamed, what a command does differently, and the one row the authority table gains.

---

## 1. New

```
yan vault init <name> --remote <url> [--path <dir>]   create and push a vault
yan vault clone <url> [--name] [--path]               take one on a new machine
yan vault ls                                          registered vaults, active first
yan vault use <name>       (alias: yan use <name>)    switch the active vault
yan vault where                                       where the active vault is
yan vault link <name> <path>                          where a vault is on THIS machine
yan vault drop-home                                   step 7 of a --from-home migration
yan vault pull                                        fetch + rebase (session-start runs this)
yan vault push [-m <msg>]                             stage, commit, push
yan repo link <name> <path>                           the machine half of the registry
yan repo ls                                           registered, and whether linked here
```

`yan use` exists as an alias because it is the one a person types in anger, and `yan vault use` is four words for a thing you do while thinking about something else. Everything else stays under the `vault` noun so `yan --help` reads as a shape rather than a pile.

Nothing here needs a table anywhere: subcommands are still derived from `dist/cli/` at runtime ([home.ts](../../../src/util/home.ts)), so a new file *is* a new command.

## 2. Renamed

| Was | Is | Why |
| --- | --- | --- |
| `yan repo-add <url>` | `yan repo add [target]` | it grew siblings (`link`, `ls`), and `task new` / `unit add` already established the shape |

The old spelling is not kept as an alias. It has one user, this repository's own documents, and a dead alias is a second answer to "what is the command".

## 3. Behaves differently

**`yan session-start`** runs `yan vault pull` before it rebuilds the picture, and prints which vault it is in. A pull that fails — no network, dirty tree, conflict — degrades to a warning line and the session continues on local state. Refusing to start a session because a remote is unreachable would be a worse tool than not syncing at all.

**Bare `yan`** (the select) puts the active vault in its header. Two contexts on one machine means "which one am I in" is a question you can be silently wrong about, and the answer costs one line.

**Every list a person picks from is searchable.** The entry select, `yan done`'s batch, `yan continue`, `yan repo add`'s scan, and both lists in `yan task new` — the repositories, then that repository's packages — are `autocomplete` and `autocompleteMultiselect` rather than `select` and `multiselect`. The lists are neither fixed nor small: a monorepo offers dozens of packages, and a working vault accumulates repositories and tasks. Which end of that range you are at is not something the code gets to decide, and a search box nobody types into behaves exactly like the select it replaced — so the choice is made once, for all of them.

**`yan doctor`** gains four rows:

```
vault        personal → C:/workspace/project/yan-vault  (or FAIL: none registered)
vault remote origin reachable, N commits ahead / behind
repos        4 registered, 3 linked on this machine       (WARN, naming the missing)
clone_root   C:/workspace/project                          (WARN if missing)
```

The "registered but not linked here" row is the one that earns its place: it is the normal state of a freshly cloned vault, and it is the state where every other command fails with a confusing message unless doctor said it first.

**Everything that reads or writes data** — `task`, `unit`, `shift`, `ls`, `sync`, `mr`, `land`, `done`, `open`, `state`, `send`, `report`, `wait`, `drain` — changes one thing: the root it resolves against. No flags change, no output changes.

## 4. The path roots, in code

`yanHome()` currently answers three questions. It gets split, and the split is mechanical:

| helper | answers | derivation |
| --- | --- | --- |
| `util/home.ts` → `yanHome()` | where the code is | unchanged: `$YAN_HOME` if it validates, else from this file's location |
| `util/vault.ts` → `vaultDir()` | where the assets are | `$YAN_VAULT` if it validates (`vault.json` present), else `~/.yan/config.json`'s `active` |
| `util/machine.ts` → `machineDir()` | where this disk's state is | `$YAN_MACHINE_DIR`, else `~/.yan` |

Every `join(yanHome(), 'tasks' | 'mem' | 'conf')` becomes `join(vaultDir(), …)`. That is roughly fifteen call sites and they are all in `records/`, `cli/shared/` and `cli/`. `$YAN_MACHINE_DIR` exists so tests can isolate the machine layer the way they already isolate `$YAN_HOME`; it is not documented for users.

`vaultDir()` throwing is a normal, expected outcome — no vault registered yet — so it throws the CLI's own error type with the `yan vault init` instruction in it, and the read-only commands that genuinely do not need a vault (`doctor`, `vault ls`, `vault init`, `vault clone`, `--help`) must not call it.

## 5. Authority

One new row, on the right.

| On your own | Only when `user` asks |
| --- | --- |
| `yan vault pull` — it reads | **`yan vault push` — it writes to a remote** |
| `yan repo add` / `link`, `yan vault link` — saying where something is on this disk is reversible bookkeeping | `yan vault init` / `clone` / `use` — which context you are in is a decision, and a wrong one puts a work task in a personal remote |

The push row is the strict reading of the existing rule (*anything a colleague will see needs `user` to say so first*) applied to a repository that is usually private. It may be too strict, and it is cheap to relax later — the reverse is not.
