#!/usr/bin/env bash
#
# Phase 8 Trace bullet 2: Claude's Stop autoarm runs the long `yan wait` IN THE
# HOOK'S FOREGROUND - never `&` - and turns an event into a rewake.
#
# The "never background" half is asserted by reading the file, because it
# cannot be observed from the outside: a hook that backgrounds its watcher
# still exits 0 and still looks fine. What it actually does is hand a process
# to nobody - the harness no longer owns the process group, so the watcher
# outlives the session that armed it and the single-flight lock is held by a
# process the next session cannot see (td supervision.md, architecture.md §6).
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

YAN_HOME=$home
export YAN_HOME
export YAN_STUB_TERM_DIR=$tmp/term
export YAN_STUB_TERM_ALIVE=alive
# Keep the watcher this hook starts short and cheap. The hook itself passes no
# --seconds; these only change how often it looks and how patient it is.
export YAN_WAIT_INTERVAL=0.1
export YAN_WAIT_STUCK=3600

autoarm=$home/bin/hook-autoarm.sh

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t1 'supervision'
run=$home/tasks/t1/shifts/s1/run
taskrun=$home/tasks/t1/run
wake=$taskrun/wake
lock=$taskrun/wait.lock

live_shift() {
	mkdir -p "$run"
	printf '{ "version": 1, "pane": "%%7" }\n' >"$run/meta.json"
}

# --- the file itself: never `&`, never a detached watcher -------------------

grep -v '^[[:space:]]*#' "$YAN_REPO_ROOT/bin/hook-autoarm.sh" >"$tmp/body"
body=$(cat "$tmp/body")
for forbidden in nohup setsid disown 'bg ' '&!'; do
	assert_not_contains "$body" "$forbidden" 'autoarm must not detach the watcher'
done
# A line ending in a single `&` is the backgrounding one. `>&2` and `&&` are
# not, so the needle is "an & at the end of a line that is not part of &&".
capture grep -nE '[^&]&[[:space:]]*$' "$tmp/body"
assert_ne 0 "$rc" 'autoarm must run yan wait in its own foreground'

# It is the LONG shape. A checkpoint slice is the Codex path, and a hook that
# armed one would report "nothing happened" every three minutes.
assert_not_contains "$body" '--seconds' 'autoarm arms the long shape'

# --- nothing to supervise ---------------------------------------------------

rm -rf -- "$run" "$taskrun"
capture env YAN_TASK=t1 bash "$autoarm"
assert_eq 0 "$rc" 'no live shift means nothing to arm'
assert_file_missing "$lock" 'and no lock is taken for hours over nothing'

# No task at all: a hook that cannot tell whose supervision this is gets out of
# the way rather than failing and blocking the turn.
capture env -u YAN_TASK bash "$autoarm"
assert_eq 0 "$rc"
capture env YAN_TASK=no-such-task bash "$autoarm"
assert_eq 0 "$rc"

# --- an event becomes a rewake ----------------------------------------------

live_shift
touch "$run/signal"
capture env YAN_TASK=t1 bash "$autoarm"
assert_eq 2 "$rc" 'exit 2 is what makes Claude rewake yan'
assert_contains "$out" 'signal: s1'
assert_contains "$out" 'yan drain'
assert_contains "$(cat "$wake")" 'signal: s1' \
	'the reason has to survive until the model drains it'

# The watcher ran in this hook's process tree and is gone with it: the lock it
# took was released on the way out.
assert_file_missing "$lock"

# --- somebody is already on duty --------------------------------------------
#
# Every Stop can fire autoarm, so this is the normal case, not an error. The
# hook must not start a second watcher and must not disturb the first.

rm -f -- "$wake"
live_shift
touch "$run/signal"
mkdir -p "$lock"
printf '%s\n' "$$" >"$lock/pid"
printf 'yan-wait t1\n' >"$lock/identity"

capture env YAN_TASK=t1 bash "$autoarm"
assert_eq 0 "$rc" 'a second watcher is not armed while one is on duty'
assert_file_missing "$wake" 'and the hook did not look at anything itself'
assert_file_exists "$run/signal" 'the event is left for the watcher that is on duty'
assert_eq "$$" "$(tr -d ' \r\n' <"$lock/pid")"

printf 'ok\n'
