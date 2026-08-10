# The terminal seam: Herdr

> This document replaces the Herdr half of [td §5.7](../../mvp/td/agents.md#57-terminal-topology). The seam is still seven functions and still the only place a multiplexer command may appear. What changes is which multiplexer, and what the seam is now able to promise.
> Everything asserted here was measured against `herdr 0.8.0-preview.2026-08-04-d78e3d3b5126`, protocol 19. The measurements are in [`evidence.md`](evidence.md).

---

## 1. Topology

The MVP's concept table survives; only the middle row moves.

| Concept | tmux (MVP) | Herdr (V2) |
| --- | --- | --- |
| the `task` container | session | **workspace** |
| one agent | window | **pane** |
| a terminal | pane | pane |

Herdr's tab sits between workspace and pane, and `yan` does not use it as a level of its own: one tab per workspace, panes split inside it. The MVP's argument against giving each sub-agent its own workspace still holds, and Herdr's own guidance now agrees with it — *"Default to a sibling pane in the current tab… Do not create a workspace, tab, worktree, or different cwd unless the user explicitly requests that topology"* (`herdr --skill`; see [sources.md](sources.md) for why that file outranks the website on protocol).

Container lifetime is unchanged: `user` opens and closes it. `yan` never closes a workspace, a tab, or a pane it did not create.

---

## 2. The seven functions

| Function | Herdr | Note |
| --- | --- | --- |
| `term_container_create` | `workspace create` → `.result.workspace` / `.tab` / `.root_pane` | only when `user` asks for a new workspace; normally `yan` joins the one it is already in |
| `term_agent_start` | `pane split --direction right --cwd <leased tree> --no-focus --env …` → `agent start <name> --kind <k> --pane <id> -- <argv>` → **confirm** | **three steps.** `agent start` requires an existing pane already at an interactive prompt and never creates layout. `--direction` is required, not optional. The confirm step is not optional either — see below |
| `term_send` | `agent prompt <target> <text> [--wait]` | atomic: text and Enter in one submission, honouring the pane's live bracketed-paste mode |
| `term_read` | `agent read <target> --source <s> --lines N` | `s ∈ visible \| recent \| recent-unwrapped \| detection`; use `recent-unwrapped` for transcripts |
| `term_agent_alive` | `agent get` + `pane get` — see [§5](#5-alive-dead-unknown) | the one function that needs more than a single call |
| `term_agent_close` | `pane close <pane_id>` | closes exactly the recorded pane |
| `term_list` | `agent list` / `pane list` | returns names, states, pane ids, and the agent's own session id |

Three things `term_agent_start` gains that are worth naming, because each deletes MVP code:

1. **It waits for Herdr to detect the agent before returning** (default 30 s, max 300 s) — which is better than the MVP sending keys and hoping, but is **not proof the agent is up**. Measured: `agent start --kind codex` returned `interactive_ready: true` in 3.1 s for a `codex` that had already exited, because screen detection matched the bare PowerShell prompt it left behind; `agent get` said `agent_not_found` a minute later, and the `agent prompt` in between typed the brief **into PowerShell** ([evidence §11.7](evidence.md#117-agent-start---kind-codex)). So `startAgent` confirms afterwards and reports failure if the agent is not there, and **nothing is sent to a pane that has not just been confirmed alive**.

   **Neither guard is a fix for that codex.** Detection is screen-based, so a second look a millisecond later can be wrong in exactly the same way. What they catch is the case where the agent is already visibly gone — cheap, and worth having. Why codex exits at once is still open ([evidence §11.7](evidence.md#117-agent-start---kind-codex)) and a guard is not an answer to it.
2. **Arguments are an argv array, not a command line.** `agent start … -- --append-system-prompt "…"` echoes back `argv: ["claude","--append-system-prompt","…"]`. No shell in between, so no quoting layer.
3. **`--env KEY=VALUE` on `pane split`** carries `YAN_TASK`, `YAN_TASK_DIR` and friends into the shift's environment without a wrapper script.

Herdr recognises 21 agent kinds, including `claude` and `codex`. `conf/config.json`'s `agents.shift` maps onto `--kind` plus trailing argv.

---

## 3. Identifiers

**The MVP's rule 1 — a label is not a source of truth; record the id — is unchanged and is now easier to obey.**

| | Example | Promise |
| --- | --- | --- |
| workspace | `w1`, `wF` | opaque, stable |
| tab | `w1:t1` | opaque, stable, **never reused after close** |
| pane | `w1:p1`, `wF:p3` | opaque, stable, never reused after close |

**These are examples, not a format.** `herdr --skill` calls them *"opaque stable handles"* and means it: the suffix is not a decimal counter, and a session that has opened enough workspaces hands out `wA`, `wF` and so on ([evidence §11](evidence.md#11-the-phase-5-event-spike) shows `wF:p2`). Never parse an id, never sort by one, never generate one, never assume its length. Store what Herdr returned and pass it back.
| agent name | `[a-z][a-z0-9_-]{0,31}` | **unique among live agents**; cleared when the agent exits, is released, or is replaced |

The agent name is the one genuinely new handle. tmux window names are not unique, which is why the MVP banned name lookup outright; Herdr enforces uniqueness, so a name *is* addressable. `yan` still records ids in `run/meta.json` and still addresses by id, for one reason: a name is only unique among *live* agents, so it cannot identify a shift that has died — and identifying dead shifts is precisely what supervision does.

**Two traps, both must be handled explicitly:**

- **`pane move` changes the pane id.** A pane moved into another workspace gets a new workspace-qualified id. The response carries `.result.move_result.pane.pane_id` (new) and `.previous_pane_id` (old). `yan` never moves panes itself, but `user` can, so `run/meta.json` must be reconcilable — see [§5](#5-alive-dead-unknown).
- **`--current` is unavailable to hooks.** It resolves through `HERDR_PANE_ID`, and a hook may be handed a sanitised environment. `yan` therefore never passes `--current`; it always passes an explicit id, which is the rule it already followed.

---

## 4. Talking to Herdr

The CLI is the transport. It does not require `HERDR_ENV`, `HERDR_SOCKET_PATH` or `HERDR_PANE_ID` to be set — with all three stripped, `herdr pane list` still answers, finding the default socket itself ([evidence.md §1](evidence.md#1-environment-independence)). The `HERDR_ENV=1` check in `herdr --skill` is a behavioural convention for agents, not a runtime gate. **This is what makes the hook path safe**, and it must be re-verified whenever Herdr is upgraded.

Responses are JSON on stdout. Errors are JSON on **stderr** with a stable `code`:

```json
{"error":{"code":"agent_not_found","message":"agent target yanprobe not found"},"id":"cli:agent:get"}
```

| Exit status | Meaning |
| --- | --- |
| 0 | success (some mutating commands succeed silently with no stdout at all) |
| 1 | server error — parse `error.code` |
| 2 | CLI syntax error — a bug in `yan`, never a runtime condition |

The seam maps `error.code` to `yan`'s own vocabulary and never lets a Herdr code escape upward. That is [td §4.3 rule 1](../../mvp/td/architecture.md#43-seams) applied unchanged.

---

## 5. Alive, dead, unknown

`term_agent_alive` still returns exactly three words. Deriving them takes two calls, and this is the one place where the MVP's optimism about Herdr needs correcting.

[td §5.7](../../mvp/td/agents.md#57-terminal-topology) predicted that Herdr *"cleanly separates 'the pane is there but the agent died' from 'the pane is gone' from 'alive'"*. It does — but not from a single call. `agent get` answers `agent_not_found` **both** when the agent died and when it never existed. The distinction lives one level down:

```
agent get <name|pane_id>
  ok                      → alive
  agent_not_found         → pane get <recorded pane_id>
                              pane exists, no agent → dead
                              pane_not_found        → dead      (the pane was closed)
                              transport failure     → unknown
transport failure         → unknown
```

`unknown` is reserved for "`yan` could not find out", never for "`yan` found out something confusing". A Herdr server that is down produces `unknown`; a closed pane produces `dead`. This preserves [td §4.3 rule 2](../../mvp/td/architecture.md#43-seams): the seam reports facts and decides nothing.

**Reconcile.** When `agent get` by recorded pane id fails but an agent with the recorded *name* is alive at a different pane id, `user` moved the pane. The seam reports the new id; the subcommand rewrites `run/meta.json`. The seam does not write bookkeeping ([rule 3](../../mvp/td/architecture.md#43-seams)).

---

## 6. Agent lifecycle states

This is what Herdr has and tmux does not, and it is the reason the supervision design changes. Definitions below are Herdr's, from [`/docs/agents/`](https://herdr.dev/docs/agents/) and `herdr --skill`; the enum itself is `AgentStatus` in `herdr api schema --json`.

| State | Herdr's definition | What `yan` does with it |
| --- | --- | --- |
| `working` | the agent is mid-turn | nothing; this is the normal case |
| `idle` | ready for input, **and** its tab has been seen in the focused UI | nothing |
| `done` | the same underlying idle state, after **unseen** background work finished | a shift finished something while `user` was not looking → wake `yan` |
| `blocked` | Herdr recognised an approval or question UI | escalate: this is a `needs-decision` that the shift did not have to remember to report |
| `unknown` | an agent is present but Herdr cannot classify it confidently | **not** a completion signal; treat as no information |

`done` versus `idle` turns on whether the tab has been *seen*. Focusing it marks it seen; a CLI read does not. That is exactly the semantics `yan` wants — "there is something here you have not looked at" — and `yan` must therefore keep reading with `agent read` and never with `agent focus`, or it will mark its own escalations as seen.

`blocked` is the single most valuable state in this document. [supervision.md](../../mvp/td/supervision.md) records that forgetting to report is the most common agent failure; `blocked` is an external observation of exactly that failure, so it no longer depends on the shift's cooperation.

### How reliable this is

Less than the state table suggests, and the gap is exactly where `yan` lives. Herdr classifies state two ways ([`/docs/agents/`](https://herdr.dev/docs/agents/)):

| | When | Quality |
| --- | --- | --- |
| lifecycle hooks | the agent's integration reports state | *"the integration becomes the sole authority for state classification"* |
| screen manifest | otherwise | TOML rules matched against the bottom-buffer snapshot — a heuristic |

**For Claude Code and Codex it is always the second row.** Their integrations at version 7 install session-identity reporting only: a ~48-line PowerShell hook registered on `SessionStart` alone, calling `pane report-agent-session` and never `pane report-agent --state` ([evidence §8](evidence.md#8-integration-status)). Installing the integration buys the `agent_session` uuid ([§7](#7-two-operational-facts-that-constrain-the-design)); it does not upgrade state detection. Integrations that *do* hook prompt, tool-use, permission and stop events exist — Devin's is one ([`/docs/integrations/`](https://herdr.dev/docs/integrations/)) — just not for the two agents `yan` dispatches.

So `blocked` for a `yan` shift is a screen match, and Herdr is deliberately conservative about it: it *"only marks `blocked` when the live bottom-buffer snapshot matches known visible approval, question, or permission UI"*, and *"new agent prompts may initially show as `idle` until manifests learn the UI pattern"*.

Three consequences, all binding:

1. **A missed `blocked` is a false negative, not a wrong answer.** That is why `run/signal` stays ([supervision.md §4](supervision.md#4-what-survives-from-the-mvp)). It is not a legacy channel; it is the half of the pair that does not depend on pattern matching.
2. **`yan doctor` still checks `herdr integration status`** for every kind in `conf/config.json`'s `agents.*` — for the session id, and because a future integration version may start reporting state. It must not claim that installing it makes supervision authoritative.
3. **There is a way to become authoritative, and it is `yan`'s own.** `pane report-agent --state` is public API, and `pane release-agent` is described as releasing *"pane agent lifecycle authority"* — so a reporter appears to claim that authority. `yan report` could push the shift's state into Herdr and stop competing with screen matching. That is attractive and it is **not decided here**: claiming authority also switches Herdr's own detection off, so a `yan` that reports only at `yan report` moments could end up blinder than one that lets Herdr guess. Phase 5 measures it before anyone commits.

---

## 7. Two operational facts that constrain the design

**The pane's default shell on Windows is PowerShell, not Git Bash.** A bash-syntax command sent to a fresh pane fails with a PowerShell parser error. `herdr --default-config` exposes `default_shell` (empty means `$SHELL`, then `/bin/sh`) and `shell_mode`. Consequences:

- The main path is unaffected: `agent start` launches the agent executable directly, with no shell in between.
- Anything `yan` runs *through* a pane shell must not assume bash. Prefer `agent start`-style direct execution; where a shell is unavoidable, `yan doctor` checks that `default_shell` is set to a known shell and refuses to guess.

**Herdr knows each pane's agent session id — when the integration is installed.** `pane list` returns `agent_session: {kind:"id", source:"herdr:claude", value:"<uuid>"}`, and that uuid is the agent CLI's own session identifier.

It arrives via the same lifecycle-hook integration as the state machine: per [`/docs/integrations/`](https://herdr.dev/docs/integrations/), the Claude hook *"reports Claude Code session identity to the local Herdr socket on session start"*, and the other 15 integrations do the equivalent. So this is **not** unconditional — `agent_session` is absent for an agent whose integration is missing, which is the second reason `yan doctor` checks `integration status` ([§6](#how-reliable-this-is)).

`yan` records it in `run/meta.json` next to the pane id, treating absence as normal rather than as an error. No V2 behaviour is specified on top of it yet — it is recorded because it is free, it is otherwise underivable, and resuming or reading a dead shift's transcript is the obvious next thing someone will want.

---

## 8. Retiring tmux

tmux is not deleted when the Herdr implementation is written. It is deleted when the Herdr implementation **passes the same assertions** ([runtime.md §6](runtime.md#6-tests)).

Not the same *file*: `tests/unit/lib-term-contract.test.sh` is bash and cannot exercise a TypeScript module. Its assertions are ported to vitest and run against Herdr, while the bash original keeps running against tmux until Phase 9. What is shared is the contract, not the runner — and that is the whole point of having written the contract down.

Keeping both alive costs nothing during the migration — the seam is already two-backend by construction — and it is the only way to tell a Herdr implementation that is correct from one that merely runs.

**The two backends do not interact.** `term_container_create` makes a *detached* tmux session (`lib-term.sh:301`), so tmux-backed shifts live on the tmux server and are invisible to Herdr — there is nothing for Herdr to misread. The one way to create a nested pane is for a person to type `tmux attach` inside a Herdr pane, which is a habit rather than a code path; `yan continue` only ever prints that command as a suggestion (`yan-continue.sh:244`) and never runs it. It is noted in [conventions §6](../plan/conventions.md#6-working-with-herdr-from-a-test-or-a-script) and nowhere else. Once Herdr is green on the ported contract test, the tmux implementation, the `backend` config key, and its fail-closed branches in `lib-boot`, `lib-term` and `yan-state` all go in one commit.

The seam itself stays. It is seven functions, it cost almost nothing, and it is the reason this pivot is a phase rather than a rewrite.
