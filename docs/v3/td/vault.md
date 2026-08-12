# The vault

> A **vault** is one context's task assets, kept in a git repository you own. [`INDEX.md §2`](INDEX.md#2-the-three-layers) says why it exists. This document says what is in it, how one is created, and how it moves between machines.

---

## 1. The word

A vault is *not* a workspace and not a worktree — those words are taken, and the pool already owns the second one. It is the place the assets are kept: `tasks/`, `mem/`, the registry, the forge choice. One vault per context. "Context" means: whose forge, whose colleagues, whose projects. Home and work are two. A second personal machine is not — it opens the same vault.

---

## 2. Layout

```
<vault>/
  vault.json               identity. Written by `yan vault init`, then left alone
  config.json              choices. agents.* and remote_git.* — you edit this one
  repos.json               the repository registry, portable half (repos.md)
  tasks/
    t103/
      task.json            decisions
      brief.md             what user asked for
      log.md               the narrative, append-only
      artifacts/           what a person looks at
      shifts/
        s1/
          brief.md         what the shift was told
          outcome.md       what it found — the raw material of the next brief
          run/             ← gitignored: throwaway, and pane ids are machine-local
      run/                 ← gitignored: wait lock, beacon, wake
      .enter.lock          ← gitignored
  mem/
    user.md                judgements about a person, written only when asked
    learnings/             yan may write these on its own
  hooks/                   your executables for the outside-authority seam
  .local/                  ← gitignored, whole directory (machine layer)
    repos.json             name → this machine's clone path
  .gitignore
  README.md                what this vault is and whose it is
```

### Why `vault.json` and `config.json` are two files

Identity versus choices. `vault.json` is written once by `yan vault init` and never edited by hand — it is how `vaultDir()` recognises a directory as a vault at all, the way `bin/yan` is how `yanHome()` recognises a home:

```jsonc
{ "version": 1, "name": "personal", "created": "2026-08-12" }
```

`config.json` is the file you open when something is wrong. It is the same shape `conf/config.json` has today, moved wholesale, which is the point — `agentFor()` and the `remote_git` reader change one path and nothing else:

```jsonc
{ "version": 1,
  "agents": { "yan": "claude", "shift": "claude" },
  "remote_git": { "kind": "github", "host": "github.com" } }
```

Keeping them separate means `yan vault init` can write a marker that a hand-edit cannot accidentally invalidate, and a broken `config.json` still leaves the vault identifiable enough to say *which* vault is broken.

### What is tracked and what is not

Tracked: everything that answers "what did we decide, what did we try, what did we learn". That explicitly includes `shifts/*/brief.md` and `shifts/*/outcome.md` — an outcome is the raw material of the next brief, and [the third thing a brief must carry](../../mvp/td/agents.md) is what has already been tried. Losing those to a disk is the failure V3 exists to prevent.

Not tracked, and the rule is one line: **`run/` is throwaway, and machine-local things are wrong elsewhere.** So `tasks/*/run/`, `tasks/*/shifts/*/run/`, `tasks/*/.enter.lock`, and all of `.local/`. `run/meta.json` holds Herdr pane ids; committing them would let one machine's session state look authoritative on another, which is exactly the kind of second answer [design principle 1](../../mvp/td/INDEX.md#0-what-yan-is) forbids.

The vault's `.gitignore` ships in the template and is the only place this list lives.

### Why `hooks/` is in here at all

Two things in yan are called hooks and they point in opposite directions. `bin/hook-*.sh` with `.claude/settings.json` and `.codex/hooks.json` are the **harness calling yan** — the Stop hook that arms `yan wait`, the SessionStart hook that rebuilds the picture. Those are how the code wires itself into an agent CLI, they are the same for everyone, and they never leave the mechanics clone.

`<vault>/hooks/` is the other direction: **yan calling you**, the outside-authority seam of [boundaries.md §10](../../mvp/td/boundaries.md), with one hook so far — `branch-name`, which `yan unit add` asks before it names an integration branch.

It belongs to the vault because what it encodes is *the context's rule, not yan's behaviour*. A company repository that requires `feat/<ticket>`, or `hotfix/*` during a release, has a rule that is true at work, meaningless at home, and still true on your second work machine. That is the home/work line exactly — not a property of the code, and not a property of a disk.

