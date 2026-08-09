# Implementation conventions

> For the Phase 1–9 agents. Phase 0 established these; every later phase follows them so that parallel phases merge without conflict. Design rationale stays in [`../td/`](../td/INDEX.md); this file is only *how we write it*.

## 1. Two supported runtimes

`yan` runs identically on both. A change is not done until it is green on both.

| | Git Bash on Windows (MSYS2) | WSL Ubuntu / Linux |
| --- | --- | --- |
| run tests | `cd /c/workspace/project/Yan && tests/run.sh` | `wsl -e bash -lc 'cd /mnt/c/workspace/project/Yan && tests/run.sh'` |
| `flock` | **absent** | present |
| `winpty` | **present and required** | n/a |
| node / claude in a non-interactive shell | on `PATH` | need `. ~/.nvm/nvm.sh` first |

Append `2>&1 \| tr -d "\0"` to WSL invocations — WSL emits NUL bytes that garble captured output.

`tests/run.sh` prints the runtime it detected on its first line. Quote that line when reporting results.

## 2. Three portability constraints

**2.1 `winpty` — read this before writing Phase 3.** A native Windows console program (`claude.exe`, `codex.exe`, `gh.exe`) started inside an MSYS2 tmux pane is handed a pipe, not a console. It sees no TTY, decides it is non-interactive, prints nothing useful, and exits. It must be launched as `winpty <cmd> …`. On Linux there is no `winpty` and none is needed. `lib-term`'s spawn path therefore has to branch on the platform (`boot_platform` in `bin/lib-boot.sh` returns `windows` or `linux`). `yan doctor` already fails when `winpty` is missing on Windows.

**2.2 No `flock`.** Git Bash has none, and `noclobber` redirection is not reliably atomic on the filesystems MSYS2 exposes. `mkdir` is the atomic primitive on both platforms. All locking goes through `bin/lib-lock.sh` (`lock_acquire`, `lock_release`, `lock_is_held`, `lock_is_stale`, `with_lock`). Do not invent a second scheme.

**2.3 Native vs POSIX paths.** On Git Bash the shell says `/tmp/x` and `git.exe` says `C:/Users/…/Temp/x` for the same file. Any comparison between a path *we* built and a path a *native tool printed* must normalise first (`cygpath -m`, identity on Linux). Tests have `native_path` in `tests/assert.sh`. Phase 2 needs this when matching `git worktree list --porcelain` output against pool paths.

## 3. Line endings and file modes

- **LF only.** `.gitattributes` sets `* text=auto eol=lf` and `*.sh text eol=lf`. A CRLF `#!/usr/bin/env bash` fails with a confusing `bad interpreter` error.
- `core.filemode=false` on this checkout, so `chmod +x` is not recorded. To make a file executable **in the index**: `git add --chmod=+x <path>`, then verify `git ls-files -s <path>` shows mode `100755`.
- Executable: `bin/yan`, `bin/yan-*.sh`, `tests/run.sh`, `tests/**/*.test.sh`. Not executable: `bin/lib-*.sh`, `tests/assert.sh`, `tests/fixtures.sh`, `tests/stub/*` — they are sourced, never run.

## 4. Shell style

- Every executable script starts `#!/usr/bin/env bash` then `set -euo pipefail`. Sourced libraries start `# shellcheck shell=bash` instead, and never set shell options.
- **Libraries are double-source safe:** guard with `if [ -n "${_YAN_LIB_<NAME>_SOURCED:-}" ]; then return 0; fi`.
- **Sourcing convention — always exactly this form:**
  ```sh
  . "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"
  ```
  A test swaps a seam by setting `YAN_LIB=tests/stub`. No injection framework. `tests/unit/lib-swap.test.sh` fails if any `.` line under `bin/` deviates.
- **Error messages:** `printf '<module>: <what went wrong> - <what to do>\n' >&2`, lower case, no stack traces. Exit `2` for "you called this wrongly" (bad arguments), `1` for "it did not work". Never `echo` a variable that may start with `-`.
- **shellcheck clean at `--severity=warning`.** `tests/run.sh --lint` runs it with `-x -P <repo root>`, so a `. "$TDIR/assert.sh"` line needs the directive `# shellcheck source=tests/assert.sh` above it (path relative to the repo root). A `# shellcheck disable=SCxxxx` needs a one-line reason comment beside it.

## 5. Discovery, never registries

Two places deliberately have no list, because phases land in parallel and a shared list is a guaranteed merge conflict — and because deriving beats storing (design principle 1):

- **`bin/yan` dispatch** globs the filesystem. `yan foo bar` tries `bin/yan-foo-bar.sh`, then falls back to `bin/yan-foo.sh` with `bar` as an argument. Adding a subcommand means adding a file, and the help list picks it up. **Do not add a `case` list to `bin/yan`.**
- **`tests/run.sh`** globs `tests/<suite>/*.test.sh`. Adding a test means adding a file.

## 6. Tests

```
tests/run.sh                 --fast (unit) | no flag (unit+integration+lint) | --e2e | --filter <s> | --lint
     assert.sh               assert_eq/ne/contains/not_contains/ok/fail/file_exists/file_missing/exit_code,
                             plus capture (sets $out/$rc) and native_path
     fixtures.sh             mk_bare_remote, mk_clone, mk_commit, mk_yan_home, mk_config, fx_git
     stub/                   stand-ins selected by YAN_LIB
     unit/*.test.sh          no tmux, no network, no forge — must pass in any container
     integration/*.test.sh   real git against local bare remotes, real tmux
     e2e/*.test.sh           real forge / real agent CLI — opt-in via --e2e only
```

Each test is a standalone executable bash script: source `tests/assert.sh`, take its own `tmp=$(mktemp -d)`, clean up with `trap 'rm -rf "$tmp"' EXIT`, and never touch `$YAN_HOME` of the checkout — use `mk_yan_home "$tmp/home"`. The runner clears `YAN_HOME` and `YAN_LIB` before each file, so a test that needs them sets them itself. Fixtures pass identity with `git -c user.name=… -c user.email=…`, so they work where no global git config exists.

Add the Trace-bullet tests for your phase in the same PR as the code.

## 7. Layering reminders

- Dependency edges point downwards only, and **seams never call each other** (`architecture.md` §2).
- `lib-git.sh` takes an explicit directory as its first argument in every function and never relies on `$PWD`. It never passes `--force` / `-f`, and `git clean` is `-fd`, never `-x` — the pool's warm-reuse contract depends on it. A unit test greps `bin/` for those spellings.
- Seams return values from a closed set defined by `yan`, never the outside tool's own words.
- JSON is written only through `lib-json.sh` (`json_write` / `json_edit` / `json_init`): temp file in the target's own directory, validate, then `mv`. Every JSON file carries `version`.
- `backend: herdr` fails closed with "not implemented in the MVP" everywhere it is read.
