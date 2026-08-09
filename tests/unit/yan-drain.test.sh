#!/usr/bin/env bash
#
# Phase 5 Trace bullet 4: `yan drain` reads the wake file and clears it.
#
# In that order. The reason has to survive from "yan wait exited" to "the
# model's next turn" (td supervision.md), so it is printed before it is
# removed: a crash in between costs a repeated wake, which is free, instead of
# a lost one, which is a shift waiting for a yan that never comes.
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
wake=$home/tasks/t042/run/wake
mkdir -p "$home/tasks/t042/run"

# --- read, then clear -------------------------------------------------------

printf 's1 reported done\n' >"$wake"
capture bash "$yan" drain t042
assert_eq 0 "$rc"
assert_eq 's1 reported done' "$out" 'the reason is printed'
assert_file_missing "$wake" 'and the file is cleared by the same command'

# --- an empty drain is normal, silent and successful -----------------------

capture bash "$yan" drain t042
assert_eq 0 "$rc" 'Codex drains after a quiet timeout too - nothing to report is not a failure'
assert_eq '' "$out"

# --- several reasons come back whole ---------------------------------------

printf 's1 reported blocked\ns2 died\n' >"$wake"
capture bash "$yan" drain t042
assert_eq 0 "$rc"
assert_eq 's1 reported blocked
s2 died' "$out"
assert_file_missing "$wake"

# --- --peek leaves it alone -------------------------------------------------

printf 'still to be handled\n' >"$wake"
capture bash "$yan" drain t042 --peek
assert_eq 'still to be handled' "$out"
assert_file_exists "$wake" '--peek does not clear'
capture bash "$yan" drain t042
assert_eq 'still to be handled' "$out"
assert_file_missing "$wake"

# --- the task comes from $YAN_TASK when it is not given --------------------

printf 'from the container environment\n' >"$wake"
capture env YAN_TASK=t042 bash "$yan" drain
assert_eq 0 "$rc"
assert_eq 'from the container environment' "$out"

# --- $YAN_WAKE_FILE overrides the path entirely ----------------------------
#
# Phase 8 owns `yan wait`, which is the writer. Until it lands, the override is
# how the two halves are kept in step without either guessing.

other=$tmp/elsewhere/wake
mkdir -p "$(dirname "$other")"
printf 'a wake file somewhere else\n' >"$other"
capture env YAN_WAKE_FILE="$other" bash "$yan" drain
assert_eq 0 "$rc"
assert_eq 'a wake file somewhere else' "$out"
assert_file_missing "$other"

# --- with nothing to identify the yan, say so ------------------------------

capture bash "$yan" drain
assert_eq 2 "$rc"
assert_contains "$out" 'YAN_TASK'

capture bash "$yan" drain t042 extra
assert_eq 2 "$rc" 'only one task id'

printf 'ok\n'
