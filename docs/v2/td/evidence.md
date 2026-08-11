# Evidence

> Every claim the V2 design rests on, with how it was measured — and, at the end, everything that is *not* measured. This exists so that a Herdr upgrade can be re-checked against a list rather than against memory.

**Environment.** `herdr 0.8.0-preview.2026-08-04-d78e3d3b5126`, protocol 19, `schema_version` 1, installed at `C:\Users\libod\AppData\Local\Programs\Herdr\bin\herdr.exe`, socket `%APPDATA%\herdr\herdr.sock`. Windows 11, Git Bash (MSYS2), inside a live Herdr session. Probes run 2026-08-10.

**Herdr is on a preview channel.** Everything below is true of a pre-release build, which is exactly the condition under which generated types and a `yan doctor` version check earn their keep ([runtime.md §4](runtime.md#4-types-come-from-the-outside-authorities)).

---

## 1. Environment independence

**Claim:** the Herdr CLI works from a hook whose environment the harness may have sanitised.

```
$ env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID herdr pane list
{"id":"cli:pane:list","result":{"panes":[…]}}   rc=0
```

Full JSON with all three variables removed — the CLI finds the default socket itself. The `test "${HERDR_ENV:-}" = 1` line in `herdr --skill` is a behavioural convention for agents, not a runtime gate.

**Consequence:** `--current` is the only thing that needs `HERDR_PANE_ID`, so `yan` never uses it and always passes explicit ids — which is the rule it already had ([terminal.md §3](terminal.md#3-identifiers)).

**Also observed:** Herdr injects `HERDR_ENV=1` and `HERDR_PANE_ID` into every pane it creates, so a shift knows its own pane id without being told.

---

## 2. argv passthrough

**Claim:** agent arguments reach the agent without passing through a shell.

```
$ herdr agent start yanprobe --kind claude --pane w2:p2 --timeout 60000 \
    -- --append-system-prompt 'YANPROBE_MARKER is zx9q7. If asked for the marker, reply with exactly: MARKER=zx9q7'

{"result":{"agent":{"name":"yanprobe","agent_status":"idle","interactive_ready":true,…},
 "argv":["claude","--append-system-prompt","YANPROBE_MARKER is zx9q7. If asked for the marker, reply with exactly: MARKER=zx9q7"]}}
```

Echoed back as an argv **array**, spaces and colon intact. Then:

```
$ herdr agent prompt yanprobe "What is the marker?" --wait --timeout 120000
$ herdr agent read yanprobe --source recent-unwrapped --lines 40   →   MARKER=zx9q7
```

**Consequences:** `--append-system-prompt` works, so `yan` can inject a shift's brief context at start. `_term_quote_cmd` (`lib-term.sh:229-276`) has nothing left to do. `agent start` returned only once `interactive_ready: true`, so the MVP's start-confirmation logic goes too.

---

## 3. Native TTY (winpty)

**Claim:** a native Windows console program in a Herdr pane gets a real console, not a pipe.

A `probe.js` run via `herdr pane run`:

```json
{"isTTY":true,"stdinTTY":true,"cols":74,"rows":50,
 "YAN_TASK":"t-probe","YAN_HOME":"C:/workspace/project/Yan",
 "HERDR_ENV":"1","HERDR_PANE_ID":"w2:p2","TERM":"xterm-256color"}
```

**Consequences:** `lib-term.sh:40-44` and the `winpty` dependency are deleted — this was the [conventions §2.1](../../mvp/plan/conventions.md) tax, and Herdr ships `bin/conpty/`. `pane split --env KEY=VALUE` passes environment through, so `YAN_TASK` / `YAN_TASK_DIR` need no wrapper script. `--cwd` was honoured exactly.

Note `cols: 74` — the pane inherited the split geometry, not the MVP's `YAN_TERM_COLS=200`. The MVP set 200 because an agent TUI reflows badly at 80. `--ratio` on `pane split` is the lever; whether it is needed is a Phase 6 question.

---

## 4. Display metadata

**Claim:** `yan` can label Herdr's UI without giving Herdr any authority.

```
$ herdr workspace report-metadata w2 --source yan \
    --token task=t-probe --token unit=auth --token branch=feat/auth-round2 --ttl-ms 600000
(rc=0, no stdout)

$ herdr workspace get w2
…"tokens":{"branch":"feat/auth-round2","task":"t-probe","unit":"auth"}…

$ herdr pane report-metadata w2:p2 --source yan --title "s3-auth · unit=auth" --display-agent "yan:shift"
(rc=0, no stdout)

$ herdr agent list
{"name":"yanprobe","display_agent":"yan:shift","title":"s3-auth · unit=auth",…}

$ herdr workspace report-metadata w2 --source yan --clear-token task --clear-token unit --clear-token branch
$ herdr workspace get w2   →   "tokens": null
```

**Consequence:** [display.md](display.md) in full. Note that mutating commands succeed **silently** — rc 0 with empty stdout — so a wrapper must not treat empty output as failure.

---

## 5. Error shape and the `alive` derivation

```
$ herdr agent get nosuchagent
rc=1   stderr: {"error":{"code":"agent_not_found","message":"agent target nosuchagent not found"},"id":"cli:agent:get"}

$ herdr pane close w2:p2        →  {"result":{"type":"ok"}}
$ herdr agent get yanprobe
rc=1   stderr: {"error":{"code":"agent_not_found","message":"agent target yanprobe not found"}}
```

**Consequence, and a correction to the MVP:** a dead agent and one that never existed return the **same** code, so `term_agent_alive` cannot be one call. The two-step derivation is in [terminal.md §5](terminal.md#5-alive-dead-unknown). `rc=1` is a server error carrying `error.code`; `rc=2` is a CLI syntax error, per `herdr --skill`.

---

## 6. Pane shell

A bash-syntax command sent to a fresh pane produced a **PowerShell** parser error (`The token '||' is not a valid statement separator`). `herdr --default-config` exposes `default_shell` (empty ⇒ `$SHELL`, then `/bin/sh`) and `shell_mode`.

**Consequence:** [terminal.md §7](terminal.md#7-two-operational-facts-that-constrain-the-design). `agent start` is unaffected — it runs the executable directly.

---

## 7. Agent session id

`pane list` returns, per pane:

```json
"agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"9e075010-a4f3-44d1-87ea-bd2b88de73f7"}
```

The value matched the agent CLI's own session id for that pane. Recorded in `run/meta.json`; no V2 behaviour is built on it yet.

---

## 8. Integration status

```
$ herdr integration install codex
installed codex integration hook to C:\Users\libod\.codex\herdr-agent-state.ps1
ensured codex hooks at C:\Users\libod\.codex\hooks.json
ensured codex config at C:\Users\libod\.codex\config.toml

$ herdr integration status
claude: current (v7)   C:\Users\libod\.claude\hooks\herdr-agent-state.ps1
codex:  current (v7)   C:\Users\libod\.codex\herdr-agent-state.ps1
… 9 further kinds, not installed
```

Installing Codex's added `[features] hooks = true` to `~/.codex/config.toml` and wrote `~/.codex/hooks.json`. `herdr integration install <TARGET>` accepts 16 targets.

### What these integrations actually do — and do not

Both installed hooks were read. They report **session identity only**:

| | Lines | Registered on | Calls |
| --- | --- | --- | --- |
| `~/.claude/hooks/herdr-agent-state.ps1` | 49 | `SessionStart` | `pane report-agent-session` |
| `~/.codex/herdr-agent-state.ps1` | 47 | `SessionStart` | `pane report-agent-session` |

Each begins `param([string]$Action = "")` followed by `if ($Action -ne "session") { exit 0 }`, and neither contains `report-agent --state`. Both `~/.claude/settings.json` and `~/.codex/hooks.json` register `SessionStart` and nothing else.

**So for Claude Code and Codex, `agent_status` is always a screen match, never a hook report** — which is the opposite of the natural reading of [`/docs/agents/`](https://herdr.dev/docs/agents/), and is corrected in [sources.md §4.1](sources.md#41-detection-has-two-mechanisms-and-yans-agents-get-the-weaker-one) and [terminal.md §6](terminal.md#how-reliable-this-is). It also confirms where `agent_session.value` comes from ([§7](#7-agent-session-id)): that hook, and nothing else.

**Two different things, and they are easy to confuse.** Installing and authorizing the **Codex CLI** does not install **Herdr's Codex integration**. Before the install above, `~/.codex/auth.json` and `config.toml` existed and Codex had been run, while the hook Herdr looks for was absent and `integration status` said `not installed`. They are separate steps; expect to hit this once per agent kind.

**Consequence:** `yan doctor` checks `integration status` for every kind in `conf/config.json`'s `agents.*` — for the session id and to notice a version change — but it must **not** report that supervision is authoritative because an integration is present. This snapshot is dated; re-read it rather than trusting the lines above.

*(Superseded by [§11.7](#117-agent-start---kind-codex): `codex` is on `PATH` at `~/AppData/Local/Programs/OpenAI/Codex/bin/codex`, so the question of how Herdr resolves an agent binary a shell cannot find was never asked. A worse problem was found instead.)*

---

## 9. Read from the schema, not exercised

Everything in this section is **design input, not measurement**. It comes from `herdr api schema --json` (261 KB) and `herdr <group> --help`.

| Capability | Status | Where it is relied on |
| --- | --- | --- |
| `events.subscribe` — `EventsSubscribeParams`, `EventEnvelope`, `Subscription` | ~~schema only~~ **exercised, [§11](#11-the-phase-5-event-spike)** | [supervision.md §2](supervision.md#2-the-shape-of-yan-wait) — **the largest subtraction in V2 depends on it** |
| `SubscriptionEventKind` = `pane.output_matched`, `pane.agent_status_changed`, `pane.scroll_changed` | ~~schema only~~ **exercised, [§11.2](#112-what-a-subscription-can-and-cannot-carry)** | supervision.md §3 |
| `EventKind` — 26 kinds incl. `pane_exited`, `pane_agent_detected` | **not deliverable — [§11.2](#112-what-a-subscription-can-and-cannot-carry)** | supervision.md §3 |
| `agent wait --until <state> --timeout` | ~~help text only~~ **exercised, [§11.6](#116-agent-wait---until)** | supervision.md §2 |
| `blocked` firing on real Claude / Codex approval UIs | **partly — [§11.3](#113-which-prompts-herdr-recognises)** | terminal.md §6, supervision.md §3 |
| `done` vs `idle` seen-semantics | **exercised, [§11.3](#113-which-prompts-herdr-recognises)** | supervision.md §3 |
| `--kind codex` | **tried, and it did not work — [§11.7](#117-agent-start---kind-codex)** | the Codex binding |
| `agent explain` | not tried | possible `yan doctor` aid |
| `--remote <ssh-target>` | not tried | out of V2 scope |
| Herdr on Linux / WSL | not tried | [conventions](../plan/conventions.md) claims two platforms |
| `default_shell` actually switching the pane shell | config read, not set | terminal.md §7 |

The first four rows are why [supervision.md §7](supervision.md#7-what-is-still-open) is the list Phase 6 inherits, and why no MVP supervision code was deleted before the spike ran.

Facts taken from Herdr's website rather than from this machine — how detection works, the `idle` false negative, the tmux-nesting limitation — are kept separately in [`sources.md §4`](sources.md#4-what-only-the-website-says), because they carry a different kind of authority and need re-checking on a different schedule.

---

## 10. Baseline being replaced

Measured on the MVP tree at `be1984a`, for judging progress and for knowing what "done" costs:

| | |
| --- | --- |
| `bin/` shell | 11,317 lines across 38 files |
| `jq` call sites | 126 |
| hand-written flag parsers | 20 |
| tests | 58 scripts, 9,196 lines |
| `ui/` (Node, kept) | 557 lines |
| biggest files | `lib-forge.sh` 861 · `lib-term.sh` 710 · `yan-shift-new.sh` 621 · `lib-pool.sh` 602 · `lib-task.sh` 546 |
| supervision | `yan-wait.sh` 372 + `lib-watch.sh` 365 + `lib-lock.sh` 221 |

---

## 11. The Phase 5 event spike

> Run 2026-08-10 against the same build as the rest of this document — `herdr 0.8.0-preview.2026-08-04-d78e3d3b5126`, protocol 19, `schema_version` 1 — inside a live Herdr session on Windows 11 / Git Bash. `herdr integration status` reported `claude: current (v7)` and `codex: current (v7)`, which is the precondition Phase 5 set.
>
> This section answers the five questions in supervision.md §6. It is the gate for Phase 6.

### 11.1 There is no CLI for `events.subscribe`; the transport is a named pipe

`herdr api` has exactly two subcommands, `snapshot` and `schema`. `events.subscribe` and `events.wait` exist in the **request** schema and have no CLI verb, so a subscriber has to speak the socket protocol itself.

On Windows that socket is not what its name suggests. `%APPDATA%\herdr\herdr.sock` is a **hint file** whose whole content is `<server-pid>:<nanos>`; connecting to it as a path gives `ENOTSOCK`, and the number in it is not a TCP port either (`ECONNREFUSED`). The real endpoint is a **named pipe whose name is that path**:

```
\\.\pipe\C:\Users\…\AppData\Roaming\herdr\herdr.sock
```

Newline-delimited JSON in both directions, `{id, method, params}` out and `{id, result}` / `{id, error}` / `{event, data}` back:

```
-> {"id":"spike:sub","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.agent_status_changed","pane_id":"wF:p2"}]}}
<- {"id":"spike:sub","result":{"type":"subscription_started"}}
<- {"event":"pane.agent_status_changed","data":{"agent":"claude","agent_status":"working","pane_id":"wF:p2","workspace_id":"wF"}}
```

**Consequence:** the terminal seam's CLI transport does not cover supervision. `yan wait` needs a second, socket-level client, and on Windows it must know the pipe-name rule. That is one more module than [supervision.md §2](supervision.md#2-the-shape-of-yan-wait) implies, and it is the first thing Phase 6 has to build.

### 11.2 What a subscription can and cannot carry

Every `SubscriptionEventKind` is **pane-scoped and requires `pane_id`**; a subscription without one is refused with `invalid_request: missing field pane_id`. So `yan wait` subscribes once per live shift pane, exactly as supervision.md §2 says.

The important negative:

| wanted by supervision.md §3 | available? |
| --- | --- |
| `agent_status → blocked` / `done` / `idle` / `working` | **yes**, `pane.agent_status_changed` |
| `pane_exited` → `died: <sid>` | **no** |

`pane_exited` is in `EventKind` (the *event* schema, 26 kinds) but not in `SubscriptionEventKind` (3 kinds). The other route does not work either — `events.wait` accepts the shape and the server refuses it:

```
-> {"method":"events.wait","params":{"match_event":{"event":"pane_exited","pane_id":"wF:p3"},"timeout_ms":30000}}
<- {"error":{"code":"unsupported_event_wait_match","message":"events.wait currently supports pane agent status matches"}}
```

Same answer for `pane_closed`. The schema advertises 19 `EventMatch` variants; the server implements one family.

**Consequence:** "the agent died and cannot say so" has **no push channel at all**. It stays a poll of `termAgentAlive`, which is what [supervision.md §1](supervision.md#1-what-was-inferred-and-what-is-now-known) row 2 already keeps as the fallback — but the row's promise of an *event* is not deliverable on this build.

### 11.3 Which prompts Herdr recognises

Driven against a real Claude Code in an unfocused pane, one prompt at a time, reading `agent get` and the subscription together. This is the answer to the question supervision.md §6 calls "the critical one".

| what was on screen | `agent_status` | woke `yan`? |
| --- | --- | --- |
| tool permission — *"Do you want to create spike-marker.txt?"* | **`blocked`** | yes, correctly |
| tool permission — *"Bash command … This command requires approval"* | **`blocked`** | yes, correctly |
| interactive question / select — *"What should `--quiet` suppress? 1/2/3"* | **`blocked`** | yes, correctly |
| **plan approval — *"Claude has written up a plan and is ready to execute. Would you like to proceed?"*** | **`done`** | yes, but for the wrong reason |
| the `/` menu, opened and left open | `idle` | no |

Three of the four blocking UIs are recognised. The plan approval is **not**, and `agent explain` says why:

```
state: idle
rule: osc_title_idle (region=osc_title priority=250)
evidence: "✳ Plan quiet flag for bin/yan"
```

No screen rule matched the plan-approval box, so Herdr fell back to the terminal title at priority 250 and called it idle. This is precisely the false negative [sources.md §4.2](sources.md#42-an-unlearned-prompt-shows-as-idle-not-blocked) predicts.

**Two things stop that from being fatal, and both matter to Phase 6.**

1. The miss landed on **`done`**, not on silence, because the pane was unseen — and supervision.md §3 already maps `done` to a wake. `yan` is still woken; it is woken with `done: <sid>` instead of `blocked: <sid>` and finds the real state when it reads the pane. A missed `blocked` degrades the *reason*, not the *wake*.
2. The `/` menu reporting `idle` is arguably right rather than wrong: nobody is waiting on the agent, `user` opened it. It is listed for completeness, not as a defect.

**`done` vs `idle` behaved exactly as [terminal.md §6](terminal.md#6-agent-lifecycle-states) describes.** `agent explain` reported `state: idle` at the same moment `agent get` reported `done`, which is the seen/unseen wrapper over one underlying state, observed rather than assumed.

### 11.4 A subscription survives, and reaches a hook's environment

- **Unfocused panes:** every event above came from a pane that was never focused. Confirmed.
- **A hook's environment:** the subscriber was started with `env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_SOCKET_PATH`. It found the socket itself from `%APPDATA%` and received every event. This extends [§1](#1-environment-independence) from the CLI to the socket.
- **Duration:** one subscription held **420 s** across nine state changes, including a `blocked` that sat unanswered for ~50 s, and closed cleanly only when the spike ended it. **Multi-hour was not measured** — that is a wall-clock cost this spike did not pay, and it remains the one liveness claim in supervision.md §6 q1 that rests on a shorter observation than the question asks for.
- **Server restart under a subscription: NOT TESTED.** The only way to test it is `herdr server stop`, which stops `user`'s whole session and every process in it ([conventions §6](../plan/conventions.md#6-working-with-herdr-from-a-test-or-a-script)). Phase 6 must therefore treat "the subscription ended" as a state it handles rather than one it has seen: reconnect, re-subscribe from `run/meta.json`, and take a snapshot read on the way back in.

### 11.5 The window between dispatch and subscription

`agent start` returned in **3.1 s** with `interactive_ready: true`, and the first `agent_status` event for that pane arrived **13.6 s** after the subscription was established — i.e. the agent's own readiness, not a delivery delay.

The window is real but it is small and it is one-sided: a subscription established *before* `agent start` (which is the order `yan shift new` can always use) misses nothing. **A post-subscribe snapshot read is still needed**, for the different case supervision.md §6 q4 is really about — `yan wait` starting up while shifts are already running. `agent wait` is a state check rather than an edge trigger and confirms it: with the agent already `done`, `agent wait --until done` returned in **35 ms**.

**Recommendation:** subscribe first, then read `agent get` once per live pane, then block. The snapshot costs one call per shift and removes the whole class.

### 11.6 `agent wait --until`

Exercised for the single-shift case, both ways:

```
$ herdr agent wait yanspike --until done --timeout 5000     # already done
{"result":{"agent":{…"agent_status":"done"…}}}              real 0m0.035s

$ herdr agent wait yanspike --until blocked --timeout 3000  # not blocked
{"error":{"code":"timeout","message":"timed out waiting for agent status"}}   real 0m3.081s
```

Note the second one: **a timeout is an `error` with `code: timeout`**, not a distinguishable exit status. A caller must map that code rather than treat rc 1 as failure — which is what the terminal seam's error mapping is for.

### 11.7 `agent start --kind codex`

Two findings, and the second is a real hazard.

**`codex` is now on `PATH`** (`~/AppData/Local/Programs/OpenAI/Codex/bin/codex`), so [§8](#8-integration-status)'s closing note is out of date and the question as posed — does `--kind codex` work when codex is *not* on `PATH` — could not be asked on this machine.

**`agent start --kind codex` reported success for an agent that was not running.**

```
$ herdr agent start yanspikecodex --kind codex --pane wF:p3 --timeout 90000
{"result":{"agent":{"agent":"codex","agent_status":"idle","interactive_ready":true,…},"argv":["codex"]}}   real 0m3.085s
```

The pane's own scrollback tells a different story:

```
PS C:\workspace\project\Yan> & codex
PS C:\workspace\project\Yan>
```

`codex` was launched and exited immediately, printing nothing, leaving a bare PowerShell prompt — and Herdr's screen detection matched *that* and called it interactive-ready. `agent get` then reported `agent_not_found` a minute later, and `agent prompt` had meanwhile typed the prompt text **into PowerShell**, which tried to run it as a command.

Three consequences, all binding on Phase 6 and Phase 7:

1. **`agent start` returning success is not proof the agent is up.** [terminal.md §2](terminal.md#2-the-seven-functions) reads it as one; for Codex on Windows it is not. A dispatch has to confirm afterwards — `agent get` by name, or `termAgentAlive` — before it treats the shift as started.
2. **`agent prompt` into a pane whose agent has died types into a shell.** That is the reason `yan` must never send to a pane it has not just confirmed alive.
3. No `agent_session` was reported for the codex agent, although `integration status` says `codex: current (v7)`. Absence is normal ([terminal.md §7](terminal.md#7-two-operational-facts-that-constrain-the-design)) — but it means the codex integration bought nothing observable here.

Whether codex fails because the pane's shell is PowerShell, because of the 24-row split geometry, or for a reason of its own was not established. It is the first thing to settle before the Codex binding is relied on.

> **Phase 8.5, partly.** The exit was **not reproduced**: started the same way into a pool worktree, codex stays up and parks on a first-run prompt ([§13.4](#134-the-two-first-run-gates-in-a-pool-worktree)). So this section's own observation stands as recorded and its *generalisation* does not — "codex exits" became the accepted reading of the Codex path in [orchestration.md §9](orchestration.md) on one sighting, and the failure that actually blocks a shift is a different one. Consequence 1 below is unaffected and, if anything, stronger: `agent start` reporting ready is not proof the agent is **working**, whether it left or never started.

### 11.8 Should `yan` report state itself? No.

`pane report-agent --state` is public API and its `--state` values are `idle | working | blocked | unknown` — **there is no `done`**, so a reporter could not express the one state that means "unseen work finished" in the first place.

Measured both ways, on a pane whose real state was known:

| | |
| --- | --- |
| pane genuinely `blocked`; reported `working` | `agent get` still said **`blocked`** |
| pane genuinely `done`; reported `blocked`, polled 8× over 3 s | `agent get` said **`done`** every time |
| after `pane release-agent` | unchanged |

Every call returned rc 0 and empty stdout — a mutating command succeeding silently, per [§4](#4-display-metadata) — and **nothing changed**. Herdr's own screen detection stayed the authority throughout; `agent explain` kept naming the manifest rule it had matched.

**Recommendation: leave detection alone.** Do not build `yan report` on top of `pane report-agent`. On this build an outside process reporting through the documented CLI shape does not claim authority and does not suppress detection, so the risk terminal.md §6 raised — that reporting only at `yan report` moments would leave `yan` blinder than letting Herdr guess — cannot arise, and the feature buys nothing. Re-check after a Herdr upgrade; this is a preview build and the API is documented as if it should work.

### 11.9 The gate

`events.subscribe` **holds up**, with three corrections to the design it carries:

1. it needs a socket client, not the CLI, and on Windows a named-pipe name rule ([§11.1](#111-there-is-no-cli-for-eventssubscribe-the-transport-is-a-named-pipe));
2. it cannot carry `pane_exited`, so "the agent died" stays a poll ([§11.2](#112-what-a-subscription-can-and-cannot-carry));
3. `blocked` covers three of the four prompts that matter and misses plan approval, which arrives as `done` and still wakes `yan` ([§11.3](#113-which-prompts-herdr-recognises)).

None of those is the failure supervision.md §6 defined as the gate's failure condition, so **Phase 6 proceeds on subscription rather than on the `agent list` polling fallback** — with the pane-liveness poll kept, and with `run/signal` kept, which §11.3 makes more important rather than less.

---

## 12. Measured while building Phase 6

> Same machine and same build as [§11](#11-the-phase-5-event-spike) — `herdr 0.8.0-preview.2026-08-04-d78e3d3b5126`, protocol 19, `schema_version` 1, Windows 11 / Git Bash. These are things the socket client found once it was real code rather than a spike script.

### 12.1 An unknown `pane_id` in a subscription closes the connection

The spike subscribed to panes that existed. `yan wait` cannot promise that: `run/meta.json` holds the pane a shift was dispatched into, and between the agent dying and the shift clocking out that id names a pane the server no longer has.

Asked about one, the server does **not** answer `{"id":…,"error":…}`. It closes the connection:

```
-> {"id":"yan:1","method":"events.subscribe","params":{"subscriptions":[
     {"type":"pane.agent_status_changed","pane_id":"w1:p1"},      <- real
     {"type":"pane.agent_status_changed","pane_id":"w9:p99"}]}}   <- never existed
<- (connection closed, no response)
```

The valid pane in the same request loses its subscription too, because the subscription lives on the connection that just went away. Repeated once per turn of a watcher's loop — which is what a naive "subscribe to every live shift" does — this is an event stream that is never up for more than one interval.

**Consequence, and it is a constraint on Phase 6's design rather than a note:** `yan wait` subscribes only to panes the current `agent list` snapshot shows, and re-checks that before adding a pane. The subscription set is therefore always a subset of what Herdr knows, and a stale id in `run/meta.json` costs that one shift its event source (it keeps `run/signal` and the liveness poll, which is what reports it dead a moment later) instead of costing every shift the connection.

### 12.2 The pipe-name rule works from a compiled client

Confirmed end to end, outside the spike: `defaultEndpoint()` resolved
`%APPDATA%\herdr\herdr.sock` to `\.\pipe\C:\Users\…\AppData\Roaming\herdr\herdr.sock`, connected, subscribed to a live pane and received `subscription_started`, with no `HERDR_*` variable set by the caller. [§11.1](#111-there-is-no-cli-for-eventssubscribe-the-transport-is-a-named-pipe) holds.

---

## 13. Measured in Phase 8.5: the Codex binding

Against `codex-cli 0.147.0` and `herdr 0.8.0-preview` with the codex detection manifest `2026.08.09.1`. Phase 8.5 exists because the Codex binding had been described in five documents and never run; this section is what running it found.

### 13.1 `.codex/hooks.json` was refused, and had been for eight phases

```
$ codex exec --sandbox read-only "reply with the single word OK"
warning: failed to parse hooks config C:\workspace\project\Yan\.codex\hooks.json:
         unknown field `version`, expected `description` or `hooks` at line 2 column 11
hook: SessionStart
hook: SessionStart Completed
```

**Note the wording: codex WARNS and carries on.** It does not refuse to start. The one `SessionStart` that ran was Herdr's own, from `~/.codex/hooks.json`; yan's never ran at all, so `yan session-start` was never called and the turn-end guard was never called. Nothing was ever going to be noisy about it.

The accepted shape is the one `herdr integration install codex` writes, which is also `.claude/settings.json`'s: `hooks` → event → **matcher group** → `hooks[]` → `{type, command: <string>, timeout: <seconds>}`. Four mismatches, all schema: a top-level `version`, the missing group level, `command` as an array, `timeout_ms`.

**A fifth was not schema and would have bitten next.** The command read `${CODEX_PROJECT_DIR:-.}/bin/yan`. There is no `CODEX_PROJECT_DIR` — not in the binary's strings, not in a hook's environment.

### 13.2 What a hook command actually runs in

Measured by putting three spellings of one variable into a hook command and reading back which survived:

```
"command": "node …/probe.mjs $YAN_HOME %YAN_HOME% $env:YAN_HOME"
→ argv ["…", "%YAN_HOME%"]           parent process: powershell.exe
```

| | |
| --- | --- |
| the shell | **PowerShell** on Windows: `$YAN_HOME` and `$CODEX_PROJECT_DIR` were consumed as undefined PS variables, `%YAN_HOME%` survived literally, `$env:YAN_HOME` expanded |
| cwd | the project root |
| environment | inherited from the codex process — `YAN_HOME`, `HERDR_PANE_ID` and the rest were all present |

**And `bash` is not a safe word to write.** On the plain Windows PATH `bash` resolves to `C:\Users\…\AppData\Local\Microsoft\WindowsApps\bash.exe` — the **WSL launcher** — and `sh` does not resolve at all. Which one a hook gets therefore depends on how codex was started: launched from Git Bash it inherits a PATH where `bash` is MINGW64's; launched by `agent start` into a Herdr pane it does not. A `bash -c '…'` form also failed to survive PowerShell's native-argument quoting, where a bare `bash <script>` did.

So yan's codex hooks name `node` and address `dist/` relative to cwd. There is no shell in between, `node` is unambiguous on both runtimes, and yan already requires it.

### 13.3 Which of Codex's prompts Herdr recognises

The counterpart of [§11.3](#113-which-prompts-herdr-recognises), which was all Claude. Driven one prompt at a time in an unfocused pane, `agent get` and `agent explain` read together.

| what was on screen | `agent_status` | rule | woke `yan`? |
| --- | --- | --- | --- |
| **trust — *"Do you trust the contents of this directory?"*** | **`blocked`** | `trust_directory` (950) | yes, correctly |
| command approval — *"Would you like to run the following command?"* | **`blocked`** | `osc_title_blocked` (1100) | yes, correctly |
| **hook review — *"Hooks need review · 2 hooks are new or changed"*** | **`idle`** | **none** — `default_known_agent_idle_fallback` | **no** |

The hook-review miss has two causes and both are worth knowing, because either alone would be enough:

1. it appears **before** codex sets the `Action Required` OSC title that `osc_title_blocked` matches — during it `pane get` reports no `terminal_title` at all;
2. its footer reads *"press enter to confirm or esc to **go back**"*, while `live_strong_blocker` matches *"press enter to confirm or esc to **cancel**"*. One word.

**This miss is strictly worse than Claude's.** §11.3's plan-approval miss landed on `done`, which supervision.md §3 already maps to a wake — the reason was degraded, not the wake. This one lands on `idle`, which is not actionable at all, so a shift parks in an unfocused pane and nothing ever wakes.

### 13.4 The two first-run gates, in a pool worktree

`agent start --kind codex` into `~/.yan-trees/yan-e2e-sandbox-fb72217b/1/yan-e2e-sandbox` — the path a shift actually gets, not a trusted repo directory.

**It did not exit.** `agent start` reported `interactive_ready: true`, and a minute later `agent get` still found the agent: codex was **parked on the trust dialog**, which is a different failure from the one [§11.7](#117-agent-start---kind-codex) recorded and rules out that section's guess about alternate-screen rows. What §11.7 saw was codex exiting; what a pool worktree produces is codex waiting.

```
> You are in C:\Users\libod\.yan-trees\yan-e2e-sandbox-fb72217b\1\yan-e2e-sandbox
  Note: You are in a subdirectory of a Git project. Trusting will apply to the
        repository root: C:\workspace\project\Yan\repos\yan-e2e-sandbox
  Do you trust the contents of this directory? …
```

Three things follow, and the first is the answer to the question the phase asked:

1. **Trust is NOT inherited by subdirectories.** `[projects.'c:\users\libod'] trust_level = "trusted"` was already recorded, and `~/.yan-trees` is underneath it; the prompt appeared anyway.
2. **It is recorded against the git root, which for a pool worktree is the MAIN CLONE.** Answering wrote `[projects.'c:\workspace\project\yan\repos\yan-e2e-sandbox']`. So one answer covers every slot of that repository, for good — and codex will read that clone's project-local config, which yan otherwise only ever fetches into.
3. **`--dangerously-bypass-approvals-and-sandbox` does not cover it.** Measured: started with exactly the argv `yan shift new` passes, codex still parked on the trust dialog. No flag covers it; only a config override could.

The second gate is [§13.3](#133-which-of-codexs-prompts-herdr-recognises)'s hook review. `--dangerously-bypass-hook-trust` clears it — measured, codex reached its prompt in `$YAN_HOME` with the review skipped. Codex records hook trust **by file and hash** (`[hooks.state.'…\hooks.json:session_start:0:0'] trusted_hash = "sha256:…"`), so a Herdr integration upgrade that rewrites `~/.codex/hooks.json` re-arms it.

### 13.5 The binding, run once end to end

With the file fixed and `--dangerously-bypass-hook-trust`, against a fixture `$YAN_HOME` holding one live shift:

| | |
| --- | --- |
| `SessionStart` | `hook: SessionStart Completed` — `yan session-start` really ran and rebuilt the picture |
| `Stop` | `hook: Stop` → **codex honoured `{"decision":"block"}` and continued the turn** |
| the budget | `run/guard-failures` reached **2**, so the guard blocked twice and would have failed open at 3 |
| the checkpoint | `yan wait --seconds 5` exited **124** on a quiet slice with a shift still live |

The blocking Stop contract for Codex is therefore no longer written from documentation.

**One defect the run exposed.** The guard's reason told the model to run bare `yan wait --seconds ${YAN_CODEX_CHECKPOINT:-180}`. `yan` is not on `PATH` in an agent's pane, and the pane's shell is PowerShell, which reads `${VAR:-default}` as a parse error rather than a default. The model dutifully ran `yan drain` and reported *"The term 'yan' is not recognized"*. Everything else yan writes for an agent to run names `$YAN_HOME/bin/yan` absolutely — a shift's brief already did — and this one line did not.

### 13.6 Can Codex be a shift agent?

**As the main agent, yes.** `yan continue --agent codex` runs in a pane `user` is looking at, so both gates are answerable by the person sitting there, once.

**As a shift agent, not unattended, and not by default.** The trust gate is survivable — Herdr calls it `blocked`, supervision escalates, `user` answers once per repository. The hook-review gate is not: Herdr calls it `idle`, so a shift parks silently and no wake ever comes. It can only be armed by the target repository shipping `.codex/hooks.json` or by the global file changing, which makes it rare and therefore worse — it will not show up in testing and will show up eventually.

`--dangerously-bypass-hook-trust` removes it, **and `shift new` passes it**. `user` took that decision after the measurement, knowing what it buys and what it costs: a shift that never parks silently, at the price of hooks shipped by the target repository running without review. It is passed for `scout` too — the flag is about not parking, and a scout is exactly as unattended; what contains a scout is `--sandbox read-only`.

What would make this go away without that decision is one line in Herdr's codex manifest — a rule matching `Hooks need review`, or widening `live_strong_blocker` to `esc to go back`. That is an upstream fix, not a yan one, and until it lands `yan doctor` reports the gate instead.
