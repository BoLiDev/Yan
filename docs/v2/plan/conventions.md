# V2 implementation conventions

> Replaces [`../../mvp/plan/conventions.md`](../../mvp/plan/conventions.md) once Phase 0 lands. Read it before starting any phase.
> Sections §2.2 (no `flock`) and §2.3 (`jq.exe` CRLF) of the MVP conventions are **retired, not ported** — they described bash-and-`jq` problems that no longer exist. §2.1 (`winpty`) is retired by [evidence §3](../td/evidence.md#3-native-tty-winpty). §2.4 (path normalisation) survives in a reduced form, in §3 below.

---

## 1. The two supported runtimes

| | Git Bash on Windows (MSYS2) | WSL Ubuntu / Linux |
| --- | --- | --- |
| run tests | `npm test` | `wsl -e bash -lc 'cd /mnt/c/workspace/project/Yan && npm test'` |
| build | `npm run build` | same |
| `node` in a non-interactive shell | on `PATH` | needs `. ~/.nvm/nvm.sh` first |
| `herdr` | on `PATH` | **unverified** — see [evidence §9](../td/evidence.md#9-read-from-the-schema-not-exercised) |

Windows is a first-class target, not an afterthought. A change that only works on WSL is not done.

---

## 2. TypeScript style

- **`strict: true`, and no `any`.** Where a value genuinely is unknown — a parsed JSON response — type it `unknown` and narrow it. `any` in a seam is how an outside authority's vocabulary leaks upward, which is the one thing seams exist to prevent.
- **Named exports only.** A default export makes a module's surface unsearchable.
- **Return closed unions, never the outside authority's strings.** `type MrState = 'merged' | 'closed' | 'open' | 'unknown'`. This is [td §4.3 rule 1](../../mvp/td/architecture.md#43-seams) with the compiler enforcing it.
- **Every module names its own error.** `YanError` is an **abstract** base and nothing throws it — a single concrete error would mean every failure in the system arrives under one name, and a name that fits everything describes nothing. Each module declares a subclass in its `errors.ts`: `WorktreeError`, `TerminalError`, `TaskError`. The throw site says what kind of thing failed; `code` says which condition.
- **Codes hang off the class, not on loose constants.** `WorktreeError.codes.mismatch`, not an exported `WORKTREE_MISMATCH`. "What can this module throw" is then answered by one thing a reader already has in hand, and the codes cannot be public in one module and private in another. They keep a module prefix (`worktree_mismatch`) because `code` outlives the class: it is what a test asserts on and what survives a JSON boundary.
- **The base earns its place twice.** `isYanError(e)` is the ours-versus-theirs boundary — a Herdr or `gh` error object must never propagate — and `src/cli/shared/action.ts` needs one `instanceof` to map any of them to an exit code. Those are the only two reasons it exists.
- **The command layer is the one exception.** `CommandError` takes the command as an argument instead of having six subclasses, because nothing catches a command error: it travels a few lines to `action()`, which prints it. Six names carrying no decision are six names too many.
- **No module under `src/` imports another seam.** Enforced by lint, not by discipline ([runtime.md §2](../td/runtime.md#2-layout)).
- **Comments explain why, not what.** The MVP's shell carries unusually good comments — `lib-term.sh`'s four rules, `lib-json.sh`'s CRLF explanation. Port that habit. A comment that restates the code is noise; one that records a decision is the reason the next person does not undo it.
- **No section banners.** `// --- internals ---` above a run of `private` methods, or `// --- paths ---` at the top of `layout.ts`, says only what the modifier or the filename already says. They were worth something in a 567-line shell file with no other navigation; in split files with modifiers they are decoration. If a file needs a banner to be navigable, split it.

---

## 3. Paths and line endings

**Paths.** Node removes most of the MVP's `cygpath` problem but not all of it: on Windows, `git` and `herdr` both report native paths (`C:\…` or `C:/…`) while a path `yan` built may be POSIX (`/c/…`) if it came from a Git Bash environment variable. **Any comparison between a path we built and a path an external tool printed must normalise first.** A single `normalizePath()` in `src/util/` owns this; nothing else compares paths.

Herdr accepts native paths for `--cwd` and returns them with backslashes. Normalise on the way in and out of the seam, once.

**What `normalizePath()` does not do.** It reconciles drive-letter spellings (`C:\x` / `C:/x` / `/c/x`). It does **not** resolve MSYS mount points — Git Bash's `/tmp` is `C:\Users\<user>\AppData\Local\Temp`, and no amount of string normalisation will discover that. Where a real mount translation is needed, shell out to `cygpath -m` on Windows and use identity on Linux, exactly as the MVP did. Say which one you need; they are not the same function.

**Line endings.** `.gitattributes` keeps `* text=auto eol=lf` and `*.sh text eol=lf` — the three remaining shell stubs still fail with `bad interpreter` if they arrive as CRLF. TypeScript sources are LF for the same reason everything else is.

---

## 4. Locking

`lib-lock.sh` used `mkdir` because Git Bash has no `flock` and `noclobber` is not reliably atomic on MSYS2 filesystems. In Node the primitive is `fs.open(path, 'wx')` — atomic exclusive create on both platforms — plus `fs.rename` for atomic replace. **Do not port the `mkdir` scheme and do not invent a second one.**

**There are two locks, and there must never be a third without its reason written down.**

1. `yan wait`'s single-flight ([supervision.md §4](../td/supervision.md#4-what-survives-from-the-mvp)) — under Claude every Stop can fire autoarm, and without it several watchers start.
2. The worktree pool's, per clone. This one is not the obvious kind: exclusive create already serialises slot allocation, but `git worktree add` writes the *shared* clone's `.git/config`, and two of them collide on git's own config lock. The reasoning is in `externals/worktree/worktree.ts`, at length, because it is the sort of thing someone deletes on a tidy-up.

---

## 5. Tests

```
tests/
  unit/            fast, seams replaced by fakes
  integration/     real git, real file system, no network, no Herdr
  e2e/             real Herdr, real forge; skipped when the binary is absent
  fixtures/        unchanged — the forge JSON fixtures are ported as-is
```

- **Each test owns its temporary directory** and never touches the checkout's `$YAN_HOME`. The MVP's `mk_yan_home` helper is ported.
- **Fixtures pass git identity explicitly** (`-c user.name=… -c user.email=…`) so they work where no global git config exists.
- **Seams are swapped by import, not by `YAN_LIB`.** No environment-variable indirection and no injection framework.
- **An e2e test that needs Herdr skips loudly when Herdr is missing** — it never silently passes.
- **Never assert on a Herdr message string.** Assert on `error.code`. Messages are a preview build's prose.

### The tests that must never go red

Four ordering regressions ([td §7](../../mvp/td/architecture.md#7-testability)), because each guards something that does not fail loudly — it just quietly stops working:

1. after `pool_return`, gitignored directories are still there
2. `shift done` returns the tree before deleting the branch
3. `shift new`'s working-directory assertion really refuses
4. `sync` really exits on a conflict

To which V2 adds two:

5. `yan` never calls `agent focus` on a shift's pane ([supervision.md §3](../td/supervision.md#3-what-the-events-mean-to-yan))
6. the terminal seam contains no call that can close a workspace, tab, or pane `yan` did not create

---

## 6. Working with Herdr from a test or a script

Which Herdr resource is authoritative for what — and how to re-verify after an upgrade — is [`../td/sources.md`](../td/sources.md). Read it before asserting any Herdr behaviour.

- **Never `herdr server stop`.** It stops the user's whole session and every process in it.
- **Never run bare `herdr`** — it launches or attaches the TUI and will hang a non-interactive caller. Discovery is `herdr <group> --help`.
- **Only close what you created.** This applies to `yan`, to tests, and to whoever is debugging.
- **Experiments that need isolation use a named session** (`herdr --session <name>`), never the default one.
- **Mutating commands succeed silently** — rc 0, empty stdout. Do not treat empty output as failure ([evidence §4](../td/evidence.md#4-display-metadata)).
- **During the migration, do not `tmux attach` from inside a Herdr pane.** Herdr's screen detection misreads an agent running inside a nested tmux ([`/docs/agents/`](https://herdr.dev/docs/agents/)). This is a habit, not a code path — tmux-backed shifts run in a *detached* session that Herdr never sees — but it is reachable while both backends exist, and it stops being possible after Phase 9.
- **Do not assume an installed integration means authoritative state.** For Claude Code and Codex it does not: their v7 integrations report session identity only, so `agent_status` is a screen match either way ([sources.md §4.1](../td/sources.md#41-detection-has-two-mechanisms-and-yans-agents-get-the-weaker-one)). Install them anyway — that is the configuration `yan` runs in — but never write a test or a doc that treats `blocked` as a guaranteed signal.

---

## 7. Working agreement

Implementation conventions above are Phase 0's output; the phases themselves are [`INDEX.md`](INDEX.md).

| Do | Don't |
| --- | --- |
| Name the phase number in the MR summary | Implement "the rest of the port" unprompted |
| Port a module's tests in the same commit as the module | Port a module and change its behaviour together |
| Leave the bash version in place until its last caller is gone | Delete a bash file because its TypeScript twin exists |
| Assert on `error.code` | Assert on a Herdr or `gh` message string |
| Raise it when a phase's scope is wrong | Widen `scope` quietly to make a phase fit |
