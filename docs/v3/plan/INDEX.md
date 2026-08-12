# V3 implementation plan

> Design lives in [`../td/`](../td/INDEX.md). This folder is the delivery cut: what we build first, in which order, and how each slice stays reviewable.

---

## 1. Scope of this cut

**Goal:** the same yan, with its data in a vault repository it can push, its clones registered rather than duplicated, and a code repository that holds no private data.

| In V3 | Out (deferred) |
| --- | --- |
| the three layers, and the path helpers that resolve them | a `--vault` flag on every command; one active vault, switched explicitly |
| `yan vault init / clone / ls / use / pull / push` | conflict tooling beyond `pull --rebase` |
| `repos.json` split in two; `yan repo add / link / ls` with the interactive scan | a vault schema migration tool — `vault.json` carries a version, that is enough until it is not |
| `--from-home`, run for real on this machine | automatic push, and any auto-commit |
| the mechanics tree emptied of runtime data | a published mechanics repository — this only makes it *possible* |

**Product sentence:** *the same task, in a context you can carry between machines and cannot mix up with the other one.*

---

## 2. Why this is not a strangler

V2 could migrate one command at a time because the interop boundary was the file system and both halves read it equally well. V3 moves the file system, so there is no such boundary: a half-migrated tree has `tasks/` in two places, and the second answer is precisely the bug.

The sequencing that replaces it is **additive until step 7 of the migration**. Phases 1–2 add helpers and commands while every existing command still resolves against `$YAN_HOME`; nothing observable changes. Phase 3 flips the resolution and moves the data in one commit, with the old copy still on disk. Phase 4 cleans up. The dangerous moment is one phase long and it is reversible by deleting a directory.

---

## 3. How phases are reviewed

Each phase is one shift, one merge request, one sitting.

1. A phase is done when its Trace bullets pass.
2. Tests come with the code they cover. The existing suite isolates `$YAN_HOME`; the new layers get the same treatment via `$YAN_VAULT` and `$YAN_MACHINE_DIR`, and **a test that reads the real `~/.yan` is a bug in the test**.
3. Phase 3 is a gate. Nothing is deleted from the mechanics tree until `yan ls` and `yan doctor` are green against the migrated vault.
4. No behaviour change rides along with a path change. Move the root, prove green, then change what the command does.

---

## 4. Phases

### Phase 1 — the three roots

`util/vault.ts` and `util/machine.ts`; `yan vault init / clone / ls / use`; `templates/vault/`.

Existing commands are untouched and still resolve against `$YAN_HOME` — this phase only makes a vault creatable.

*Trace:* `yan vault init personal --remote <url>` produces a pushed repository with the [§2 layout](../td/vault.md#2-layout) · `yan vault ls` shows it active · `$YAN_VAULT` overrides, and an invalid one is ignored the way an invalid `$YAN_HOME` is · `vaultDir()` throws the init instruction when nothing is registered · `doctor` gains the vault rows.

### Phase 2 — the registry, split

`repo-add` → `repo add | link | ls`, the two-file registry, the interactive scan, and `repoDir()` reading `.local/repos.json` **with the `$YAN_HOME/repos/<name>` lookup still in place as a fallback**.

That fallback is what keeps this phase additive: the existing `poe-tools` entry keeps working from `repos/` while the new path resolution is proven. Phase 3 removes it.

*Trace:* `yan repo add` with no argument scans one level, disables remote-less children with a reason, registers a multi-select · a path argument registers without cloning · a URL argument clones into `clone_root` · `yan repo ls` distinguishes registered from linked · non-TTY with no argument is a usage error, not a hang · the pool's "branch already checked out" error names the branch, the directory and the fix.

### Phase 3 — the flip, and the migration

Every `join(yanHome(), 'tasks'|'mem'|'conf')` becomes `vaultDir()`; the `repos/` fallback goes; `yan vault init --from-home` lands and **is run for real on this machine**.

*Trace:* preflight refuses on a live shift, on a lease against a clone being moved, on a non-empty destination · the five tasks appear under `yan ls` from the vault · `poe-tools` resolves at `C:/workspace/project/poe-tools` and a fresh `yan tree get` works against it · `--keep-home` leaves the old copy · `yan doctor` clean.

### Phase 4 — sync, and the emptied tree

`yan vault pull / push`; `session-start` pulls and prints the vault; the bare-`yan` header; `.gitignore` shrunk; the `.gitkeep` files and the old data directories removed; `npm run setup` points at `yan vault init`; `AGENTS.md`, `CLAUDE.md` and `README.md` updated — including the new authority row.

*Trace:* a failing pull degrades to a warning and the session still starts · `push` with no `-m` generates a message from what changed · `git status` in the mechanics clone is clean after a task runs end to end · `AGENTS.md` and `CLAUDE.md` name `yan repo add` and the vault commands, and no document still says `repo-add`.

---

## 5. Units

One repository, so **one unit**, and the phases are its shifts in order — each `needs` the one before it. Phase 3 is the only one that touches data on this machine, and it is the only one where `user` is asked to watch it run.
