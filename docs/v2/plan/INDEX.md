# V2 implementation plan

> Design lives in [`../td/`](../td/INDEX.md). This folder is the delivery cut: what we build first, in which order, and how each slice stays reviewable.

---

## 1. Scope of this cut

**Goal:** the same end-to-end path the MVP proved — create a task, dispatch a shift into a leased worktree, get woken, clock out, open the outbound MR — running on **TypeScript** and **Herdr**, with tmux and bash removed.

| In V2 | Out of V2 (deferred) |
| --- | --- |
| `bin/` ported to TypeScript under `src/`, Commander for the CLI | rewriting `AGENTS.md` / `CLAUDE.md` judgements — they are about `yan <cmd>` and stay as they are |
| Herdr as the only terminal backend; tmux deleted once green | `--remote` Herdr sessions; multi-machine `yan` |
| Supervision rebuilt on Herdr lifecycle states and events | a fourth wake source that polls CI (still deliberately absent) |
| Bare `yan` → select; `attach` removed from the vocabulary | a `yan` dashboard — Herdr already has one ([display.md](../td/display.md)) |
| `yan` keeps the worktree pool; Herdr gets display metadata | `herdr worktree *` as the pool |
| Generated Herdr types + a `yan doctor` protocol check | generated forge types |

**Product sentence for this cut:** *the same task, the same guarantees, in a language the maintainer can maintain, inside the tool the user already lives in.*

---

## 2. Why this can be a strangler and not a rewrite

