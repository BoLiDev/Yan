#!/usr/bin/env bash
#
# Phase 5 Trace bullet 1: `yan report` accepts only the five allowed states,
# and appends run/status AND touches run/signal IN ONE GO.
#
# "In one go" is the reason the command exists at all (td agents.md §5.4: do
# not count on an agent remembering step two), so it is asserted the only way
# that means anything: one invocation, then both effects checked.
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
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth

run=$home/tasks/t042/shifts/s1/run
mkdir -p "$home/tasks/t042/shifts/s1"

lines() { # <file>
	local n
	if [ ! -f "$1" ]; then
		printf '0\n'
		return 0
	fi
	n=$(wc -l <"$1")
	printf '%s\n' "${n//[!0-9]/}"
}

# --- one command, both effects ---------------------------------------------

assert_file_missing "$run/status"
capture bash "$yan" report 'done' 'mr https://forge.invalid/x/-/merge_requests/1' --sid s1 --task t042
assert_eq 0 "$rc" "reporting a valid state succeeds: $out"
assert_file_exists "$run/status" 'the event was appended'
assert_file_exists "$run/signal" 'the wake marker was touched by the same command'
assert_eq 1 "$(lines "$run/status")"

first=$(head -1 "$run/status")
assert_contains "$first" $'\tdone\t' 'the state is its own field'
assert_contains "$first" 'merge_requests/1' 'the note is kept verbatim'
case $first in
[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z*) ;;
*) printf 'no timestamp on the event line: %s\n' "$first" >&2 && exit 1 ;;
esac

# The wake marker is re-touched by every report, not only the first.
rm -f "$run/signal"
capture bash "$yan" report blocked 'waiting for a credential' --sid s1 --task t042
assert_eq 0 "$rc"
assert_file_exists "$run/signal" 'signal is written again on the next report'
assert_eq 2 "$(lines "$run/status")" 'run/status is appended, never replaced'
assert_contains "$(cat "$run/status")" 'merge_requests/1' 'the earlier event survived'

# --- exactly five states ---------------------------------------------------

for state in started needs-decision conflict; do
	capture bash "$yan" report "$state" "note for $state" --sid s1 --task t042
	assert_eq 0 "$rc" "$state must be accepted: $out"
done
assert_eq 5 "$(lines "$run/status")" 'all five allowed states were accepted'

before=$(cat "$run/status")
for bad in progress DONE finished failed stuck note ''; do
	capture bash "$yan" report "$bad" 'a note' --sid s1 --task t042
	assert_eq 2 "$rc" "'$bad' is not one of the five and must be refused loudly"
	assert_contains "$out" 'started done blocked needs-decision conflict' \
		'the refusal names the whole allowed set'
done
assert_eq "$before" "$(cat "$run/status")" 'a refused state writes nothing at all'

# --- a note is required, and it is one line --------------------------------

capture bash "$yan" report 'done' --sid s1 --task t042
assert_eq 2 "$rc" 'a state without a note is refused'

capture bash "$yan" report 'done' $'two\nlines' --sid s1 --task t042
assert_eq 2 "$rc" 'a newline would forge a second event'
assert_contains "$out" 'one line'
assert_eq "$before" "$(cat "$run/status")"

# --- who is reporting: the spawn environment, not an argument --------------

capture env YAN_SHIFT_DIR="$home/tasks/t042/shifts/s1" bash "$yan" report 'done' 'via YAN_SHIFT_DIR'
assert_eq 0 "$rc" "$out"
assert_eq 6 "$(lines "$run/status")"

capture env YAN_TASK_DIR="$home/tasks/t042/shifts/s1" bash "$yan" report 'done' 'via YAN_TASK_DIR as the shift dir'
assert_eq 0 "$rc" "$out"

capture env YAN_TASK_DIR="$home/tasks/t042" YAN_SID=s1 bash "$yan" report 'done' 'via YAN_TASK_DIR plus YAN_SID'
assert_eq 0 "$rc" "$out"

capture env YAN_TASK=t042 YAN_SID=s1 bash "$yan" report 'done' 'via ids only'
assert_eq 0 "$rc" "$out"
assert_eq 9 "$(lines "$run/status")"

capture bash "$yan" report 'done' 'nobody knows who I am'
assert_eq 2 "$rc" 'with nothing to identify the shift, say so instead of guessing'
assert_contains "$out" 'YAN_SHIFT_DIR'

# --- an id that exists twice is refused, never guessed at ------------------

task_init t007 'retire the legacy client'
mkdir -p "$home/tasks/t007/shifts/s1"
capture env YAN_SID=s1 bash "$yan" report 'done' 'ambiguous'
assert_eq 2 "$rc" 'the same shift id under two tasks must be refused'
assert_contains "$out" '--task'

printf 'ok\n'
