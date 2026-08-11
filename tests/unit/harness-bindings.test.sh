#!/usr/bin/env bash
#
# What each harness is actually told to run.
#
#   Claude   SessionStart -> `yan session-start`
#            Stop         -> hook-autoarm.sh, asyncRewake, a long timeout
#            Stop         -> hook-turnend-guard.sh --claude, blocking
#   Codex    SessionStart -> `yan session-start`
#            Stop         -> the turn-end guard, --codex
#            and NO autoarm: Codex parses `async` but does not run
#            asynchronous command hooks, so it cannot hold a multi-hour watcher
#
# ---------------------------------------------------------------------------
# WHY THE CODEX HALF IS NOW STRUCTURAL
# ---------------------------------------------------------------------------
#
# It used to grep the file's body, and said so: "the Codex file is written from
# the documented shape and has NOT been run against a real codex - it is not
# installed on the machine this was written on." A body grep passes on a file
# codex refuses to parse, which is exactly what happened - for eight phases the
# checked-in file was rejected at startup with
#
#   unknown field `version`, expected `description` or `hooks`
#
# and nothing noticed, because `session-start` and `--codex` were both present
# in the text. So this asserts the SHAPE codex parses, the same way the Claude
# half does: the nesting level, the string-valued `command`, `timeout` in
# seconds, and the absence of the keys codex rejects.
#
# The shape is not derived from documentation. It is the one `herdr integration
# install codex` writes to ~/.codex/hooks.json, which is also the one
# .claude/settings.json uses, and it was confirmed by running codex.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"

claude=$YAN_REPO_ROOT/.claude/settings.json
codex=$YAN_REPO_ROOT/.codex/hooks.json

assert_file_exists "$claude"
assert_file_exists "$codex"

# jq directly, so conventions §2.3 applies: jq.exe on Git Bash hands back CRLF
# and every comparison against a literal would fail on one platform only.
jqr() { # jqr <file> <filter>
	jq -r "$2" "$1" | tr -d '\r'
}

assert_ok jq -e . "$claude"
assert_ok jq -e . "$codex"

# --- Claude -----------------------------------------------------------------

assert_contains "$(jqr "$claude" '.hooks.SessionStart[].hooks[].command')" 'session-start' \
	'SessionStart nudges the rebuild, not a wait'
assert_not_contains "$(jqr "$claude" '.hooks.SessionStart[].hooks[].command')" 'wait' \
	'SessionStart is seconds-scale; it does NOT run yan wait --seconds'

stop=$(jqr "$claude" '.hooks.Stop[].hooks[] | "\(.command)|\(.asyncRewake)|\(.timeout)"')
assert_eq 2 "$(printf '%s\n' "$stop" | grep -c .)" 'Claude registers exactly two Stop hooks'

autoarm=$(printf '%s\n' "$stop" | grep 'hook-autoarm' || true)
assert_contains "$autoarm" 'hook-autoarm.sh'
assert_contains "$autoarm" '|true|' 'autoarm is the asyncRewake hook'
timeout=${autoarm##*|}
assert_eq 1 "$((timeout >= 28800))" \
	'autoarm needs a long timeout - eight hours is the workable default'

guard=$(printf '%s\n' "$stop" | grep 'hook-turnend-guard' || true)
assert_contains "$guard" '--claude'
assert_not_contains "$guard" '|true|' 'the guard blocks; it is not an async hook'

# --- Codex: the shape codex parses ------------------------------------------
#
# Three keys codex REJECTS the whole file for. Each one was in the checked-in
# file, and each one is the sort of thing a body grep cannot see.

assert_eq null "$(jqr "$codex" '.version')" \
	'there is no top-level `version`: codex refuses the file for it'
assert_eq 0 "$(jqr "$codex" '[.. | objects | select(has("timeout_ms"))] | length')" \
	'`timeout` in seconds, never `timeout_ms`'
assert_eq 0 "$(jqr "$codex" '[.hooks[][].hooks[] | select(.command | type != "string")] | length')" \
	'`command` is a string; an array is refused'

# The nesting level Claude also has: event -> matcher group -> hooks[].
assert_eq 1 "$(jqr "$codex" '.hooks.SessionStart | length')"
assert_eq 1 "$(jqr "$codex" '.hooks.SessionStart[].hooks | length')"
assert_eq 1 "$(jqr "$codex" '.hooks.Stop | length')"
assert_eq 1 "$(jqr "$codex" '.hooks.Stop[].hooks | length')" \
	'Codex registers exactly one Stop hook - the guard, and no autoarm'

# --- Codex: what those hooks run --------------------------------------------

for event in SessionStart Stop; do
	assert_eq command "$(jqr "$codex" ".hooks.${event}[].hooks[].type")"
	t=$(jqr "$codex" ".hooks.${event}[].hooks[].timeout")
	assert_eq 1 "$((t > 0 && t <= 3600))" \
		"$event's timeout is a number of SECONDS, so it has to look like one: got $t"
done

start=$(jqr "$codex" '.hooks.SessionStart[].hooks[].command')
assert_contains "$start" 'session-start'
assert_not_contains "$start" 'wait' \
	'SessionStart is seconds-scale; it does NOT run yan wait --seconds'

stopcmd=$(jqr "$codex" '.hooks.Stop[].hooks[].command')
assert_contains "$stopcmd" 'turnend-guard'
assert_contains "$stopcmd" '--codex'

# NO SHELL, and this is the measured part rather than a style choice. Codex
# hands the command string to the platform shell, which on Windows is
# PowerShell - and on the Windows PATH `bash` resolves to the WSL launcher
# (WindowsApps\bash.exe) while `sh` does not resolve at all. A hook that names
# either would reach the wrong interpreter or none. `node` is unambiguous, and
# yan already requires it.
assert_eq 0 "$(jqr "$codex" '[.hooks[][].hooks[].command | select(startswith("node ") | not)] | length')" \
	'every codex hook command starts the interpreter directly: no shell in between'
for cmd in "$start" "$stopcmd"; do
	assert_not_contains "$cmd" '$' 'no shell expansion: codex would hand it to PowerShell'
	assert_not_contains "$cmd" '%' 'no cmd.exe expansion either'
	assert_contains "$cmd" './dist/' \
		'cwd-relative, because yan starts the main agent with cwd=$YAN_HOME'
done

# The one thing that must not be there.
body=$(tr -d '\r' <"$codex")
assert_not_contains "$body" 'hook-autoarm' \
	'Codex has no autoarm: it cannot hold a multi-hour watcher'
assert_not_contains "$body" 'asyncRewake'
assert_not_contains "$body" 'yan wait' \
	'the Codex checkpoint loop is the model, not a hook'

printf 'ok\n'