**The consequence, stated rather than discovered:** `conf/hooks/` was gitignored and local-only; `<vault>/hooks/` is tracked and pushed, so a hook now *travels* — an executable arriving over `git pull` and then run by yan. In a private vault that is the point of the move rather than a hazard, but it is a change in the trust story and it is worth knowing before the first hook is installed. Somebody who would rather not sync executables puts them in the machine layer instead, and re-installs them per machine.

---

## 3. Finding the active vault

```
$YAN_VAULT                        if set, and if it really is a vault
~/.yan/config.json → active       otherwise
neither                           → a clear error naming `yan vault init`
```

Same shape as `yanHome()`: an exported override wins, but only when it validates — `vault.json` present. The env var is not just for tests; a work machine can pin a terminal profile to the work vault and never depend on global state.

`~/.yan/config.json` is the machine layer:

```jsonc
{ "version": 1,
  "active": "personal",
  "clone_root": "C:/workspace/project",
  "vaults": { "personal": "C:/workspace/project/yan-vault",
              "work":     "D:/work/yan-vault" } }
```

`clone_root` is here rather than in the vault because it is a fact about this disk. It is where `yan repo add <url>` clones into.

When a vault directory moves, `yan vault link <name> <path>` is what updates it — the exact dual of `yan repo link`, and it exists for the same reason: this file has one owner, and editing it by hand works right up until it is the thing that is wrong.

---

## 4. Bootstrap

The remote must exist and be empty — creating a repository on a forge is a thirty-second click and not worth a code path that has to handle two APIs, two auth stories and a name collision.

```
yan vault init <name> --remote <url> [--path <dir>]
```

1. Refuse early if `<name>` is already registered, or `<dir>` exists and is not empty.
2. Copy `templates/vault/` from the mechanics into `<dir>` — the skeleton above, with an empty `tasks/`, an empty `mem/learnings/`, the `.gitignore`, and `config.json`. There is no separate sample to copy from: the template IS the sample.
3. `git init`, commit, `git remote add origin <url>`, `git push -u origin main`.
4. Register it in `~/.yan/config.json` and make it active.

`--path` defaults to a sibling of the mechanics clone, so the common case is one flag shorter.

On a second machine, the vault already exists:

```
yan vault clone <url> [--name <name>] [--path <dir>]
```

which clones, reads `vault.json` for the name, registers, activates — and then tells you what is missing, because `.local/repos.json` is empty on a fresh clone and every registered repository needs a local path. That hand-off is [repos.md §4](repos.md#4-a-fresh-machine).

---

## 5. Sync

Two commands, and they are deliberately not one. `yan sync` already means something else entirely — bring a unit's integration branch up to date with its target — and a `yan vault sync` sitting next to it would be a name collision in the only place it matters, which is a tired person's memory.

```
yan vault pull          fetch + rebase. Read-only with respect to the remote
yan vault push [-m …]   stage everything, commit, push
```

**Pull is automatic; push is not.** `yan session-start` runs the pull before it rebuilds the picture, so a session that begins on the laptop begins with the desktop's work already in it. It is safe to automate because it cannot publish anything, and because failing it is not fatal — a missing network, a dirty tree, a conflict all downgrade to a warning line in the session-start output and the session continues on local state. A session-start that refuses to start because a remote is unreachable would be a worse tool than no sync at all.

Push stays manual because it is a write to a remote, and because auto-committing every `log.md` append would produce a history nobody can read. The default commit message is generated from what changed (`t103: 3 files`), and `-m` overrides it. This goes in the authority table's right-hand column: **`yan vault push` happens when `user` asks.** Revisit once we have lived with it.

Conflicts are git's problem and we do not wrap them. `log.md` is append-only so its conflicts are line-level and obvious; `task.json` is small enough to read. The one thing `yan vault pull` does add is refusing to rebase a dirty tree with a message that says which files are dirty, rather than letting git leave a half-finished rebase in a directory the user does not think of as a repository.

---

## 6. Failure modes worth naming

| Situation | What yan does |
| --- | --- |
| no vault registered at all | every data-touching command fails with one message naming `yan vault init`. Not a prompt: creating a vault is a decision |
| `active` names a vault whose directory is gone | fail with the path and the two ways out — `yan vault clone` or `yan use <other>` |
| `$YAN_VAULT` set but not a vault | ignored, exactly as an invalid `$YAN_HOME` is ignored, and `yan doctor` says so |
| two machines pushed the same task | a rebase conflict on `log.md` or `task.json`, surfaced verbatim |
| vault written by a newer mechanics (`vault.json` version ahead) | refuse, and say to update the mechanics. A silent downgrade would corrupt the newer format |