**`yan` holds no in-memory state.** Every subcommand rebuilds from `task.json`, `run/meta.json`, `log.md`, git, and the forge ([design principle 1](../../mvp/td/INDEX.md#0-what-yan-is)). That was written as a resilience property. It is also, unexpectedly, what makes a per-command port safe: **the interop boundary between the bash half and the TypeScript half is the file system**, and both read it equally well.

So `bin/yan` becomes a dispatcher that prefers a compiled subcommand and falls back to the shell one:

```
yan <cmd>  →  dist/cli/<cmd>.js   if it exists
           →  bin/yan-<cmd>.sh    otherwise
```

One command moves at a time. A half-migrated tree is fully working. There is never a flag day.

The cost is that some libraries exist in both languages for a while — `lib-task.sh` and `store/task.ts` both reading `task.json`. That is real and it is bounded: the duplicate dies the moment its last bash caller is ported. **Duplication is allowed; divergence is not.** If a ported module needs a behaviour change, change it in one place and port the caller in the same phase.

---

## 3. How phases are reviewed

Each phase is **one reviewable unit** — one merge request, one shift, one sitting for `user`.

1. **A phase is done when its Trace bullets pass**, not when the next phase compiles.
2. **Ported tests come with the module they cover.** A phase that moves code without moving its tests is not done. The 58 MVP test scripts are the migration's only real safety net.
3. **Never port a module and change its behaviour in the same commit.** Port, prove green, then change. This is the rule most likely to be broken and the most expensive when it is.
4. **Nothing from [td INDEX §2 "what gets deleted"](../td/INDEX.md#2-what-gets-deleted) is deleted speculatively.** Each deletion is a Trace bullet in the phase that earns it.
5. **Phase 5 is a gate.** No supervision code is deleted before it passes.
6. **A ported command takes its bash twin with it.** When `yan <cmd>` is green in TypeScript, `bin/yan-<cmd>.sh` and its `tests/**/yan-<cmd>.test.sh` go in the same commit.

Rule 6 is not an exception to rule 4. Rule 4 guards the list in [td INDEX §2](../td/INDEX.md#2-what-gets-deleted), where each entry names the phase that earns it. This is narrower: a command whose replacement is proven has no job left, and keeping it means every later phase spends minutes testing code production does not run. Two things are explicitly not covered by it — the **tmux terminal implementation**, which is the reference the Herdr contract is compared against until Phase 9, and any `lib-*.sh` still sourced by a command that has not moved.

The cost, stated rather than discovered: that command loses its dual-dispatch fallback. It is the right trade. `npm test` builds first, the fallback existed so a half-migrated tree stayed usable, and now that the foundation is all in place a loud "no such command" beats a silent fall back to an implementation that stopped being maintained three phases ago.

---

## 4. Phase map

```mermaid
flowchart LR
  P0[0_TS_skeleton]
  P1[1_Storage]
  P2[2_Forge]
  P3[3_Pool]
  P4[4_Terminal_herdr]
  P5[5_Event_spike]
  P6[6_Supervision]
  P7[7_Orchestrators]
  P8[8_New_entry]
  P9[9_Retire_tmux]

  P0 --> P1
  P0 --> P2
  P0 --> P3
  P0 --> P4
  P4 --> P5
  P5 --> P6
  P1 --> P7
  P2 --> P7
  P3 --> P7
  P4 --> P7
  P6 --> P7
  P7 --> P8
  P8 --> P85[8.5_Codex]
  P85 --> P9
```

Phases **1 / 2 / 3 / 4** are independent after 0 and can run in parallel — they are four different seams with no edges between them ([td §4.3](../../mvp/td/architecture.md#43-seams)). Phase 5 is a spike whose result can change Phase 6's design.

| Phase | Name | Review focus |
| --- | --- | --- |
| 0 | TS skeleton & dual dispatch | build, Commander root, utilities, vitest, no behaviour change |
| 1 | Storage & read-only commands | `task.json` / `log.md` in TS; bash and TS agree on disk |
| 2 | Forge seam | 861 lines of JSON mapping, closed return sets, existing fixtures |
| 3 | Pool seam | leases, warm reuse, the orphan guard |
| 4 | Terminal seam on Herdr | the seven functions, generated types, the two-step alive derivation |
| 5 | Event spike (gate) | does `events.subscribe` hold up |
| 6 | Supervision | a socket client, `yan wait` on two sources, reconnect; only the pane hash is deleted |
| 7 | Orchestrators | `shift new/done`, `sync`, `unit`, `session-start`, display metadata |
| 8 | New entry | bare `yan` select, Clack in `src/ui`, `attach` removed |
| 8.5 | Codex | repair the binding, measure the gates, and decide the one that needs deciding |
| 9 | Retire tmux & bash | delete the tmux seam and every remaining `bin/*.sh` but three stubs |

---

## 5. Phases

> **Phases 0–6 have landed, and the module names moved afterwards.** The entries below are the specs those phases were built to, left as written. The paths in them — `src/seams/forge`, `src/seams/pool`, `src/store` — are the old ones. The tree today is `src/externals/{herdr,remote-git,worktree}` and `src/records/{task,shift,log,supervision}`, each a directory with one `index.ts` that is its whole public surface, plus `src/hooks/` for the two Stop hooks the harnesses run.

> Phase 6 briefly gave the event socket a module of its own, `externals/terminal-events`. It was folded into `externals/herdr` straight afterwards: two transports are not two authorities, and keeping them apart meant writing the pane-id shape and the agent-status union twice, with a test whose only job was to police the copies.

### Phase 0 — TS skeleton & dual dispatch

**Delivers:** `tsconfig`, build to `dist/`, vitest, `src/cli/yan.ts` (Commander root, `--help`, `--version`), `src/util/json.ts`, `src/util/git.ts`, the `resolve()` soft/hard helper, `bin/yan` rewritten as the dual dispatcher, the seam-import lint rule.

**Does not deliver:** any subcommand ported.

**Trace**
- Every existing `yan <cmd>` still works, unchanged, through the fallback
- `yan --help` is generated by Commander and lists the same commands
- JSON writes still go `tmp → mv` and every file still carries `version`; `lib-json`'s tests pass against `util/json.ts`
- `util/git.ts` refuses to run without an explicit directory and never uses `--force`
- The lint rule fails a build where one `src/seams/*` imports another
- `jq` is gone from `bin/yan`'s inline dependency check; `node` is there

**td:** [runtime.md §2–3, §5](../td/runtime.md)

---

### Phase 1 — Storage & read-only commands

**Delivers:** `src/store/task.ts`, `src/store/log.ts`; `yan ls`, `yan open`, `yan repo-add`, `yan scope-check`, `yan drain` in TypeScript.

**Trace**
- `history[]` stays append-only; the four current scalars stay separate from it
- `log.ts` cannot rewrite an existing line through its API
- **Interop:** a bash `yan shift new` followed by a TS `yan ls` shows the shift correctly, and the reverse holds
- `yan ls --json` output is byte-identical to the bash version for a fixture task
- `scope-check` reports and never blocks

**td:** [runtime.md §2](../td/runtime.md), [td memory](../../mvp/td/memory.md)

---

### Phase 2 — Forge seam

**Delivers:** `src/seams/forge/` with the four verbs, GitHub and GitLab.

**Trace**
- Callers see only forge vocabulary; no `gh` / `glab` flags leak upward
- `forge_mr_state` ∈ `{merged, closed, open, unknown}`; `forge_ci_state` ∈ `{green, red, pending, none}`
- Every fixture under `tests/fixtures/forge/` replays to the same verdict as the bash implementation
- Whether an MR merged comes from the forge, never from git ancestry
- Bootstrap checks only the CLI named by `forge.kind`

**td:** [td §8.4](../../mvp/td/delivery.md#84-the-forge-layer)

---

### Phase 3 — Pool seam

**Delivers:** `src/seams/pool/`, `yan tree get|return|status`.

**Trace**
- `return` uses `reset --hard` + `clean -fd` and **never** `-x`; gitignored directories survive a round trip
- The orphan-commit guard refuses to return a tree holding uncommitted or unpushed work
- A full pool is backpressure, not silent growth
- Conditional return refuses a mismatched `--if-lease-id` / `--if-lease-holder` before any destructive step
- Path comparison against git's native output still normalises ([conventions §3](conventions.md#3-paths-and-line-endings))

**td:** [td §7](../../mvp/td/worktree.md#7-worktrees)

---

### Phase 4 — Terminal seam on Herdr

**Delivers:** `src/seams/terminal/` — the seven functions on Herdr, `types.ts` generated from `herdr api schema --json`, the type generator, and a `yan doctor` check comparing `protocol` / `schema_version` against the installed binary.

**Does not deliver:** supervision, orchestration, or the deletion of anything tmux.

**Trace**
- `term_container_create` / `term_agent_start` / `term_list` / `term_agent_close` round-trip against a real Herdr session
- `term_agent_start` is two steps — `pane split --no-focus --cwd <path> --env …`, then `agent start … -- <argv>` — and returns only when Herdr reports the agent interactive-ready
- Arguments reach the agent as argv; `--append-system-prompt` with spaces survives ([evidence §2](../td/evidence.md#2-argv-passthrough))
- `term_agent_alive` returns only `alive | dead | unknown`, derived by the two-step in [terminal.md §5](../td/terminal.md#5-alive-dead-unknown); a closed pane is `dead`, a dead Herdr server is `unknown`
- Ids are recorded and used; nothing is located by label; a `pane move` is reconciled by name
- No Herdr `error.code` escapes the seam
- `--no-focus` everywhere; the seam contains no call that can close a workspace, tab, or pane `yan` did not create
- **The assertions of `tests/unit/lib-term-contract.test.sh` are ported to vitest and pass against Herdr.** The bash test keeps running against tmux until Phase 9
- `winpty` appears nowhere
- `yan doctor` reports Herdr's `protocol` / `schema_version` against the generated types, **and** `herdr integration status` for every kind named in `conf/config.json`'s `agents.*` — worded as a version / session-id check, never as "supervision is authoritative" ([terminal.md §6](../td/terminal.md#how-reliable-this-is))
- `agent_session` is recorded when present and its absence is normal, not an error

**td:** [terminal.md](../td/terminal.md), [evidence.md](../td/evidence.md), [sources.md](../td/sources.md)

---

### Phase 5 — Event spike (gate)

**Delivers:** a throwaway spike plus a written answer to the five questions this phase set, recorded as a new section of [`evidence.md`](../td/evidence.md). *(Landed: [evidence §11](../td/evidence.md#11-the-phase-5-event-spike). What it left open became [supervision.md §7](../td/supervision.md#7-what-is-still-open).)*

**Precondition:** both integrations `current` in `herdr integration status` — the configuration `yan` will run in. Note this does **not** buy authoritative state: at v7 the Claude and Codex integrations report session identity only, so `blocked` and `done` are screen matches either way ([sources.md §4.1](../td/sources.md#41-detection-has-two-mechanisms-and-yans-agents-get-the-weaker-one)). Question 3 below is therefore the one that decides how much of supervision survives.

**Trace**
- A subscription survives a multi-hour block; the behaviour when the Herdr server restarts under it is documented
- Events arrive for panes that are not focused, and to a subscriber started from a hook's environment
- **The prompts that matter are enumerated and each is checked** — permission request, plan approval, tool prompt, and whatever else Claude and Codex actually block on — with a written list of which ones Herdr recognises and which it reports as `idle`. This is screen matching for both agents, so a single happy-path observation proves nothing
- The window between dispatch and subscription is measured, and whether a post-subscribe snapshot read is needed is settled
- `agent wait --until` is exercised once, for the single-shift case
- **Whether `pane report-agent --state` suppresses Herdr's own detection** for that pane is measured both ways, and a recommendation is written
- `agent start --kind codex` succeeds when `codex` is not on the caller's `PATH`, or how Herdr resolves the executable is documented

**Gate:** if subscription is unreliable, Phase 6 falls back to polling `agent list` — still on facts rather than a content hash — and the lock and beacon stay. Say which, in writing, before starting Phase 6.

---

### Phase 6 — Supervision

**Delivers:** a socket client for Herdr's event stream, `yan wait` on two sources, `hook-autoarm` and `hook-turnend-guard` as TypeScript behind shell stubs, `.claude/settings.json` and `.codex/hooks.json` updated.

**This phase is not the deletion it was planned as.** `events.subscribe` has no CLI verb, `pane_exited` cannot be subscribed to, and a reconnect path is mandatory — so a named-pipe client and a reconnect loop come in while only the pane-content hash goes out. Roughly a wash on line count, a clear win on signal ([supervision.md §6](../td/supervision.md#6-what-this-actually-costs)). **Delete nothing to hit a number.**

**Trace**
- A socket client speaks `events.subscribe` over the named pipe, with the Windows pipe-name rule, and lives in its own module with its own `index.ts` and its own test
- Two sources: `run/signal` and Herdr events. The pane-content hash is **gone**; the liveness poll is **not**, because `pane_exited` has no push channel
- Subscribe → snapshot each live pane → block. The snapshot is what closes the window for a `yan wait` starting up over shifts that are already running
- A subscription that ends is reconnected and re-subscribed from `run/meta.json`, and takes a snapshot on the way back in. That path is tested by ending the connection under it, not by hoping
- `blocked` → escalate; `done` → wake; `idle` / `working` / `unknown` → not actionable
- **`done` is a reason to look, never a verdict.** Plan approval arrives as `done` ([evidence §11.3](../td/evidence.md#113-which-prompts-herdr-recognises)), so anything that could clock a shift out re-checks the objective condition — the MR merged into the integration branch — first. A test drives a `done` wake on a shift with no merged MR and asserts nothing was torn down
- **`yan` never calls `agent focus` on a shift pane** — a test asserts the string is absent from the seam
- Claude: SessionStart → `yan session-start`; Stop autoarm runs long `yan wait` in the hook foreground, never `&`
- Guard keeps its own count in `run/guard-failures`, budget 3, does not use `stop_hook_active` as a one-shot, fails open loudly, keeps the 800 ms lock-claim wait
- Codex: no autoarm; the model loops `yan wait --seconds N`; quiet end exits 124
- **The beacon is decided, not assumed.** Its retirement argument assumed one blocking read and does not survive a reconnect loop plus a poll. Keep it or drop it, and write down which and why — the same decision settles what "watcher healthy" means when a watcher is legitimately mid-reconnect
- No CI-polling fourth source

**td:** [supervision.md](../td/supervision.md) §2, §3, §6, §7

---

### Phase 7 — Orchestrators

**Delivers:** `yan shift new`, `yan shift done`, `yan sync`, `yan unit add`, `yan unit set`, `yan state`, `yan send`, `yan report`, `yan session-start`, `yan mr`, `yan land`, and the display-metadata calls from [display.md §4](../td/display.md#4-when-each-call-happens).

**And their bash twins, deleted** (rule 6). Phase 7 owns 17 of the 58 bash test scripts, so the suite comes out of this phase at **roughly forty**, not twenty. (Twenty was this document's arithmetic error: it assumed rule 6 would also collect the twelve scripts belonging to phases 1–6, which rule 6 postdates and does not reach backwards to. Clearing those is Phase 8's, below.) The shrinking suite is still the progress meter — if it has not shrunk by seventeen, commands were ported without being finished.

**Trace** — the four MVP ordering regressions first, because none of them fails loudly:
- `shift new` asserts the sub-agent's cwd is not a main clone and **refuses** otherwise
- `shift done` order: MR merged → `outcome` → `rm -rf run/` → **return the tree** → **then** delete the remote branch
- `sync` exits immediately on conflict and never resolves one
- After `pool_return`, gitignored directories are still there

and then:
- `unit set --branch` archives the old round into `history[]` atomically; `unit add` stops when the `branch-name` hook exits non-zero and never falls back to a default
- `state` derives; it never reads the last line of `run/status` as the current state
- `session-start` rebuilds from disk + Herdr + pool + forge with no durable `yan` state
- Workspace tokens and pane titles are set at the moments in display.md §4, cleared on teardown, and a metadata failure logs one line without aborting the operation
- `target` is never defaulted by any command

**td:** [orchestration.md](../td/orchestration.md), [display.md](../td/display.md), [td agents §5.1–5.4](../../mvp/td/agents.md) for what is unchanged

---

### Phase 8 — New entry

**Delivers:** bare `yan` → select; `src/ui/prompts.ts`; `yan continue` without the container half; `yan task new` ending in the current pane; `lib-ui.sh` and `ui/` deleted. **And rule 6's back debt** — see below.

**This phase empties `bin/` of commands.** `continue` and `task new` are the last two with no TypeScript twin, and porting them removes the last bash *writer* — which is what `tests/integration/interop.test.ts` exists to compare against. Its premise ("bash writes, TypeScript reads") expires here, and with it the reason the eight already-ported command scripts from phases 1–6 have been kept: `interop` invokes `bin/yan-ls.sh` directly in four places, and until now deleting it would have taken the test with it.

So the order matters, and it is: port the two → retire `interop.test.ts` → delete the remaining eight `bin/yan-*.sh` and their twelve tests. After this phase `bin/` holds no command implementation at all, and Phase 9 is tmux, the `lib-*.sh` that outlived their callers, and the three stubs.

**Trace**
- `bin/yan-*.sh` is empty of commands; `tests/run.sh` is down to the `lib-*` and tmux scripts
- **`yan doctor` is a whole command.** It was half of one — the TypeScript side ran the Herdr section and delegated the rest of the checklist to `bin/yan-doctor.sh` — so emptying `bin/` is a port here, not a delete. It ends listing git, node, herdr and the configured forge CLI, and not `jq` / `tmux` / `winpty`
- **`bin/hook-autoarm.sh` becomes the stub.** Its shell body armed supervision by running `bin/yan wait`; once `yan-wait.sh` is gone that body can only report that it armed nothing, which is worse than not being there. It reaches the shape Phase 9 describes one phase early, and for a reason rather than as tidying
- `interop.test.ts` is deleted, not adapted — there is no longer a bash side for it to compare with
- **Commander's own argument errors exit 2, like every other "you called this wrongly".** Today an unknown option or a missing option-argument exits 1, because that is Commander's default and Phase 0 inherited it — so `yan tree get --nonsense` and `yan tree get` (no `--repo`) disagree about what the same class of mistake is worth. The CLI layer is open in this phase; this is where it gets settled
- `yan` with a TTY shows create-new-task plus live tasks, derived from the same scan `yan ls` uses; without a TTY it prints usage and exits 0
- Choosing a task starts the main agent **in the calling pane**; no workspace is created
- A dispatched shift lands in a sibling pane and `user`'s focus does not move
- A second `yan` on the same task is still refused, and `continue` reports where the live one is instead of spawning a duplicate
- No `attach` remains in the code or the docs
- The `ui_node` / nvm discovery dance is gone; Clack is a normal dependency
- Agent-only commands (`report`, `wait`, `drain`, `send`) grew no prompts

**td:** [cli-ux.md](../td/cli-ux.md)

---

### Phase 8.5 — Codex

**Why it exists.** Every other phase moved something. This one pays a debt that has been named in five documents and fixed in none: **the Codex harness binding has never worked**, and `supervision.md` describes it as though it has. Phase 9 is deletion and must not carry an investigation, so the debt is settled here or it is written off here.

**Two independent faults, found together and easy to confuse.**

1. **`.codex/hooks.json` is malformed.** Codex refuses it at startup — `unknown field \`version\`, expected \`description\` or \`hooks\`` — so `SessionStart` has never run `yan session-start` and `Stop` has never run the turn-end guard. Three schema mismatches against the shape codex accepts (which `herdr integration install codex` writes, and which `.claude/settings.json` already uses): a `version` key that does not exist, a missing `hooks[]` nesting level, `command` as an array where a string is wanted, and `timeout_ms` where `timeout` in seconds is wanted.
2. **A first-run gate.** Codex asks to trust the workspace, and then to review hooks. On an unanswered prompt it exits. That is almost certainly what [evidence §11.7](../td/evidence.md#117-agent-start---kind-codex) recorded: the prompt is an alternate-screen TUI, rows leaving the alternate screen never enter Herdr's host scrollback, so what remained on the host screen — and what Herdr's detection matched as "ready" — was the bare shell prompt underneath.

The gate is **not one-time**. Codex records hook trust by file hash, so a Herdr integration upgrade rewrites `~/.codex/hooks.json`, changes the hash, and re-arms the review prompt — in a dispatched shift's pane, which by rule has no focus and no human.

**Why the existing guards do not settle it.** `startAgent`'s confirmation catches the case where codex has **exited** — which is the one the spike hit. It does not catch codex **parked** on a prompt: Herdr sees an agent there, `agentAlive` says alive, and the brief goes into the dialog. The only thing that catches the parked case is Herdr classifying that prompt as `blocked` — and Codex's prompts have never been enumerated. [evidence §11.3](../td/evidence.md#113-which-prompts-herdr-recognises)'s table is Claude's, all of it.

**Trace**
- `.codex/hooks.json` is a shape codex parses. Verified by running codex, not by reading the schema
- `harness-bindings.test.sh` asserts the codex file's **structure**, the way it already does for Claude. Its own comment says it was written when codex was not installed and greps the body instead; that is why this was invisible for eight phases
- `conf/config.sample.json` does not point a fresh machine at an unverified path. It currently reads `"agents": { "yan": "codex" }`
- `agent start --kind codex` is tried **in a pool worktree path** — `~/.yan-trees/<repo>-<hash>/<slot>/<repo>`, what a shift actually gets — not only in a trusted repo directory. Trust is recorded per project path; whether it is inherited by subdirectories is the question, and guessing is not answering it
- Codex's approval prompts are enumerated as §11.3 enumerated Claude's: one at a time, `agent get` read against the subscription, and the ones Herdr reports as something other than `blocked` written down
- The binding runs once end to end: SessionStart reaches `yan session-start`, the Stop guard blocks and then fails open, and the model-driven `yan wait --seconds N` checkpoint returns 124 on a quiet slice
- **Either way, the documents agree with reality when this ends.** If Codex works, `evidence.md` gains the run and `orchestration.md §9` loses its open item. If it does not, `supervision.md` stops describing a binding that has never run, `evidence.md` records why, and `yan doctor` says so at the point someone would otherwise find out by dispatching

**This phase is allowed to fail.** "Codex cannot be a shift agent, here is how far we got and what would be needed" is a complete deliverable. What is not acceptable is leaving five documents describing a path nobody has run.

*(Landed. Two of this entry's own claims were measured wrong and are corrected in [evidence §13](../td/evidence.md#13-measured-in-phase-85-the-codex-binding): codex does **not** exit on an unanswered prompt — it parks, which is why the guards do not catch it — and the first-run gate was **not** what [evidence §11.7](../td/evidence.md#117-agent-start---kind-codex) recorded, since that exit did not reproduce. The verdict is split rather than yes/no: Codex is fine as the main agent and is an unattended shift agent because `user` chose to pass `--dangerously-bypass-hook-trust`, weighing a shift that never parks silently against hooks from the target repository running unreviewed.)*

---

### Phase 9 — Retire tmux and bash

**Delivers:** deletion — most of it already done by rule 6 as each command landed, so what is left is the part that had a reason to wait. The tmux terminal implementation and the `backend` config key with its fail-closed branches; whatever `bin/*.sh` remains beyond the three hook/entry stubs; `tests/run.sh`, `tests/assert.sh`, `tests/stub/`; and the `jq` / `winpty` / `tmux` dependency checks.

The three stubs keep their behaviour — dual dispatch, the node check — and keep being tested, from **vitest**, which can spawn a shell script as easily as anything else. A whole bash test framework is not needed to cover fifteen lines.

**Trace**
- `grep -ri tmux bin/ src/` returns nothing but history
- `bin/` contains exactly `yan`, `hook-autoarm.sh`, `hook-turnend-guard.sh`, and each is a few lines
- *(`yan doctor`'s checklist — git, node, herdr, the configured forge CLI, and no `jq` / `tmux` / `winpty` — was earned in Phase 8, not here. `doctor` was half a command: its TypeScript half delegated the rest of the checklist to `bin/yan-doctor.sh`, so emptying `bin/` meant porting the remainder rather than deleting it.)*
- The full vitest suite is green on Git Bash and on WSL/Linux
- [`conventions.md`](conventions.md), `AGENTS.md`, `CLAUDE.md` and the MVP docs' stale claims are updated in this phase, not left for later

---

## 6. Definition of "V2 done"

1. `herdr` is running; typing `yan` in a pane offers create-or-continue
2. Creating a task ends with the main agent in that pane, no new workspace
3. Dispatching a shift splits a sibling pane into a leased worktree, without moving focus
4. A shift hitting an approval prompt wakes `yan` through Herdr's `blocked`, without the shift reporting anything
5. `shift done` cleans up in the correct order; the outbound MR opens with `yan mr`; `yan land` only when asked
6. Closing `yan` and reopening rebuilds everything; nothing is lost
7. No bash left in `bin/` except three stubs, and no `jq`, `tmux` or `winpty` anywhere

---

## 7. Running this as a `yan` task

One repository, so **one `unit`** ([CLAUDE.md](../../../CLAUDE.md): two directories released together are one unit). `scope` is the whole repository — the repository *is* the unit, which is the legitimate use of an empty scope.

Each phase is one `shift`. `needs` follows the graph in §4, so Phases 1–4 can be dispatched in parallel and `yan land` will order the rest. Phase 5 is the one shift that is a `scout`: it investigates and reports, it does not change code.

The delicate part is Phase 0, because it rewrites the dispatcher every later shift depends on. Land it alone, on its own integration branch round, before dispatching anything in parallel.
