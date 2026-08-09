#!/usr/bin/env bash
#
# Phase 5 Trace bullet 2: every line in run/status is an EVENT, and
# `yan state` does NOT treat tail -1 as the current state.
#
# The status file below is built so that its last line is a trap: it says
# `done`, with a note nobody could produce by accident. Each case then puts the
# live sources - the terminal and the forge - somewhere else entirely and
# requires `yan state` to report what they say. If the answer ever comes back
# `done`, or the trap note ever appears in the output, this command has started
# reading the event stream as a state.
#
# The seams are swapped by dropping the stand-ins into the throwaway home's own
# bin/. YAN_LIB would be the usual way, but it is directory-wide and this
# subcommand sources five libraries: pointing it at tests/stub would take
# lib-task, lib-shift and lib-json away with the seams. The home already holds
# a copy of bin/, so overwriting two files in it swaps exactly two seams.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

home=$tmp/home
mk_yan_home "$home"
cp "$YAN_REPO_ROOT/tests/stub/lib-term.sh" "$home/bin/lib-term.sh"
cp "$YAN_REPO_ROOT/tests/stub/lib-forge.sh" "$home/bin/lib-forge.sh"

YAN_HOME=$home
export YAN_HOME
export YAN_STUB_TERM_DIR=$tmp/term
export YAN_STUB_FORGE_DIR=$tmp/forge
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth

run=$home/tasks/t042/shifts/s1/run
mkdir -p "$run"

MR=https://forge.invalid/acme/widget/-/merge_requests/1
TRAP_NOTE='LAST-LINE-IS-NOT-THE-STATE'

cat >"$run/meta.json" <<JSON
{ "version": 1,
  "unit": "auth",
  "branch": "yan/t042/s1",
  "tree": "",
  "agent": "claude",
  "window": "@3",
  "pane": "%7",
  "mr": "$MR" }
JSON

# The trap: the newest event says `done`.
{
	printf '2026-08-09T09:00:00Z\tstarted\tread the brief\n'
	printf '2026-08-09T10:00:00Z\tblocked\twaiting for a credential\n'
	printf '2026-08-09T11:00:00Z\tdone\t%s\n' "$TRAP_NOTE"
} >"$run/status"

state_of() { # <sid> ... -> the verdict alone
	bash "$yan" state "$@" --verdict
}

# --- alive agent, merge request still open: running, never `done` ----------

export YAN_STUB_TERM_ALIVE=alive
export YAN_STUB_FORGE_MR_STATES=open

capture state_of s1
assert_eq 0 "$rc" "$out"
assert_eq running "$out" 'the terminal is the source, not the last event'

capture bash "$yan" state s1
assert_eq 0 "$rc"
assert_contains "$out" 'state      running'
assert_not_contains "$out" "$TRAP_NOTE" 'the newest event must not be surfaced as the state'
assert_not_contains "$out" 'state      done'
assert_contains "$out" 'events     3' 'run/status is counted and nothing else'
assert_contains "$out" 'EVENTS, not the state'

# --- the same file, a dead agent -------------------------------------------

export YAN_STUB_TERM_ALIVE=dead
capture state_of s1
assert_eq dead "$out" 'a dead terminal outranks a `done` event'

# --- the forge says merged: the shift is finished whatever the pane says ----

export YAN_STUB_TERM_ALIVE=alive
export YAN_STUB_FORGE_MR_STATES=merged
rm -rf "$tmp/forge"
capture state_of s1
assert_eq merged "$out" 'the objective end condition is the MR, not the event stream'

# The forge really was asked, in yan vocabulary and with the recorded MR.
assert_contains "$(cat "$tmp/forge/calls")" "mr_state mr=$MR"

# --- an unreachable / unanswerable source is said out loud -----------------

export YAN_STUB_TERM_ALIVE=unknown
export YAN_STUB_FORGE_MR_STATES=unknown
rm -rf "$tmp/forge"
capture state_of s1
assert_eq unknown "$out" 'where nothing can be established, say unknown'

# --- run/meta.json is read defensively -------------------------------------

export YAN_STUB_TERM_ALIVE=alive
export YAN_STUB_FORGE_MR_STATES=open
rm -rf "$tmp/forge"

# Phase 7 owns this file; today it may be partial, absent, or half written.
printf '{ "version": 1, "unit": "auth" }\n' >"$run/meta.json"
capture bash "$yan" state s1
assert_eq 0 "$rc" "a partial meta.json must not crash: $out"
assert_contains "$out" 'state      unknown'
assert_contains "$out" 'no terminal id'
assert_contains "$out" 'no merge request recorded'

printf 'not json at all\n' >"$run/meta.json"
capture bash "$yan" state s1
assert_eq 0 "$rc" "an unreadable meta.json must not crash: $out"
assert_contains "$out" 'state      unknown'

rm -f "$run/meta.json"
capture bash "$yan" state s1
assert_eq 0 "$rc" "a missing meta.json must not crash: $out"
assert_contains "$out" 'state      unknown'
assert_contains "$out" 'events     3' 'the events are still counted'

# --- run/ gone means clocked out -------------------------------------------

rm -rf "$run"
capture state_of s1
assert_eq clocked-out "$out" 'clocking out deletes run/ whole, so its absence is the fact'

# --- machine readable, same derivation -------------------------------------

mkdir -p "$run"
printf '2026-08-09T11:00:00Z\tdone\t%s\n' "$TRAP_NOTE" >"$run/status"
printf '{ "version": 1, "unit": "auth", "pane": "%%7" }\n' >"$run/meta.json"
capture bash "$yan" state s1 --json
assert_eq 0 "$rc" "$out"
assert_eq running "$(printf '%s' "$out" | jq -r .state)"
assert_eq 1 "$(printf '%s' "$out" | jq -r .events)"
assert_eq alive "$(printf '%s' "$out" | jq -r .terminal)"

# --- usage ------------------------------------------------------------------

capture bash "$yan" state
assert_eq 2 "$rc" 'a shift id is required'
capture bash "$yan" state s1 --json --verdict
assert_eq 2 "$rc" '--json and --verdict are alternatives'
capture bash "$yan" state nosuchshift
assert_eq 1 "$rc" 'a shift that does not exist is a real error'

printf 'ok\n'
