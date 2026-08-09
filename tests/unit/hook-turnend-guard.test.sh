#!/usr/bin/env bash
#
# Phase 8 Trace bullets 2 and 3: the turn-end guard.
#
#   Claude   block when there is still supervision responsibility AND the
#            watcher is not healthy. Its own count in run/guard-failures, reset
#            when the watcher is healthy again. Budget 3, then fail open.
#            It does NOT read stdin and does NOT treat stop_hook_active as a
#            one-shot unblock - Claude sets that true after asyncRewake
#            continuations too, which is exactly the turn that needs a new
#            watcher armed (td supervision.md).
#   Codex    the primary predicate is remaining responsibility, because between
#            checkpoint slices there is no long-lived wait process to be
#            healthy. stop_hook_active may be a one-shot here. Same budget.
#
# The 800 ms settle is injected down to 50 ms: it is there so the guard does
# not false-alarm while autoarm is still claiming the lock, and nothing about
# it needs to be slow to be tested.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

# The Codex branch reads stdin, and tests/run.sh runs each test file with its
# own stdin still attached to the pipe the runner is reading test paths from.
# A hook that read that pipe would eat the rest of the test run. Every child
# here starts from /dev/null; the two cases that need a payload pipe one in.
exec </dev/null

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

home=$tmp/home
mk_yan_home "$home"
YAN_HOME=$home
export YAN_HOME
export YAN_GUARD_SETTLE=0.05

guard=$home/bin/hook-turnend-guard.sh

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t1 'supervision'
run=$home/tasks/t1/shifts/s1/run
taskrun=$home/tasks/t1/run
lock=$taskrun/wait.lock
beacon=$taskrun/beacon
failures=$taskrun/guard-failures

live_shift() {
	mkdir -p "$run"
	printf '{ "version": 1, "pane": "%%7" }\n' >"$run/meta.json"
}
healthy_watcher() {
	mkdir -p "$lock" "$taskrun"
	printf '%s\n' "$$" >"$lock/pid"
	printf 'yan-wait t1\n' >"$lock/identity"
	printf '%s %s t1\n' "$(date +%s)" "$$" >"$beacon"
}
no_watcher() { rm -rf -- "$lock" "$beacon"; }
count() {
	if [ -f "$failures" ]; then
		tr -dc '0-9' <"$failures"
	else
		printf '0'
	fi
}

# --- arguments --------------------------------------------------------------

capture env YAN_TASK=t1 bash "$guard"
assert_eq 2 "$rc" 'the guard has to be told which harness it is'
assert_contains "$out" '--claude or --codex'

# --- nothing to supervise: both harnesses let the turn end ------------------

no_watcher
rm -rf -- "$run"
mkdir -p "$taskrun"
printf '2\n' >"$failures"
capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 0 "$rc"
assert_file_missing "$failures" 'the budget starts over when the work is done'

printf '2\n' >"$failures"
capture env YAN_TASK=t1 bash "$guard" --codex
assert_eq 0 "$rc"
assert_eq '' "$out" 'allowing is silent'
assert_file_missing "$failures"

# A guard that cannot tell whose turn this is must not hold it hostage.
capture env -u YAN_TASK bash "$guard" --claude
assert_eq 0 "$rc"
capture env YAN_TASK=no-such-task bash "$guard" --claude
assert_eq 0 "$rc"

# --- Claude: responsibility remains and nobody is on duty -------------------

live_shift
no_watcher
rm -f -- "$failures"

capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 2 "$rc" 'exit 2 is how a Claude Stop hook blocks'
assert_contains "$out" 'no healthy watcher'
assert_eq 1 "$(count)"

capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 2 "$rc"
assert_eq 2 "$(count)"

capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 2 "$rc"
assert_eq 3 "$(count)"

# Budget spent: fail open, loudly. A guard that can wedge a session forever is
# worse than no guard.
capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 0 "$rc" 'after three blocked attempts the guard fails open'
assert_contains "$out" 'AUTOMATIC SUPERVISION IS BROKEN'
assert_contains "$out" 'yan ls t1'

# --- Claude: a healthy watcher is the whole point ---------------------------
#
# Ending a turn while shifts are live is fine when autoarm is holding yan wait.

