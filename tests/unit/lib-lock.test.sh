#!/usr/bin/env bash
#
# lib-lock is the portable mutual-exclusion primitive: mkdir, because Git Bash
# has no flock. The two properties that matter are proved here - exactly one
# winner among concurrent acquirers, and a lock whose owner died is reclaimable.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=bin/lib-lock.sh
. "$YAN_REPO_ROOT/bin/lib-lock.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- the basic cycle -------------------------------------------------------

L=$tmp/basic.lock
assert_fail lock_is_held "$L"
assert_ok lock_acquire "$L"
assert_file_exists "$L/pid"
assert_file_exists "$L/at"
assert_eq "$$" "$(lock_owner_pid "$L")"
assert_ok lock_is_held "$L"

# A second acquire from this same process must not succeed: the directory is
# already there, and re-entrancy is not something this primitive offers.
assert_fail lock_acquire "$L"

assert_ok lock_release "$L"
assert_file_missing "$L"
assert_fail lock_is_held "$L"

# Releasing something that is not held is a no-op, not an error.
assert_ok lock_release "$L"

# --- usage errors ----------------------------------------------------------

assert_fail lock_acquire
assert_fail lock_acquire "$tmp/x.lock" abc
assert_fail lock_release
assert_fail with_lock "$tmp/y.lock" 0

# --- exactly one winner among concurrent acquirers -------------------------
#
# N subshells race for the same lockdir. mkdir is the atomic step, so exactly
# one of them may report a win.
#
# Two things here are deliberate, because the obvious way to write this test is
# flaky and the flakiness looks exactly like a lock bug:
#
#   1. NOBODY RELEASES DURING THE RACE. An earlier version had the winner hold
#      the lock for `sleep 1` and then release. With timeout 0 the losers give
#      up immediately, so on a loaded machine the last subshell could start
#      after the first had already released - and win, legitimately. Two
#      "winners" that never overlapped, reported as a violation of atomicity.
#      Holding the lock for the whole race removes the timing assumption: a
#      second winner is then impossible unless mkdir really is not atomic.
#   2. A START BARRIER. Without one there is no guarantee the racers ever
#      overlap, so the test could pass while proving nothing. Every racer spins
#      until `go` appears, so they are all inside lock_acquire together.

race=$tmp/race.lock
results=$tmp/results
gate=$tmp/go
mkdir -p "$results"

for i in 1 2 3 4 5 6 7 8; do
	(
		# Barrier: do not touch the lock until every racer is up.
		while [ ! -e "$gate" ]; do :; done
		if lock_acquire "$race" 0 2>/dev/null; then
			printf 'win %s\n' "$BASHPID" >"$results/$i"
		else
			printf 'lose\n' >"$results/$i"
		fi
	) &
done
# Give the racers a moment to reach the barrier, then release them together.
sleep 0.3 2>/dev/null || sleep 1
: >"$gate"
wait

wins=$(grep -l '^win' "$results"/* 2>/dev/null | wc -l | tr -d ' ')
assert_eq 1 "$wins" "exactly one concurrent lock_acquire may win"
assert_eq 8 "$(find "$results" -type f | wc -l | tr -d ' ')" "every racer must report"

# The lock directory is still there - nobody released it during the race.
assert_file_exists "$race" "the lock is still taken after the race"

# Ownership is recorded as `$$`, which inside a subshell is the PARENT shell -
# so the owner here is this test script, not the subshell that ran the mkdir.
# That is the intended semantics, and it matters well beyond this test: the
# owner of a lock is the `yan` process, not whatever transient subshell happened
# to take it. A subshell finishing therefore does NOT make the lock stale, while
# the `yan wait` process itself dying does - which is exactly what supervision's
# single-flight check needs. Asserting it here pins the behaviour down.
assert_ok lock_is_held "$race"
assert_fail lock_is_stale "$race"

# And this process, being the recorded owner, may release it.
assert_ok lock_release "$race"
assert_file_missing "$race" "the owner must be able to release"

# --- a waiter eventually gets it -------------------------------------------
#
# The holder is a background subshell that goes away after ~1s; a foreground
# acquire with a timeout must succeed once it does.

hand=$tmp/handover.lock
(
	lock_acquire "$hand" 0 >/dev/null 2>&1 && sleep 1 && lock_release "$hand" >/dev/null 2>&1
) &
holder=$!
# Give the background subshell time to take it before we start waiting.
sleep 0.3 2>/dev/null || sleep 1
assert_ok lock_acquire "$hand" 10
lock_release "$hand"
wait "$holder" 2>/dev/null || true

# --- a stale lock (dead owner) is reclaimable ------------------------------
#
# A pid that no longer exists must not keep the pool wedged. This is the only
# reason lib-lock records a pid at all.

stale=$tmp/stale.lock
mkdir -p "$stale"
# Start a process, let it exit, then claim the lock in its name.
( : ) &
dead=$!
wait "$dead" 2>/dev/null || true
printf '%s\n' "$dead" >"$stale/pid"
date +%s >"$stale/at"
: >"$stale/host"

# A lock owned by a dead pid is stale, is not held, and may be taken over.
assert_ok lock_is_stale "$stale"
assert_fail lock_is_held "$stale"
assert_ok lock_acquire "$stale" 0
assert_eq "$$" "$(lock_owner_pid "$stale")" "reclaiming must rewrite the owner"
lock_release "$stale"

# A live owner is neither stale nor stealable.
live=$tmp/live.lock
mkdir -p "$live"
printf '%s\n' "$$" >"$live/pid"
date +%s >"$live/at"
: >"$live/host"
assert_fail lock_is_stale "$live"
assert_ok lock_is_held "$live"
rm -rf "$live"

# --- lock_release refuses to release someone else's lock -------------------

other=$tmp/other.lock
mkdir -p "$other"
# A pid that is alive and is not us: our own parent will do.
printf '%s\n' "$PPID" >"$other/pid"
date +%s >"$other/at"
_lock_host >"$other/host"
capture lock_release "$other"
assert_ne 0 "$rc" "releasing another live process's lock must be refused"
assert_contains "$out" "not $$"
assert_file_exists "$other" "a refused release must leave the lock in place"
rm -rf "$other"

# --- with_lock always releases ---------------------------------------------

w=$tmp/with.lock
assert_ok with_lock "$w" 5 true
assert_file_missing "$w" "with_lock must release on success"

capture with_lock "$w" 5 bash -c 'exit 3'
assert_eq 3 "$rc" "with_lock must pass the command's exit code through"
assert_file_missing "$w" "with_lock must release on failure too"

# The command really does run under the lock.
probe=$tmp/probe.txt
with_lock "$w" 5 bash -c "[ -d '$w' ] && printf held > '$probe'"
assert_eq held "$(cat "$probe")"
assert_file_missing "$w"

# --- double sourcing is safe ----------------------------------------------

# shellcheck source=bin/lib-lock.sh
. "$YAN_REPO_ROOT/bin/lib-lock.sh"
assert_ok declare -F lock_acquire

printf 'ok\n'
