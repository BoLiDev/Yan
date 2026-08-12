# Migration

> One machine, one existing `$YAN_HOME`, five tasks and one registered repository. This document says how that becomes mechanics plus a vault, and why the migration is a command rather than a wiki page.

---

## 1. Why it is a command

`yan vault init --from-home` exists for one reason beyond convenience: **it is the test.** V3's whole claim is that the three layers separate cleanly, and a migration that has to move real tasks, a real registry, a real config and a real clone out of a real home is the only honest way to find out. A checklist in a document proves nothing and cannot be re-run.

It is also the last thing that will ever read the old layout, so it is allowed to know about `$YAN_HOME/tasks` — and it is the only thing that is.

---

## 2. What moves where

The state on this machine today, and its destination:

| Today | Goes to | Note |
| --- | --- | --- |
| `tasks/t099 … t103` (5 tasks, 1 with artifacts) | `<vault>/tasks/` | moved, not copied |
| `mem/repos.json` (`poe-tools`) | split: `url`/`mode_default`/`pool_size` → `<vault>/repos.json`, `path` → `<vault>/.local/repos.json` | the path is the *new* location, from the row below |
| `conf/config.json` | `<vault>/config.json` | `remote_git.kind: github` — the personal context, correctly |
| `conf/hooks/` | `<vault>/hooks/` | absent here; the code path still moves it if present |
| `repos/poe-tools/` (a clone) | `clone_root/poe-tools` — i.e. `C:/workspace/project/poe-tools` | see §3 |
| `~/.yan-trees/*` | stays | the pool is machine state and already lives outside the home |

`conf/config.sample.json`, `conf/hooks.sample/` and `templates/vault/` stay in the mechanics. They are templates, not choices.

Defaults for this machine: vault name `personal`, path `C:/workspace/yan-vault-personal`, `clone_root` `C:/workspace/project` — the mechanics clone's own parent, so registered clones end up as siblings of `yan` rather than hidden inside it.

---

## 3. The clone, which is the only interesting part

Everything else is a directory move. `repos/poe-tools` is not, because the pool has a directory keyed to its current path — `~/.yan-trees/poe-tools-9cf76e02`, where the suffix is a hash of the absolute path ([layout.ts](../../../src/externals/worktree/layout.ts)). Move the clone and that pool directory is orphaned: leases inside it point at trees whose parent clone is gone, and the same repository at its new path gets a fresh, empty pool.

Three ways out, and the third is the one we take:

1. Rewrite the hash. No — the hash is derived on purpose; a migration that rewrites derived state is how you end up with two answers.
2. Move the pool directory too, renaming it to the new hash. Tempting, and wrong for the same reason plus one more: the leases inside record absolute tree paths that would also need rewriting.
3. **Require the pool to be empty for that clone, then let it rebuild.** A tree is a scratch checkout; the pool exists to be thrown away and re-leased. `--from-home` refuses if any lease exists for a clone it is about to move, naming the tree, and the fix is `yan tree return`.

There are no leases on this machine right now, so the refusal will not fire — which is the good case, not a reason to skip the check. The orphaned `monorepo-x-*` pool directories are test residue and the migration ignores them; the pool reclaims a directory whose trees are gone on its own.

If the clone already exists at the destination, the migration registers it and leaves `repos/<name>` alone rather than merging two clones. That is a refusal-shaped outcome with a clear message, not a silent choice.

---

## 4. The order

Every step is resumable, because the failure that matters is "it died halfway" and the answer to that must not be "restore from a backup you did not take".

1. **Preflight, all of it, before anything moves.** Destination is free; remote is reachable and empty; no leases on clones being moved; no live shift (`run/meta.json` present anywhere under `tasks/*/shifts/`).
2. Create the vault skeleton from the template and `git init` it.
3. Copy `tasks/`, `mem/`, `config.json`, `hooks/` in. **Copy, not move** — the old home keeps its data until step 7.
4. Write the split registry, both halves.
5. Move the clone; write `.local/repos.json`.
6. Commit, add the remote, push. Register in `~/.yan/config.json`, set active.
7. **Verify, then clean.** `yan ls` must show the same five tasks, and `yan doctor` must come back clean, before the old `tasks/`, `mem/`, `conf/config.json` and `repos/` are removed. A `--keep-home` flag skips the removal for the first run, which is what we will actually use.

Step 7 is the whole safety story: until it runs, the migration is additive and reversible by deleting the vault.

---

## 5. What the mechanics repository looks like afterwards

`tasks/`, `mem/`, `repos/` and `conf/config.json` are gone from the tree, and with them the eleven-line explanation in `.gitignore` about why runtime data lives beside the code. What is left is:

```
node_modules/
dist/
*.log
.DS_Store
.claude/worktrees/
```

`tasks/.gitkeep`, `mem/.gitkeep`, `repos/.gitkeep` and `conf/.gitkeep` are deleted — they existed to keep gitignored directories present, and there are no gitignored data directories any more.

`npm run setup` gains a final step: if no vault is registered, tell the user the one command to run next. It does not create one — [that is a decision](cli.md#5-authority), and a bootstrap script guessing which forge you deliver to is exactly the guess V3 exists to stop.
