# `yan` V2 design

> This document records design decisions. It is not an implementation specification. Each decision tries to carry its "why" with it, because when you come back to change something six months later, the reasoning matters more than the conclusion.

The MVP works. It carried a real task from create to outbound merge request on tmux, in bash. This document is the second cut, and it changes three things: **the language**, **the multiplexer**, and **the way a person enters**. Everything the [MVP design](../../mvp/td/INDEX.md) says about `task` / `unit` / `shift`, branching, scope, delivery, boundaries and memory is carried over unchanged.

---

## 0. What V2 changes

| | MVP | V2 | Why |
| --- | --- | --- | --- |
| language | bash, 11,317 lines across 38 files in `bin/` | TypeScript, with shell only where a file must literally be a shell script | the maintainer is a TypeScript developer, and most of `bin/` is not shell-shaped work ([runtime.md](runtime.md)) |
| CLI structure | hand-written flag parsers, 20 of them | Commander | 20 parsers is 20 chances to disagree about `--task` ([runtime.md §3](runtime.md#3-commander)) |
| multiplexer | tmux; `backend: herdr` fails closed | Herdr only; tmux retired once the contract test passes on Herdr | Herdr understands agents; tmux understands processes ([terminal.md](terminal.md)) |
| supervision | three sources, one of them a pane-content hash | Herdr's agent lifecycle states plus its event stream | the hash was a heuristic standing in for a fact Herdr already has ([supervision.md](supervision.md)) |
| entry | `yan task new` creates the container and puts `user` inside it | `user` is *already* inside Herdr; bare `yan` opens a select | stop wrapping the tool the user lives in ([cli-ux.md](cli-ux.md)) |
| worktrees | `yan` owns the pool | unchanged — `yan` still owns it; Herdr is told what to *display* | authority and presentation are different things ([display.md](display.md)) |

**What V2 does not change.** The glossary, the storage criteria, the directory layout, the two-level branch model, `mode`, the forge layer, the authority table, `log.md` as the narrative, and "ask, do not infer". If a V2 document seems to contradict one of those, the MVP document wins and the V2 document is wrong.

---

## 1. The three decisions, in one paragraph each

### TypeScript

The argument is not preference. Of the 11,317 lines in `bin/`, the large majority is JSON read-modify-write (126 `jq` call sites), state derivation, argument parsing, forge-response mapping, and rendering — work where bash offers no types, no structs, and error handling by convention. A further three sections of [`conventions.md`](../../mvp/plan/conventions.md) (§2.2 no `flock`, §2.3 `jq.exe` emits CRLF, §2.4 native vs POSIX paths) exist only because the implementation is bash-plus-`jq` on Windows; in Node they are not solved, they are absent. The counter-argument — that `bin/` deliberately has no hard Node dependency ([`lib-boot.sh:244`](../../../bin/lib-boot.sh)) — is now void: `yan` starts Claude or Codex in a pane, so the machine has Node. **That promise is formally withdrawn here.**

→ [`runtime.md`](runtime.md)

### Herdr

Herdr was designed into the MVP as a second implementation of the same seven `term_*` functions and has failed closed ever since ([`lib-term.sh:11`](../../../bin/lib-term.sh)). All seven exist in Herdr, each stronger than its tmux counterpart, and three of them are things tmux cannot do at all: an agent lifecycle state machine that recognises a blocked approval prompt, a blocking `agent wait --until`, and a push event stream ([`/docs/agent-automation/`](https://herdr.dev/docs/agent-automation/), [`/docs/agents/`](https://herdr.dev/docs/agents/)). The MVP's own prediction — *"Herdr has native agent registration, which cleanly separates 'the pane is there but the agent died' from 'the pane is gone' from 'alive'"* ([td §5.7](../../mvp/td/agents.md#57-terminal-topology)) — is confirmed, with one correction recorded in [terminal.md §5](terminal.md#5-alive-dead-unknown).

One limit is worth naming here rather than burying. Herdr can classify state from an agent's own lifecycle hooks — authoritatively — or by matching screen patterns. **For Claude Code and Codex it is always the latter:** their integrations report session identity and never push state ([sources.md §4.1](sources.md#41-detection-has-two-mechanisms-and-yans-agents-get-the-weaker-one)). So `blocked` is a good guess rather than a fact, it is still far better than the MVP's content hash, and it is why `yan report` stays as the second half of the pair rather than being retired ([supervision.md §1](supervision.md#1-what-was-inferred-and-what-is-now-known)).

→ [`terminal.md`](terminal.md) · [`supervision.md`](supervision.md) · [`sources.md`](sources.md)

### The new entry

The MVP's create flow ends by building a container and putting `user` inside it. Under Herdr that is backwards: Herdr *is* the multiplexer, `user` is already living in it, and launching a second one to run `yan` is absurd. So `yan` stops creating the place and starts joining it. The whole interactive surface collapses to one thing — type `yan` in any Herdr pane, get a select whose first entry is "create new task" and whose rest are the tasks in flight.

→ [`cli-ux.md`](cli-ux.md)

---

## 2. What gets deleted

Most of V2's value is subtraction — **with one exception, and it is the one this table originally got wrong.** Supervision was written up as the largest deletion of all; the Phase 5 spike showed it is close to a wash. The row below says so. Everything else here holds.

| Deleted | Lines | Because |
| --- | --- | --- |
| `winpty` wrapping and its dependency | `lib-term.sh:40-44` + call sites | a native process in a Herdr pane gets a real console ([evidence.md §3](evidence.md#3-native-tty-winpty)) |
| `_term_quote_cmd` and tmux `send-keys` quoting | `lib-term.sh:229-276` | Herdr takes argv arrays ([evidence.md §2](evidence.md#2-argv-passthrough)) |
| `_json_lf` and every CRLF strip | `lib-json.sh:40-42` + 126 sites | no `jq` |
| `lib-lock.sh`'s `mkdir` lock scheme | 221 | Node has atomic rename; and the watcher it protected mostly goes away |
| the pane-content hash source | part of `lib-watch.sh` (365) | Herdr reports `blocked` as a state ([supervision.md](supervision.md)) — **and this row is the only supervision deletion**; the poll loop, the lock and possibly the beacon all stay, and a named-pipe client and a reconnect path are new. Supervision is roughly a wash on line count and a clear win on signal quality ([supervision.md §6](supervision.md#6-what-this-actually-costs)) |
| 20 hand-written flag parsers | across `bin/yan-*.sh` | Commander |
| the tmux implementation of the seam | most of `lib-term.sh` (710) | after, not before, Herdr passes the contract test |

Nothing in this table may be deleted speculatively. Each row is a Trace bullet in [`../plan/INDEX.md`](../plan/INDEX.md).

---

## 3. What is genuinely still shell

Short list, and it is meant to stay short. "It runs `git`" is not on it: spawning a process is a library call, and Node's argv arrays are safer than bash's word-splitting.

| Stays shell | Why |
| --- | --- |
| the Stop / SessionStart hook **entry stubs** | the harness execs a file; each shrinks to a few lines that `exec node …` |
| any command text sent into a pane to be run by a shell | it is literally a line of shell |
| `conf/hooks/branch-name` and its siblings | the contract with an outside authority is "an executable file" ([td §10](../../mvp/td/boundaries.md#10-seams-for-outside-authorities)) |

---

## 4. Reading order

| Document | What it settles |
| --- | --- |
| [`runtime.md`](runtime.md) | the language, the module layout, Commander, the build, the tests |
| [`terminal.md`](terminal.md) | the Herdr seam: the seven functions, ids, errors, the reconcile path |
| [`supervision.md`](supervision.md) | what replaces `yan wait`'s three sources, and what survives |
| [`cli-ux.md`](cli-ux.md) | living inside Herdr; bare `yan`; Commander next to Clack |
| [`display.md`](display.md) | `yan` owns the worktree pool, Herdr shows it |
| [`orchestration.md`](orchestration.md) | the life of a shift under Herdr: dispatch, teardown, and what `done` does not mean |
| [`evidence.md`](evidence.md) | every measurement the above rests on, and what is still unverified |
| [`sources.md`](sources.md) | which Herdr resource is authoritative for what, how to re-verify after an upgrade, and the three facts only the website states |

Delivery order is [`../plan/INDEX.md`](../plan/INDEX.md). Implementation conventions are [`../plan/conventions.md`](../plan/conventions.md), which replaces the shell-style section of the MVP's.
