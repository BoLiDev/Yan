# What the Claude Code CLI lets its host know and do

Research for ticket #104 (map #101). It states mechanisms and their limits; it
chooses no design.

Sources: the official Claude Code documentation at `code.claude.com/docs`
(fetched as Markdown on 2026-11-28) and `claude --help` of Claude Code
**2.1.332** on the machine this was written on. Each claim names the page it
comes from; the pages are listed at the end. Two things were observed rather
than read, and are marked *(observed)*.

## Short answer

- A session has an id the host can **choose** (`--session-id <uuid>`) or
  **learn** (every hook payload, the status line payload, the
  `CLAUDE_CODE_SESSION_ID` environment variable of every Bash call, hook and
  stdio MCP server). The id is not the process: `/clear`, `/branch` and
  `/resume` change it inside one running `claude`.
- **Hooks are the documented, structured feed of what a session does.** They
  carry the session id, fire for subagents too, and can be delivered as an
  HTTP POST straight to a host's server. `PostToolUse` reports each file
  written by `Write`/`Edit` exactly; files changed through Bash are reported
  only best-effort; there is no "commit made" event.
- **A skill reaches the host most simply by having Claude run a host command
  in Bash**, which already has the session id in its environment. The other
  routes are an MCP tool the host serves, hooks the skill declares in its own
  frontmatter, and files the host watches.
- The transcript holds everything but its format is **explicitly internal and
  unstable**. OpenTelemetry is the only place a commit's SHA is reported as a
  field. Stream-json is complete and structured but exists only without the
  terminal UI (`-p`), which is the mode v2 has ruled out.

## 1. Session identity

| Fact | Source |
| :- | :- |
| `--session-id <uuid>` starts a conversation under an id the caller picks; it must be a valid UUID. | cli-reference, `claude --help` |
| `--resume <id \| name \| absolute transcript path>` resumes; `--continue` takes the most recent conversation in the current directory; `--fork-session` with either gives the copy a new id. | sessions, cli-reference |
| `--resume <id>` is found from any directory: the current project and its worktrees first, then every other project on the machine if exactly one holds it. | sessions |
| `-n/--name` names a session; `--resume <name>` finds it within the repository and its worktrees. A `SessionStart` or `UserPromptSubmit` hook can also set the title (`sessionTitle`). | sessions, hooks |
| `/clear` starts a new session id in the same process (the old one is saved). `/branch` copies the transcript and switches the process to the copy. `/resume` switches to another session. | sessions, env-vars |
| `SessionStart` fires for each of these with `source` = `startup`, `resume`, `clear`, `compact` or `fork`; `SessionEnd` fires with `reason` = `clear`, `resume`, `logout`, `prompt_input_exit`, `other`. | hooks |
| `--continue` skips sessions made by `claude -p` or the Agent SDK, and sessions whose first prompt was `/loop`; `--resume <id>` still opens them. | sessions |
| Resuming does **not** restore `--settings`, `--plugin-dir`, `--mcp-config`, `--add-dir`, tool flags; they must be passed again. | sessions |
| Two processes resuming the same session both write one transcript and messages can go missing. | sessions |
| An interactive `claude` started from inside a Claude Code Bash call, hook or status line is left out of `--resume`/`--continue` (`CLAUDE_CODE_CHILD_SESSION`). | env-vars |

`CLAUDE_CODE_SESSION_ID` is set in Bash and PowerShell tool subprocesses, hook
commands and stdio MCP servers. In Bash and hooks it matches the hook
payload's `session_id` and follows `/clear`. A stdio MCP server keeps the id
it was spawned with, and after `--continue` or a bare `--resume` it "may
receive the initial startup ID instead" (env-vars). *(observed)*: a Bash tool
call on 2.1.332 has `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE=1` and
`CLAUDE_CODE_CHILD_SESSION=1` set.

A skill's body can contain `${CLAUDE_SESSION_ID}`, which is replaced by the
session id when the skill is loaded (skills).

## 2. Transcripts

- Stored as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where
  `<project>` is the working directory with every non-alphanumeric character
  made `-`; a name over 200 characters is cut and ended with a hash
  (sessions). `CLAUDE_CONFIG_DIR` moves the root;
  `CLAUDE_CODE_PROJECT_DIR_NAME` (with `CLAUDE_CONFIG_DIR`) lets a host that
  embeds Claude Code name the folder itself (sessions).
