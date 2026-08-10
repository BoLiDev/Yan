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

Also observed: `codex` is not on `PATH` here. `agent start --kind <k>` resolves a canonical executable, so Phase 5 needs to confirm how Herdr finds an agent binary that a shell cannot.

---

## 9. Read from the schema, not exercised

Everything in this section is **design input, not measurement**. It comes from `herdr api schema --json` (261 KB) and `herdr <group> --help`.

| Capability | Status | Where it is relied on |
| --- | --- | --- |
| `events.subscribe` — `EventsSubscribeParams`, `EventEnvelope`, `Subscription` | schema only | [supervision.md §2](supervision.md#2-the-shape-of-yan-wait) — **the largest subtraction in V2 depends on it** |
| `SubscriptionEventKind` = `pane.output_matched`, `pane.agent_status_changed`, `pane.scroll_changed` | schema only | supervision.md §3 |
| `EventKind` — 26 kinds incl. `pane_exited`, `pane_agent_detected` | schema only | supervision.md §3 |
| `agent wait --until <state> --timeout` | help text only | supervision.md §2 |
| `blocked` firing on real Claude / Codex approval UIs | **not observed** | terminal.md §6, supervision.md §3 |
| `done` vs `idle` seen-semantics | documented in `--skill`, not exercised | supervision.md §3 |
| `--kind codex` | not tried | the Codex binding |
| `agent explain` | not tried | possible `yan doctor` aid |
| `--remote <ssh-target>` | not tried | out of V2 scope |
| Herdr on Linux / WSL | not tried | [conventions](../plan/conventions.md) claims two platforms |
| `default_shell` actually switching the pane shell | config read, not set | terminal.md §7 |

The first four rows are why [supervision.md §6](supervision.md#6-what-must-be-proven-first) makes Phase 5 a spike, and why no MVP supervision code may be deleted before it passes.

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
