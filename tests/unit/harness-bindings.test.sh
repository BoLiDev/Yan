#!/usr/bin/env bash
#
# Phase 8 Trace bullets 2 and 3: what each harness is actually told to run.
#
#   Claude   SessionStart -> `yan session-start`
#            Stop         -> hook-autoarm.sh, asyncRewake, a long timeout
#            Stop         -> hook-turnend-guard.sh --claude, blocking
#   Codex    SessionStart -> `yan session-start`
#            Stop         -> hook-turnend-guard.sh --codex
#            and NO autoarm: Codex parses `async` but does not run
#            asynchronous command hooks, so it cannot hold a multi-hour watcher
#
# The Codex file is written from the documented shape and has NOT been run
# against a real codex - it is not installed on the machine this was written
# on. This test says what the file claims, which is the part that can be
# checked here; that it is the right shape is stated as unverified in the PR.
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

# --- Codex ------------------------------------------------------------------

body=$(tr -d '\r' <"$codex")
assert_contains "$body" 'session-start'
assert_contains "$body" 'hook-turnend-guard.sh'
assert_contains "$body" '--codex'

# The one thing that must not be there.
assert_not_contains "$body" 'hook-autoarm' \
	'Codex has no autoarm: it cannot hold a multi-hour watcher'
assert_not_contains "$body" 'asyncRewake'
assert_not_contains "$body" 'yan wait' \
	'the Codex checkpoint loop is the model, not a hook'

assert_eq 'command' "$(jqr "$codex" '.hooks.Stop[].type')"

printf 'ok\n'