- A subagent's transcript is its own file under
  `<session-id>/subagents/agent-<agent id>.jsonl`; `SubagentStop` gives the
  path as `agent_transcript_path` (hooks).
- Every hook payload and the status line payload carry `transcript_path`, so
  the path never has to be derived (hooks, statusline).
- **Limit, stated by the docs:** "The entry format is internal to Claude Code
  and changes between versions, so scripts that parse these files directly can
  break on any release" (sessions). The supported ways to read a session are
  `/export`, `claude -p --resume <id> --output-format json "<question>"`, the
  hook and status line payloads, and the Agent SDK.
- The file is written asynchronously and "may lag the in-memory conversation";
  at `Stop` it is not guaranteed to hold the final message, which is why
  `Stop` carries `last_assistant_message` (hooks).
- Transcripts are deleted after 30 days by default (`cleanupPeriodDays`)
  (sessions).

## 3. Hooks

### Where a host can put them

Settings files, `--settings <file-or-json>` for one launch, a plugin's
`hooks/hooks.json` (registered when the session loads the plugin, including
one loaded with `--plugin-dir`), a skill's frontmatter and a subagent's
frontmatter (hooks, plugins/components). Entries from all sources merge.

Five handler types: `command` (JSON on stdin), `http` (JSON as a POST body to
a URL, with headers that may interpolate allow-listed environment variables),
`mcp_tool`, `prompt`, `agent` (hooks). A `command` hook may be `async: true`,
in which case it cannot block and its output reaches Claude on the next turn.

Hooks from settings and plugins "also run inside subagents"; their payload
then carries `agent_id` and `agent_type` (hooks).

### What every payload carries

`session_id`, `transcript_path`, `cwd`, `hook_event_name`, and where they
apply `prompt_id` (one per user prompt, the same as OpenTelemetry's
`prompt.id`), `permission_mode`, `effort`, `agent_id`, `agent_type`,
`scratchpad_dir` (hooks).

### What each event tells a host

| Event | Fields beyond the common ones | Notes |
| :- | :- | :- |
| `SessionStart` | `source`, optionally `model`, `agent_type`, `session_title` | Only `command` and `mcp_tool` handlers. Can return `additionalContext`, `sessionTitle`, `watchPaths`. |
| `UserPromptSubmit` | `prompt`, `session_title` | Also fires for turns Claude Code starts itself (scheduled tasks, a background subagent reporting back, a message from another session). 30 s default timeout. |
| `UserPromptExpansion` | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` | Fires when the user types `/skill-name`. This path does **not** go through the Skill tool. |
| `PreToolUse` / `PostToolUse` | `tool_name`, `tool_input`, `tool_use_id`; `PostToolUse` adds `tool_response`, `duration_ms` | `Write`/`Edit`/`Read` give an absolute `tool_input.file_path`. For `Write`, `tool_response` has `filePath` and `type` (`create`...). The `if` field filters by permission-rule syntax, such as `Bash(git commit *)` or `Edit(*.ts)`. |
| `PostToolUseFailure` | as above, with the error | |
| `PostToolBatch` | `tool_calls[]`, each with name, input, id, response | Once per batch of parallel calls. |
| `SubagentStart` | `agent_id`, `agent_type` | Also on a resumed subagent. |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message` | Also fires for Claude Code's internal agents (prompt suggestions, `/btw`) with an empty `agent_type`. |
| `Stop` | `last_assistant_message`, `stop_hook_active`, `background_tasks[]`, `session_crons[]` | "Does not run if the stoppage occurred due to a user interrupt." API errors fire `StopFailure` instead. `background_tasks` tells "done" from "waiting on background work". |
| `Notification` | the notification | Fires when Claude Code wants attention (permission prompt, idle). |
| `TaskCreated` / `TaskCompleted` | the task | Claude's own task list. |
| `FileChanged` | `file_path`, `event` | A filesystem watcher over files named in the matcher or returned as `watchPaths`; fires whatever changed the file. Watches named files, not directories or globs. |
| `CwdChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `ConfigChange`, `InstructionsLoaded`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `MessageDisplay`, `PreSkillShellCommand`, `TeammateIdle`, `DirectoryAdded`, `Setup` | see the reference | |
| `SessionEnd` | `reason` | Shared budget of **1.5 s** by default; output discarded. |

### Limits

- **Trust.** In an interactive session no settings hook runs, the user's own
  included, until the workspace trust dialog has been accepted for the folder
  (hooks, "Workspace trust").
- **Switches that silence them.** `--bare`, `--safe-mode`,
  `disableAllHooks`, and an organization's `allowManagedHooksOnly` (hooks,
  `claude --help`). `disableAllHooks` also disables the status line
  (statusline).
- **Failure is silent to the host.** A command hook that exits non-zero
  (other than 2), an HTTP hook that gets a non-2xx or no connection, are
  "non-blocking errors": the session goes on and nothing retries (hooks).
  A hook is a notification with no delivery guarantee.
- **Interrupts.** `Esc` cancels running `PostToolUse` hooks; `Stop` does not
  fire on an interrupt; a killed process fires nothing.
- **HTTP hooks** must answer 2xx with an empty body or a JSON object; plain
  text counts as an error (hooks).
- **`PostToolUse` matching `Edit|Write` does not fire when a Bash command
  rewrites the file** (hooks). See section 5.

## 4. Plugins, skills and what a skill can carry

- `--plugin-dir <path>` loads a plugin for one session; repeatable (cli-reference).
- A plugin can hold skills, agents, `hooks/hooks.json`, MCP servers
  (`.mcp.json`), executables in `bin/` (put on the `PATH` of the Bash tool
  while the plugin is enabled, after the user's own entries), monitors
  (`monitors/monitors.json`: a background shell command whose output lines
  reach Claude as notifications; interactive sessions only), channels, themes
  and output styles (plugins/components).
- A plugin's MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`; hook
  commands get `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`.
