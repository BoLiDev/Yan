# Repositories without `repos/`

> Today `yan repo-add <url>` clones into `$YAN_HOME/repos/<name>/` and records the URL in `mem/repos.json`. V3 keeps the registry and deletes the directory. This document says what the registry looks like afterwards, why it is two files, and what changes when the main clone is one you also work in.

---

## 1. Why the directory goes

`repos/<name>/` is a second clone of a repository you already have on disk. It costs a full fetch, it costs disk, and it is invisible — you cannot `cd` into your project and see it. The only thing it bought was that yan controlled it completely, and that turns out to be recoverable by rule rather than by ownership (§3).

What replaces it is the thing that was always the real content: a registry that says **which repositories this context knows about**, plus, per machine, **where each one is**.

---

## 2. Two files, one registry

```jsonc
// <vault>/repos.json — tracked, portable
{ "version": 1,
  "poe-tools": { "url": "git@github.com:BoLiDev/poe-tools.git",
                 "mode_default": "mr",
                 "pool_size": 8 } }

// <vault>/.local/repos.json — gitignored, this machine only
{ "version": 1,
  "poe-tools": { "path": "C:/workspace/project/poe-tools" } }
```

The split is forced: a URL is true everywhere and a path is true on one disk. Putting them in one tracked file means every machine rewrites every other machine's paths on every push. Putting them both in an untracked file means a new machine starts with no idea which repositories the context even involves — and `task.json`'s `repo` field would dangle.

`pool_size` stays on the portable side despite being arguably a machine property. It is a tuning number that follows the repository ("this one is big, give it fewer trees"), the default is fine on any machine, and a second file for one integer is a worse trade than a number that is occasionally suboptimal.

`url` remains the identity. Two entries may not share a name; a name whose registered URL differs from the one being added is refused rather than merged, exactly as `repo-add` refuses today.

### Resolution

`repoDir(name)` today checks `$YAN_HOME/repos/<name>`, then treats the argument as a path. In V3:

```
.local/repos.json → path, if the entry exists and the directory is there
the argument itself, if it is a directory      (unchanged — a path still works)
otherwise → error naming `yan repo add` or `yan repo link`
```

The error matters more than usual now, because "registered but not linked on this machine" is a new and entirely normal state — it is what every fresh clone of a vault looks like.

---

## 3. The main clone is now yours

This is the one real consequence, and it is worth stating plainly rather than discovering.

**The rule does not change:** `repos/<name>` was read-only except for `git fetch` ([boundaries.md §9.1](../../mvp/td/boundaries.md)), and the registered clone is read-only except for `git fetch` too. Code changes happen in leased worktrees, which is unaffected — the pool keys trees by the clone's absolute path hash ([layout.ts](../../../src/externals/worktree/layout.ts)), so a clone anywhere on disk works exactly as before.

**What does change** is a git constraint that used to be structurally impossible: a branch cannot be checked out in two places at once. If you have `yan/t103-poe-tools-r1` checked out in your own clone and then `yan sync` tries to lease a tree on it, git refuses. Under `repos/` this could not happen, because nobody ever checked anything out there.

So the pool's error for that case stops being a theoretical branch and becomes a message a person will actually read. It has to name the branch, name the directory holding it, and say the fix in one clause: *`yan/t103-poe-tools-r1` is checked out in C:/workspace/project/poe-tools — switch that clone to another branch and retry.* Nothing clever, no auto-detach: the clone is yours and yan does not move you around in it.

The trade is worth it. One clone instead of two, no duplicate fetch, and `yan repo add` in a directory you already have becomes a registration rather than a download.

---

## 4. `yan repo add`

One command, three forms, told apart by looking at the argument. `repo-add` becomes `repo add`, joining `task new` and `unit add` in the noun-verb shape the rest of the CLI already uses.

```
yan repo add                    no argument: scan the current directory
yan repo add ../poe-tools       a directory: register that clone
yan repo add git@github.com:…   a URL: clone into clone_root, then register
yan repo link <name> <path>     only the machine half — no registry change
yan repo ls                     what is registered, and what is linked here
```

### The scan

`yan repo add` with no argument lists the immediate children of the working directory that contain a `.git`, reads each one's `origin`, and offers a multi-select. Picking three registers three.

One level, not recursive. Recursion means walking into `node_modules` and every vendored checkout to find things nobody wants; `cd` to the right parent first costs nothing. A child with no `origin` is shown but disabled with the reason — a repository with no remote cannot be delivered from, and silently skipping it would look like a bug.

Names come from the URL by the rule `repoNameFromUrl` already implements. A collision with an existing entry pointing at a different URL is reported in the selection list, not after the fact.

This is the interactive soft path, so it obeys the existing rule: prompts are for people at a keyboard. Agents pass `--repo`/`--path` flags and never see a select. Non-TTY invocation with no argument is a usage error, not a hang.

### The clone form

`yan repo add <url>` clones into `~/.yan/config.json`'s `clone_root`, then registers. It refuses to clone over an existing directory — the same refusal `repo-add` has today, which exists because "delete and retry" is not a thing a tool should do to a directory it did not create.