healthy_watcher
capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 0 "$rc"
assert_file_missing "$failures" 'the count resets when the watcher is healthy again'

# A live watcher pid that has stopped looping is not a healthy watcher.
printf '%s %s t1\n' "$(($(date +%s) - 4000))" "$$" >"$beacon"
capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 2 "$rc" 'a stale beacon blocks even when the watcher pid is alive'
assert_contains "$out" 'beacon'
rm -f -- "$failures"

# A beacon left behind by a watcher that is gone is not a watcher either.
no_watcher
printf '%s %s t1\n' "$(date +%s)" "$$" >"$beacon"
capture env YAN_TASK=t1 bash "$guard" --claude
assert_eq 2 "$rc" 'a fresh leftover beacon blocks when the lock is missing'
rm -f -- "$failures"

# --- Claude: the 800 ms settle ----------------------------------------------
#
# Both Stop hooks fire concurrently, so the guard can easily ask "is the lock
# taken?" while autoarm is still claiming it. Here autoarm is late and the
# guard, watching the window, sees it and lets the turn through. The window is
# generous because starting a bash process on Windows is not instant and the
# point being tested is the wait, not the clock.

no_watcher
(
	sleep 1.5
	mkdir -p "$lock"
	printf '%s\n' "$$" >"$lock/pid"
	printf 'yan-wait t1\n' >"$lock/identity"
) &
late=$!
capture env YAN_TASK=t1 YAN_GUARD_SETTLE=6 bash "$guard" --claude
wait "$late" 2>/dev/null || true
assert_eq 0 "$rc" 'the guard must not false-alarm while autoarm is claiming the lock'
assert_file_missing "$failures"

# The second look asks only about the LOCK: a watcher that has just claimed it
# has not necessarily written its first beacon.
assert_file_missing "$beacon"

# --- Claude: stop_hook_active is NOT a one-shot unblock ---------------------
#
# Claude sets it true after asyncRewake continuations too. A guard that trusted
# it would let through exactly the turn that needs a new watcher armed.

no_watcher
rm -f -- "$failures"
out=$(printf '{"stop_hook_active":true,"session_id":"x"}' |
	env YAN_TASK=t1 bash "$guard" --claude 2>&1) && rc=0 || rc=$?
assert_eq 2 "$rc" 'the Claude guard must not accept stop_hook_active as a one-shot'
assert_eq 1 "$(count)"

# --- Codex: responsibility is the primary predicate -------------------------
#
# Not "autoarm lock plus fresh beacon": there is no autoarm on Codex and no
# long-lived wait process between slices, so a missing lock is normal.

no_watcher
rm -f -- "$failures"
capture env YAN_TASK=t1 bash "$guard" --codex
assert_eq 0 "$rc" 'Codex is told no through the decision, not the exit code'
assert_eq block "$(printf '%s' "$out" | jq -r '.decision' | tr -d '\r')"
assert_contains "$out" 'yan wait --seconds'
assert_eq 1 "$(count)"

# A healthy watcher does not excuse the Codex model from its checkpoint loop:
# responsibility is what the guard asks about.
healthy_watcher
capture env YAN_TASK=t1 bash "$guard" --codex
assert_eq block "$(printf '%s' "$out" | jq -r '.decision' | tr -d '\r')"
assert_eq 2 "$(count)"
no_watcher

# Codex may use stop_hook_active as a one-shot: its continuation model does not
# have Claude's asyncRewake blind spot.
out=$(printf '{"stop_hook_active":true}' | env YAN_TASK=t1 bash "$guard" --codex 2>&1) && rc=0 || rc=$?
assert_eq 0 "$rc"
assert_eq '' "$out" 'a one-shot allow is silent'
assert_eq 2 "$(count)" 'and it does not spend the budget'

# The shared budget of 3, then fail open.
printf '3\n' >"$failures"
capture env YAN_TASK=t1 bash "$guard" --codex
assert_eq 0 "$rc"
assert_contains "$out" 'AUTOMATIC SUPERVISION IS BROKEN'
assert_not_contains "$out" '"decision"'

printf 'ok\n'