- A skill's frontmatter may declare `hooks`. They are registered when the
  skill is invoked and stay until the conversation is left (exit, `/clear`,
  `/resume`); `once: true` removes one after its first successful run (hooks,
  skills). So a skill can switch on reporting that is off until it runs.
- A skill with `context: fork` runs as a subagent (skills).
- **Mods** are plugins whose hooks are JavaScript functions running inside
  Claude Code. They can draw panes beside the transcript and a band above the
  prompt, add commands that run with no Claude turn, and observe or rewrite
  tool calls. What they draw appears in the terminal UI, the Desktop Code tab
  and the VS Code panel; under `-p` the hooks run and nothing is drawn
  (plugins/mods/overview). This is UI inside Claude Code's own terminal
  rendering, not in a host page.

### Knowing that a skill ran

| Signal | Covers | Source |
| :- | :- | :- |
| `UserPromptExpansion`, `command_name` | the user typing `/name` | hooks |
| `PreToolUse`/`PostToolUse` matching `Skill` | Claude invoking it; the tool's input names the skill (*observed*: the tool's parameters on 2.1.332 are `skill` and `args`; the hooks reference has no table for this tool) | hooks |
| OpenTelemetry `skill_activated` event | both, with `invocation_trigger` = `user-slash`, `claude-proactive` or `nested-skill` | monitoring-usage |
| The skill's own frontmatter hooks, or a command the skill tells Claude to run | whatever the skill author chooses | hooks, skills |

Nothing reports that a skill has **finished**: a skill is instructions Claude
reads, with no end event. A forked skill is the exception, since it ends with
`SubagentStop`.

## 5. What one session did

### Files written

| Mechanism | What it reports | Reliability |
| :- | :- | :- |
| `PostToolUse` on `Write`/`Edit` | absolute path, content or edit, per call, with `session_id` and `agent_id` | Exact for these tools, including in subagents. |
| `PostToolUse` on `Bash`, `tool_response.bashEditDiff` | `changedFiles` (up to 200 absolute paths), diffs for up to 5 | "Best effort and in public beta." Recorded only when the `bashEditDiffEnabled` setting turns it on (otherwise only in auto and bypass modes in some cases); needs a Git repository; skips ignored files and submodules; none for background commands; flags `shared` when another Bash call ran at the same time. Since v2.1.269. |
| `FileChanged` | a named file changed, by anything | Must name the files; no attribution to a tool call. |
| The docs' own suggestion: a `PostToolUse` hook with no matcher that runs `git status --porcelain` | whatever differs in the tree | Attributes to a session only if one session owns the tree. |
| Status line `cost.total_lines_added/removed`; OpenTelemetry `lines_of_code.count` | totals only | No paths. |
| Checkpoints (`/rewind`) | snapshots of files edited by the file tools | Not a documented interface; Bash-only changes and most subagent edits are not captured (checkpointing). |

### Commits

