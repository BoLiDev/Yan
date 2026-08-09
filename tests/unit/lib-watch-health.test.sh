#!/usr/bin/env bash
#
# Phase 8 Trace bullet 4: "the watcher is healthy" means ALL of - the lock
# exists and its pid is alive, the identity matches, and the beacon is fresh
# (td supervision.md).
#
# BOTH DIRECTIONS ARE TESTED HERE, because each one on its own is a lie a
# session can run on for hours:
#
#   a live pid with a stale beacon   the watcher is there but has stopped
#                                    looping. A pid is not attendance
#   a fresh beacon with no lock      a file left behind by a watcher that is
#                                    gone. A timestamp is not a process
#
# No sleeping: the beacon carries its own epoch, so a stale one is written, not
# waited for.
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
YAN_HOME=$home
export YAN_HOME

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
# shellcheck source=bin/lib-watch.sh
. "$YAN_REPO_ROOT/bin/lib-watch.sh"

task_init t1 'supervision'

watch_use t1
assert_eq "$home/tasks/t1/run" "$WATCH_RUN"
assert_eq "$home/tasks/t1/run/wake" "$WATCH_WAKE" \
	'the wake file is the one yan drain already reads'
mkdir -p "$WATCH_RUN"

# The four supervision files all live beside each other under the TASK, because
# supervision is per-yan and a yan is per-task.
assert_eq "$WATCH_RUN/wait.lock" "$WATCH_LOCK"
assert_eq "$WATCH_RUN/beacon" "$WATCH_BEACON"
assert_eq "$WATCH_RUN/guard-failures" "$WATCH_GUARD"

fresh_beacon() { # fresh_beacon [pid]
	printf '%s %s t1\n' "$(date +%s)" "${1:-$$}" >"$WATCH_BEACON"
}
stale_beacon() { # stale_beacon [pid]
	printf '%s %s t1\n' "$(($(date +%s) - 4000))" "${1:-$$}" >"$WATCH_BEACON"
}
live_lock() {
	mkdir -p "$WATCH_LOCK"
	printf '%s\n' "$$" >"$WATCH_LOCK/pid"
	watch_identity >"$WATCH_LOCK/identity"
}
clear_all() { rm -rf -- "$WATCH_LOCK" "$WATCH_BEACON"; }

# --- nothing at all ---------------------------------------------------------

clear_all
assert_fail watch_healthy
assert_fail watch_lock_taken

# --- a lock whose owner is alive, but no beacon yet -------------------------
#
# watch_lock_taken says yes (that is the guard's 800 ms question, and a watcher
# that has just claimed the lock has not finished its first loop). watch_healthy
# says no.

clear_all
live_lock
assert_ok watch_lock_taken
assert_fail watch_healthy

# --- all three: healthy -----------------------------------------------------

fresh_beacon
assert_ok watch_healthy

# --- direction one: a live pid with a stale beacon --------------------------

# A stale beacon blocks even though the watcher pid is alive. (No message
# argument on assert_ok / assert_fail here or below: they pass their extra
# arguments to the command, and watch_healthy's first argument is the beacon
# age it is allowed to accept.)
stale_beacon
assert_fail watch_healthy
watch_healthy || true
assert_contains "$(watch_why)" 'beacon'

# The threshold is a parameter, and the default is 300s.
fresh_beacon
assert_ok watch_healthy
printf '%s %s t1\n' "$(($(date +%s) - 301))" "$$" >"$WATCH_BEACON"
assert_fail watch_healthy
assert_ok watch_healthy 400

# --- direction two: a fresh beacon with no lock -----------------------------

clear_all
fresh_beacon
# A leftover beacon must block when the lock is missing.
assert_fail watch_healthy
assert_fail watch_lock_taken

# ... with a lock whose owner is dead
live_lock
printf '999999\n' >"$WATCH_LOCK/pid"
fresh_beacon
# A lock whose owner is gone is not a watcher.
assert_fail watch_healthy

# ... with a lock that belongs to something else. tasks/<id>/.enter.lock is a
# real live lock in the same tree that has nothing to do with supervision.
live_lock
printf 'yan-continue t1\n' >"$WATCH_LOCK/identity"
fresh_beacon
# The identity has to match.
assert_fail watch_healthy
watch_healthy || true
assert_contains "$(watch_why)" 'yan-continue t1'

# ... and with a beacon written by somebody other than the lock holder
live_lock
fresh_beacon 424242
# The beacon must belong to the process holding the lock.
assert_fail watch_healthy

live_lock
fresh_beacon
assert_ok watch_healthy

# --- the guard's own count --------------------------------------------------

watch_guard_reset
assert_eq 0 "$(watch_guard_count)"
assert_eq 1 "$(watch_guard_bump)"
assert_eq 2 "$(watch_guard_bump)"
assert_eq 2 "$(watch_guard_count)"
watch_guard_reset
assert_eq 0 "$(watch_guard_count)"
assert_file_missing "$WATCH_GUARD"

# --- the wake file ----------------------------------------------------------

rm -f -- "$WATCH_WAKE"
assert_fail watch_wake_has 'died: s1 - gone'
watch_wake_write 'died: s1 - gone'
assert_ok watch_wake_has 'died: s1 - gone'
assert_fail watch_wake_has 'died: s2 - gone'

# Appended, never overwritten: two shifts can become interesting between one
# drain and the next.
watch_wake_write 'signal: s2 - reported'
assert_ok watch_wake_has 'died: s1 - gone'
assert_ok watch_wake_has 'signal: s2 - reported'
assert_eq 2 "$(grep -c . <"$WATCH_WAKE")"

# --- what is still being supervised -----------------------------------------

assert_eq 0 "$(watch_live_count)" 'a task with no shifts has no supervision responsibility'

run=$home/tasks/t1/shifts/s1/run
mkdir -p "$run"
printf '{ "version": 1, "pane": "%%7" }\n' >"$run/meta.json"
assert_eq 1 "$(watch_live_count)"
assert_eq "$(printf 's1\t%%7\t%s' "$home/tasks/t1/shifts/s1")" "$(watch_live_shifts)"

# Clocking out deletes run/ whole, and that IS the fact - nothing mirrors it.
rm -rf -- "$run"
assert_eq 0 "$(watch_live_count)"

printf 'ok\n'
