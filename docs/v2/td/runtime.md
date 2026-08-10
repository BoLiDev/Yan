# Runtime: TypeScript and Commander

> [`INDEX.md`](INDEX.md) says why the language changes. This document says what the code looks like afterwards: the layout, the boundaries, the CLI framework, the build, and the tests.
> The MVP's [`architecture.md`](../../mvp/td/architecture.md) still defines *what may call what*. V2 keeps that graph and changes only the material it is built from.

---

## 1. The line between TypeScript and shell

**TypeScript is the default. Shell is the exception, and the exception list is in [INDEX §3](INDEX.md#3-what-is-genuinely-still-shell).**

The tempting wrong line is "TS for logic, shell for the parts that call external tools". That line is wrong because calling an external tool is the thing Node does *better*: `spawn` takes an argv array, so there is no word-splitting, no quoting, and no `_term_quote_cmd`. Every place the MVP wrestled with quoting is a place TypeScript removes the wrestling.

The right line is **who decides**. If `yan` decides it — how to split, what is in scope, whether an MR merged, which state a shift is in — it is TypeScript. If the artefact must *be* a file that something else execs, it is shell, and it should be thin enough to read in one glance.

---

## 2. Layout

`$YAN_HOME` is still this clone ([td §3](../../mvp/td/architecture.md#3-repository-layout)). The three-prefix rule in `bin/` is replaced by a directory-per-layer rule, which says the same thing with less naming discipline required.

```
$YAN_HOME/
  AGENTS.md · CLAUDE.md       judgements the model reads (unchanged)
  src/
    cli/
      yan.ts                  Commander root: the program, global options, dispatch
      <command>.ts            one file per subcommand, declaring its own options
    seams/
      terminal/               the Herdr seam (terminal.md)
        index.ts              the seven functions — the only public surface
        client.ts             socket/CLI transport, error mapping
        types.ts              GENERATED from `herdr api schema --json`
      forge/                  GitHub / GitLab behind four verbs
      pool/                   the worktree pool
      hook/                   conf/hooks/ calling protocol
    store/
      task.ts                 task.json
      log.ts                  log.md (append only)
    util/
      json.ts                 atomic write + version field
      git.ts                  run git in a given directory
    ui/
      prompts.ts              @clack/prompts wrappers (soft path only)
  bin/
    yan                       shell stub: exec node dist/yan.js "$@"
    hook-autoarm.sh           shell stub: exec node dist/hook-autoarm.js "$@"
    hook-turnend-guard.sh     shell stub
  dist/                       build output, gitignored
  tests/                      vitest, mirroring src/
  conf/  mem/  tasks/  repos/  docs/          unchanged
```

The dependency graph from [td §2](../../mvp/td/architecture.md#2-what-may-call-what) is unchanged and is now enforceable rather than merely documented: a lint rule forbids `src/seams/*` importing from another `src/seams/*`, and forbids anything under `src/` importing `src/ui/` except `src/cli/`.

**One rule survives verbatim and matters more than before: the model never imports a module; it can only run `yan <cmd>`.** TypeScript makes it easy to expose an inviting API. Do not. `src/` is not a library.

---

## 3. Commander

One `Command` per subcommand file, composed by `src/cli/yan.ts`. What this buys, concretely:

- **20 hand-written flag parsers collapse to declarations.** Every `bin/yan-*.sh` currently opens with its own `while [ $# -gt 0 ]; case $1 in` block.
- **`yan shift new` and `yan shift-new` stop being a filename trick.** `bin/yan:68` currently reaches the same file by rewriting a space into a hyphen. Under Commander, `shift` is a command with `new` and `done` as subcommands, which is what it always meant.
- **`yan --help` is generated.** `AGENTS.md` tells the model to read it; it should not be a hand-maintained `printf` list that can drift from the real flags.

### The one place Commander fights this design

Commander's default reaction to a missing required option is to print an error and exit. The soft path needs to intercept *before* that and ask Clack instead ([cli-ux.md](cli-ux.md)).

**Therefore: no option is ever declared `.requiredOption()`.** Every option is optional to Commander; the action handler validates. A shared helper decides what happens next:

```
resolve(values, spec) →
  all present                → hard path, run
  missing and stdin is a TTY → prompt for the missing ones, then run
  missing and not a TTY      → exit non-zero, listing the flags to pass
```

That is exactly the soft/hard rule from [cli-ux §1](../../mvp/td/cli-ux.md#1-why-prompts-exist), expressed once instead of per command. `lib-ui.sh`'s TTY gate becomes this function.

---

## 4. Types come from the outside authorities

Two of the three seams can have their types generated rather than hand-written, and both should be:

| Seam | Source of truth | How |
| --- | --- | --- |
| terminal | `herdr api schema --json` — 261 KB, `protocol: 19`, `schema_version: 1` | generated into `src/seams/terminal/types.ts` at build time; committed so a build never needs Herdr installed |
| forge | `gh` / `glab` JSON responses | **not** generated. Kept hand-written and narrow, because the whole point of that seam is that callers never see the forge's vocabulary ([td §8.4](../../mvp/td/delivery.md#84-the-forge-layer)) |

Generating the Herdr types is what makes a Herdr version bump a compile error instead of a runtime surprise. The generator records the `protocol` and `schema_version` it ran against, and `yan doctor` compares them with the installed binary.

This is not caution for its own sake: Herdr ships on a preview channel and its documentation makes **no** API stability promise ([sources.md §5](sources.md#5-smaller-facts-worth-keeping)). The schema is the contract that exists, so it is the one the build is pinned to. `yan doctor` also reports `herdr integration status` for the kinds named in `conf/config.json` — as a version and session-id check, **not** as evidence that state detection is authoritative ([terminal.md §6](terminal.md#how-reliable-this-is)).

---

## 5. Build and start-up

`bin/yan` is a shell stub so that `$PATH` behaviour, `#!/usr/bin/env bash`, and the existing hook registrations keep working untouched. It execs compiled JavaScript in `dist/`, not `tsx` — hooks run on every Stop and a type-stripping loader on that path is a cost paid hundreds of times a day for no benefit.

The two universal hard dependencies checked inline in `bin/yan` change: `git` stays, **`jq` is dropped**, `node` is added. `herdr` and the forge CLI remain `yan doctor`'s business.

---

## 6. Tests

The MVP has 58 test scripts and 9,196 lines of bash test code, and they are the most valuable thing in the repository — several of the bug classes they now cover were only exposed by a live run, not by a green suite. They are not to be thrown away; they are to be **ported one at a time, alongside the module they cover**, so that every port is checked by the test that already caught the real bug.

| MVP | V2 |
| --- | --- |
| `tests/run.sh` + hand-rolled `tests/assert.sh` | vitest |
| `tests/stub/lib-*.sh` swapped in via `YAN_LIB` | seam modules swapped by import, no environment variable trick |
| `tests/unit` / `integration` / `e2e` | same three tiers, same names |

The four ordering regressions called out in [td §7](../../mvp/td/architecture.md#7-testability) — gitignored directories surviving `pool_return`, `shift done` returning the tree before deleting the branch, `shift new` refusing a main-clone cwd, `sync` exiting on conflict — are ported first and never allowed to go red, because none of them fails loudly.

**The seam contract test is the migration's safety rail.** `tests/unit/lib-term-contract.test.sh` pins what the seven functions must do. It is ported in Phase 4 alongside the Herdr seam, and the Herdr implementation must pass the *same* assertions the tmux one passes before tmux is removed in Phase 9 ([`../plan/INDEX.md`](../plan/INDEX.md)).
