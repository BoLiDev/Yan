#!/usr/bin/env bash
#
# Phase 8 Trace bullet 4: the single-flight lock, the wake file and the beacon
# behave as td supervision.md describes - and a second `yan wait` does not
# start while a healthy one is running.
#
# Under Claude every Stop can fire autoarm, so without the lock a busy session
# ends up with several watchers, each hashing the same panes and each able to
# wake the model for the same fact.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

tmp=$(mktemp -d)
watcher=

cleanup() {
	if [ -n "$watcher" ]; then
		kill -TERM "$watcher" 2>/dev/null || true
		wait "$watcher" 2>/dev/null || true
	fi
	rm -rf "$tmp"
}
trap cleanup EXIT

home=$tmp/home
mk_yan_home "$home"
cp "$YAN_REPO_ROOT/tests/stub/lib-term.sh" "$home/bin/lib-term.sh"

YAN_HOME=$home
export YAN_HOME
export YAN_STUB_TERM_DIR=$tmp/term
export YAN_STUB_TERM_ALIVE=alive
export YAN_TASK=t1
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t1 'supervision'
run=$home/tasks/t1/shifts/s1/run
mkdir -p "$run"
cat >"$run/meta.json" <<'JSON'
{ "version": 1, "sid": "s1", "unit": "u", "branch": "yan/t1/s1", "tree": "",
  "agent": "claude", "window": "@3", "pane": "%7", "mr": "" }
JSON

taskrun=$home/tasks/t1/run
lock=$taskrun/wait.lock
beacon=$taskrun/beacon

# wait_until <deciseconds> <command...>
wait_until() {
	local budget=$1 waited=0
	shift
	while [ "$waited" -lt "$budget" ]; do
		if "$@" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1 2>/dev/null || sleep 1
		waited=$((waited + 1))
	done
	return 1
}

# --- one long watcher, running in this test's foreground process tree -------

"$yan" wait --interval 0.1 --stuck 3600 >"$tmp/watcher.out" 2>&1 &
watcher=$!

assert_ok wait_until 100 test -d "$lock"
assert_ok wait_until 100 test -f "$beacon"

# The lock records the yan process, not a transient subshell (lib-lock records
# $$, and bash reports the shell's own pid inside a command substitution).
owner=$(tr -d ' \r\n' <"$lock/pid")
assert_eq "$watcher" "$owner" 'the single-flight lock is owned by the yan process'
assert_eq "yan-wait t1" "$(tr -d '\r' <"$lock/identity")" \
	'the lock says what it is for, so tasks/<id>/.enter.lock cannot be mistaken for a watcher'

# The beacon is attendance for the WATCHER: it carries the moment of the last
# loop and the pid that wrote it, so neither half can vouch for the other.
beacon_pid=$(awk '{ print $2 }' <"$beacon" | tr -d '\r')
assert_eq "$watcher" "$beacon_pid" 'the beacon belongs to the process holding the lock'

stamp=$(awk '{ print $1 }' <"$beacon" | tr -d '\r')
now=$(date +%s)
if [ "$((now - stamp))" -gt 60 ]; then
	printf 'the beacon is already stale: %ss\n' "$((now - stamp))" >&2
	exit 1
fi

# It keeps being rewritten. A live pid alone does not prove a watcher is still
# looping, which is the whole reason the beacon exists.
first=$(cat "$beacon")
beacon_moved() { [ "$(cat "$beacon")" != "$first" ]; }
assert_ok wait_until 100 beacon_moved

# --- a second watcher does not start ----------------------------------------

capture "$yan" wait --seconds 5 --interval 0.1
assert_eq 4 "$rc" 'a second yan wait must refuse while a healthy one runs'
assert_contains "$out" 'already on duty'

capture "$yan" wait --interval 0.1
assert_eq 4 "$rc" 'the long shape refuses too'

# The refusal changed nothing: the first watcher still holds the lock.
assert_eq "$watcher" "$(tr -d ' \r\n' <"$lock/pid")"

# --- it holds no durable state of its own -----------------------------------
#
# Killing the watcher must lose nothing: the lock goes with it, and the next
# watcher starts clean.

kill -TERM "$watcher"
wait "$watcher" 2>/dev/null || true
watcher=

assert_ok wait_until 100 test ! -d "$lock"
assert_file_missing "$taskrun/wake" 'a watcher that was killed woke nobody'

# And the way back in is open: with the lock gone, a new watcher starts and
# sees the same world.
touch "$run/signal"
capture "$yan" wait --seconds 5 --interval 0.1
assert_eq 0 "$rc"
assert_contains "$out" 'signal: s1'

# --- a stale lock does not block for ever -----------------------------------
#
# lib-lock reclaims a lock whose owner is gone. Supervision inherits that: a
# machine that lost power mid-watch is not a machine that needs a manual rm.

rm -f -- "$taskrun/wake"
mkdir -p "$lock"
printf '999999\n' >"$lock/pid"
printf 'yan-wait t1\n' >"$lock/identity"
touch "$run/signal"
capture "$yan" wait --seconds 5 --interval 0.1
assert_eq 0 "$rc" 'a lock left behind by a dead process is reclaimed, not obeyed'
assert_contains "$out" 'signal: s1'

printf 'ok\n'