- There is **no hook event for a commit**. A `PostToolUse` hook with
  `if: "Bash(git commit *)"` sees the command and its response; the reference
  documents no SHA field in Bash's `tool_response`, so the hook would ask git
  itself (`git rev-parse HEAD` in the payload's `cwd`).
- OpenTelemetry's `tool_result` event, with `OTEL_LOG_TOOL_DETAILS=1`, carries
  `git_commit_id` and `git_branch` inside `tool_parameters`, and
  `vcs.ref.head.revision` / `vcs.ref.head.name`, for "a successful
  `git commit` run by the Bash or PowerShell tool" (since v2.1.269), with
  `session.id` and `tool_use_id` beside them (monitoring-usage). This is the
  only documented place the SHA appears as data.
- The metrics `claude_code.commit.count` and `claude_code.pull_request.count`
  count them per session without identifying them. The status line payload
  has `pr.number` and `pr.url` for the branch's open pull request.
- A commit made by a script Claude runs, rather than a literal `git commit`,
  is not covered by any of these statements.

### Subagents

`SubagentStart` / `SubagentStop` (id, type, own transcript path, final text);
`PreToolUse`/`PostToolUse` on the `Agent` tool in the parent; every tool hook
inside the subagent tagged with `agent_id`. The built-in web-fetch subagent
fires `Subagent*` hooks only from managed settings (hooks).

## 6. Status line

A command (`statusLine` in settings, so `--settings` can set it) run with JSON
on stdin: `session_id`, `session_name`, `prompt_id`, `transcript_path`,
`cwd`, `workspace.*` (project dir, added dirs, git worktree, repo
host/owner/name), `model`, `cost.*`, `context_window.*`, `rate_limits.*`,
`worktree.*`, `pr.*`, `version` (statusline). It runs at session start, on
each new assistant message, on mode changes, and on a `refreshInterval`
timer; updates are debounced at 300 ms and an in-flight run is cancelled by
the next. It is the only feed of context-window and cost figures to a process
outside Claude Code during an interactive session, short of OpenTelemetry.
There is one status line per session, so a host that sets it replaces the
user's own. It carries nothing about tool calls.

## 7. Headless (`-p`), stream-json and the Agent SDK

- `claude -p --output-format stream-json --verbose` prints one JSON object per
  line: a `system/init` event (model, tools, MCP servers, plugins and their
  load errors), every assistant and user message with its `tool_use` and
  `tool_result` blocks, subagent messages tagged with `parent_tool_use_id`
  (`--forward-subagent-text` adds their text), `result` messages with cost and
  `session_id`; `--include-hook-events` adds hook lifecycle events;
  `--include-partial-messages` adds token deltas; `--input-format stream-json`
  takes user messages on stdin (headless, cli-reference).
- These flags work **only with `--print`** (`claude --help`). An interactive
  session has no machine-readable output stream; its stdout is the terminal UI.
- The Agent SDK (TypeScript, Python) is "a library that runs the Claude Code
  binary" and gives the same messages as objects, plus callbacks for hooks and
  permissions (agent-sdk/overview). It has no terminal UI either.
- `claude -p --resume <id> --output-format json "<question>"` asks an existing
  session a question from outside and returns structured JSON (sessions). It
  appends to that session's transcript, and must not run while the session is
  live in another process (section 1).
- `-p` treats the folder as trusted and never shows the trust dialog (hooks).

## 8. MCP as a channel

- **Session to host.** A host can serve an MCP server (`--mcp-config`, a
  plugin's `.mcp.json`, stdio or HTTP) whose tools Claude calls with
  structured arguments; a skill can tell Claude to call one. A stdio server
  gets `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR` in its environment
  (with the caveat in section 1); the docs describe no session id sent to an
  HTTP server, so a host would put its own token in the URL or `headers` of
  the config it passes per launch (mcp, env-vars).
- An `mcp_tool` hook calls a tool on a configured server when an event fires,
  without the model deciding to (hooks).
- **Host to session: channels.** An MCP server that declares the
  `claude/channel` capability can push `notifications/claude/channel` events,
  which arrive in Claude's context as `<channel source="...">` and start work
  on the next turn. Limits: research preview; stdio only; every channel must
  be on an approved allowlist, and a custom one needs
  `--dangerously-load-development-channels`, which asks for confirmation each
  interactive launch and is ignored under `-p`; requires claude.ai or Console
  authentication; notifications are not acknowledged and are dropped silently
  when the channel is not registered (channels, channels-reference).
- **Host to session, without channels:** a hook's `additionalContext`
  (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, an async hook's result),
  a plugin monitor's output lines, and typing into the pty.

## 9. OpenTelemetry

Enabled by environment (`CLAUDE_CODE_ENABLE_TELEMETRY=1`,
`OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_ENDPOINT=...`), so a host can
set it per launch and receive OTLP on a local port. Events carry `session.id`
and `prompt.id`: `user_prompt`, `assistant_response`, `tool_result`
(`tool_name`, `tool_use_id`, success, duration), `tool_decision`,
`skill_activated`, `subagent_completed`, `hook_execution_*`, `compaction`,
and more (monitoring-usage).

Limits: names and arguments are redacted by default (a user's or third-party
plugin's skill shows as `custom_skill`, MCP tools as `mcp_tool`);
`OTEL_LOG_TOOL_DETAILS=1` reveals commands, file paths, skill names and the
commit SHA; `tool_input` is truncated (512 characters per value, about 4 K in
all). Export is batched (logs every 5 s by default). The host must speak
OTLP. A user who already exports telemetry elsewhere has one endpoint, which
the host's would replace.

## 10. Ways a skill inside the session can tell the host something

| Route | How | Carries the session id | Limits |
| :- | :- | :- | :- |
| A host command run by Claude in Bash | The skill's text says to run it; a plugin's `bin/` puts it on `PATH` | Yes, `CLAUDE_CODE_SESSION_ID` in the environment | The model must do it; subject to the permission mode. |
| A host MCP tool | The skill's text says to call it | Stdio: environment, with a caveat; HTTP: only what the host put in its config | The model must do it; the server must be passed again on resume. |
| Hooks in the skill's frontmatter | Registered when the skill is invoked; `command` or `http` | Yes, in the payload | Fire on tool events, not on "the skill decided X"; stay for the rest of the conversation unless `once`. |
| Host-wide hooks matching what the skill does | `PostToolUse` on `Write` under a known path, on `Skill`, `UserPromptExpansion` | Yes | Infers intent from behaviour. |
| Files at an agreed place | The skill writes; the host watches | Only if the path or content includes it (`${CLAUDE_SESSION_ID}` in the skill body, or the session's `scratchpad_dir`) | No event unless the host watches; Bash writes are invisible to `Write` hooks. |
| Dynamic context in the skill (`` !`command` ``) | A shell command run when the skill loads, before Claude sees it | Yes (a subprocess of the session) | Runs at load only; `PreSkillShellCommand` hooks can block it; can be disabled by `disableSkillShellExecution`. |

## 11. How v1 does it today

- `src/externals/harness/launch.ts` builds claude's argv: `--resume <id>` when
  there is a session to go on with, `--plugin-dir` for yan's skills,
  `--append-system-prompt`, `--add-dir`, and `--settings` with exactly two
  hooks, `UserPromptSubmit` and `Stop`, each a `yan vault pull|push --hook`
  command (`src/cli/shared/launch.ts`). The hooks sync the vault; they tell
  the page nothing about the session.
- `src/externals/harness/sessions.ts` finds the session to resume by
  **re-deriving** the transcript folder name from the working directory and
  taking the newest `<uuid>.jsonl` by modification time. It never passes
  `--session-id` and never reads a `session_id` from a hook.
- `src/cli/serve/` learns an agent's state (working, waiting) from what
  herdr says of the agent's pane (`agent-watch.ts`), not from Claude Code.
- The session tells yan things by running `yan` commands in Bash (`yan log`,
  `yan resource`, `yan branch`, ...), scoped by a `YAN_TASK` environment
  variable: the task is known, the session is not recorded.

## Sources

All under `https://code.claude.com/docs/en/`, fetched 2026-11-28:
`hooks`, `hooks-guide`, `sessions`, `cli-reference`, `headless`,
`statusline`, `skills`, `settings`, `env-vars`, `mcp`, `channels`,
`channels-reference`, `monitoring-usage`, `checkpointing`,
`plugins/components`, `plugins/mods/overview`, `agent-sdk/overview`,
`agent-sdk/sessions`, `agent-sdk/typescript`. Plus `claude --help` and
`claude --version` (2.1.332).

Not verified here: nothing was run to confirm payload shapes against a live
session beyond the environment check in section 1; the shapes are as the
reference documents them. Several features cited are marked by the docs as
beta or research preview (`bashEditDiff`, channels, traces) and may change.
