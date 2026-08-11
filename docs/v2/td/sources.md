# Herdr: authoritative sources

> Where every Herdr claim in these documents comes from, in order of authority, with the command to regenerate it. Herdr ships on a preview channel, so a claim without a source is a claim that will quietly rot.

---

## 1. Order of authority

| Rank | Source | Covers | How to get it |
| --- | --- | --- | --- |
| 1 | **the installed binary** | command syntax, flags, enums | `herdr <group> --help`, `herdr <group> <cmd> --help` |
| 2 | **the bundled API schema** | request/response shapes, event kinds, every `$def` | `herdr api schema --json` |
| 3 | **the agent skill file** | the intended usage protocol, ids, safety rules | `herdr --skill` |
| 4 | [`herdr.dev/docs/agent-automation/`](https://herdr.dev/docs/agent-automation/) | the CLI and socket API as a whole | web |
| 5 | [`herdr.dev/docs/agents/`](https://herdr.dev/docs/agents/) | how agent status detection actually works | web |
| 6 | [`herdr.dev/docs/integrations/`](https://herdr.dev/docs/integrations/) · [`/docs/session-state/`](https://herdr.dev/docs/session-state/) · [`/docs/install/`](https://herdr.dev/docs/install/) | integrations, persistence, install | web |
| 7 | [`github.com/herdrdev/herdr`](https://github.com/herdrdev/herdr) | source, issues, releases | web |

`herdr --skill` states the rule directly: *"The installed binary is the authority for command syntax."* Ranks 1–3 are therefore version-exact and always win over the website. The website wins on *behaviour* — how detection works, what a state means — which `--help` does not explain.

**Pinned for this design:** `herdr 0.8.0-preview.2026-08-04-d78e3d3b5126`, protocol 19, `schema_version` 1. Everything measured is in [`evidence.md`](evidence.md).

---

## 2. How to re-verify after a Herdr upgrade

```bash
herdr --version                       # compare with the pin above
herdr api schema --json > new.json    # diff protocol / schema_version / the enums yan depends on
herdr --skill                         # diff the usage protocol
herdr integration status              # see §4
```

`yan doctor` automates the first two ([runtime.md §4](runtime.md#4-types-come-from-the-outside-authorities)). The other two are a human's job at upgrade time, and [`evidence.md §9`](evidence.md#9-read-from-the-schema-not-exercised) is the checklist to run them against.

---

## 3. Two rules for citing Herdr in this repository

1. **Never assert Herdr behaviour without a source.** Either it is in [`evidence.md`](evidence.md) because it was measured, or it carries a link to one of the ranks above. A third category — "it seemed to work once" — is what produced the MVP's pane-hash heuristic.
2. **Never assert on a message string.** Herdr's prose is a preview build's prose. Assert on `error.code`, on enum values, on `protocol`. This is also [conventions §5](../plan/conventions.md#5-tests).

---

## 4. What only the website says

Three facts shape the V2 design and appear in **none** of `--help`, the schema, or `--skill`. They are recorded here because they are the easiest things to lose.

### 4.1 Detection has two mechanisms, and yan's agents get the weaker one

Per [`/docs/agents/`](https://herdr.dev/docs/agents/):

| Mechanism | When | Quality |
| --- | --- | --- |
| **lifecycle hooks** — the integration reports state | the integration hooks prompt / tool-use / permission / stop events | *"the integration becomes the sole authority for state classification"* |
| **screen manifest** — TOML rules matched against the live bottom-buffer snapshot, plus terminal title and OSC progress | otherwise | heuristic |

Blocked detection is deliberately strict: *"Herdr only marks `blocked` when the live bottom-buffer snapshot matches known visible approval, question, or permission UI"*, and *"new agent prompts may initially show as `idle` until manifests learn the UI pattern."*

**The trap.** It is natural to read "install the integration → hook-authoritative", and for `yan`'s two agents that is **false**. Both integrations at v7 report *session identity only* — verified by reading the installed hooks ([evidence §8](evidence.md#8-integration-status)):

```
~/.claude/hooks/herdr-agent-state.ps1    49 lines, SessionStart only, calls report-agent-session
~/.codex/herdr-agent-state.ps1           47 lines, SessionStart only, calls report-agent-session
```

Neither calls `pane report-agent --state`. The website's per-agent descriptions say the same thing once read closely: Claude Code *"reports Claude Code session identity… on session start"*, Codex *"reports session identity via socket API"* — whereas Devin *"reports native session identity from Devin session, prompt, tool-use, permission, and stop events"* ([`/docs/integrations/`](https://herdr.dev/docs/integrations/)). Only the last shape is the authoritative one.

**Consequence for `yan`:** `blocked` and `done` for a shift are screen matches, always. Keep `run/signal` ([supervision.md §4](supervision.md#4-what-survives-from-the-mvp)), keep the `yan doctor` check (for the session id, and because integration versions change), and do not let any document claim supervision is authoritative because an integration is installed.

### 4.2 An unlearned prompt shows as `idle`, not `blocked`

*"New agent prompts may initially show as `idle` until manifests learn the UI pattern."*

This is a **false negative in the most important wake source**, and it is the strongest single argument for keeping `run/signal` and `yan report`: a shift that says it is blocked is believed regardless of whether Herdr recognised the dialog. [supervision.md §4](supervision.md#4-what-survives-from-the-mvp) keeps that channel; this is why it is not redundant.

It also sets a precondition on the Phase 5 spike: install the integration first, or the spike measures the fallback rather than the design.

### 4.3 A nested tmux breaks screen detection

*"Screen detection fails if agents run inside tmux launched within Herdr panes."*

Recorded for completeness, and never a V2 design constraint — V2 has no tmux, so the configuration cannot arise. While both backends existed it was reachable by exactly one route, a person typing `tmux attach` inside a Herdr pane to look at tmux-backed shifts, and `yan` never created it: the tmux container was detached and invisible to Herdr. Phase 9 deleted the last tmux, so the route is closed and the one bullet [conventions §6](../plan/conventions.md#6-working-with-herdr-from-a-test-or-a-script) carried about it went with it.

It is kept here rather than deleted because this section is the record of **what only the website says**, and a fact that stops applying to us does not stop being a fact about Herdr. If yan ever grows a reason to run something inside a pane's shell, this is the constraint that was already known.

---

## 5. Smaller facts worth keeping

| Fact | Source |
| --- | --- |
| `agent wait` *"returns immediately if its status already matches"* | [`/docs/agent-automation/`](https://herdr.dev/docs/agent-automation/) — matters: it is a state check, not an edge trigger |
| `pane read --source recent` defaults to the latest 80 rows; `--lines` changes it | [`/docs/agent-automation/`](https://herdr.dev/docs/agent-automation/) |
| `--regex` is Rust regular-expression syntax | `pane wait-output --help` |
| the docs site makes **no** API stability or versioning promise | absence in [`/docs/agent-automation/`](https://herdr.dev/docs/agent-automation/) — which is why types are generated and `yan doctor` checks `protocol` |
| detection is automatic for ~18 named agent CLIs; `agent start --kind` accepts 21 | [`/docs/agents/`](https://herdr.dev/docs/agents/) vs `agent start --help` — the two lists are not identical, so do not derive one from the other |
