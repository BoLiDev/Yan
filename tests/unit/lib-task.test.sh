#!/usr/bin/env bash
#
# Phase 1 Trace bullet 2: a minimal tasks/<id>/ - task.json + brief.md + an
# empty log.md - can be created through library helpers alone.
#
# Plus the two invariants lib-task exists to enforce (architecture.md §4.2,
# td branching.md §6.4):
#   * history[] is append-only: an existing entry is never modified or removed,
#     and no API takes a history index;
#   * the four current scalars are kept SEPARATE from the history - "current is
#     the last array element" is explicitly rejected;
#   * `end` is only ever delivered or abandoned.
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

# --- Trace bullet 2: the minimal task directory ---------------------------

assert_eq "$home/tasks/t042" "$(task_dir t042)"
assert_eq "$home/tasks/t042/task.json" "$(task_file t042)"
assert_fail task_exists t042

task_init t042 'unify the auth header'

assert_ok task_exists t042
assert_file_exists "$home/tasks/t042/task.json"
assert_file_exists "$home/tasks/t042/brief.md"
assert_file_exists "$home/tasks/t042/log.md"

assert_eq 1 "$(jq -r .version "$home/tasks/t042/task.json")" "every JSON file carries version"
assert_eq t042 "$(jq -r .id "$home/tasks/t042/task.json")"
assert_eq 'unify the auth header' "$(task_title t042)"
assert_eq 0 "$(jq '.units | length' "$home/tasks/t042/task.json")"

# "empty log.md" means the heading and no events yet.
assert_eq '# t042 unify the auth header' "$(head -n 1 "$home/tasks/t042/log.md")"
assert_eq 0 "$(grep -c '^- ' "$home/tasks/t042/log.md")"

# Re-running changes nothing.
task_init t042 'a different title'
assert_eq 'unify the auth header' "$(task_title t042)"

assert_fail task_init 'bad/id' 'title'
assert_fail task_init t043
assert_eq t042 "$(task_list)"

# --- the completion flag: the one thing that must be stored ---------------

assert_fail task_is_complete t042
task_set_complete t042 true
assert_ok task_is_complete t042
task_set_complete t042 false
assert_fail task_is_complete t042
assert_fail task_set_complete t042 yes

# --- units -----------------------------------------------------------------

task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth --scope libs/http
task_unit_add t042 proto monorepo-x master --mode branch

assert_eq $'auth\nproto' "$(task_unit_names t042)"
assert_eq monorepo-x "$(task_unit_get t042 auth repo)"
assert_eq feat/auth "$(task_unit_get t042 auth branch)"
assert_eq master "$(task_unit_get t042 auth target)"
assert_eq mr "$(task_unit_get t042 auth mode)"
assert_eq '' "$(task_unit_get t042 auth mr)"
assert_eq branch "$(task_unit_get t042 proto mode)"
assert_eq $'apps/auth\nlibs/http' "$(task_unit_scope t042 auth)"
assert_eq '' "$(task_unit_needs t042 auth)"

task_unit_set_needs t042 auth proto
assert_eq proto "$(task_unit_needs t042 auth)"

assert_fail task_unit_add t042 auth monorepo-x master # a unit name is unique
assert_fail task_unit_add t042 solo monorepo-x        # target has no safe default
assert_fail task_unit_add t042 solo monorepo-x master --mode wander
assert_fail task_unit_get t042 nosuch branch
assert_fail task_unit_get t042 auth scope

# --- the four current scalars, and only those, are settable ---------------

task_unit_set t042 auth mr 'https://example.invalid/mr/88'
assert_eq 'https://example.invalid/mr/88' "$(task_unit_get t042 auth mr)"
task_unit_set t042 auth mode scout
assert_eq scout "$(task_unit_get t042 auth mode)"

assert_fail task_unit_set t042 auth mode wander
assert_fail task_unit_set t042 auth history '[]'
assert_fail task_unit_set t042 auth scope apps/x
assert_fail task_unit_set t042 auth repo other
assert_fail task_unit_set t042 auth name renamed

# --- history[] is append-only ---------------------------------------------

assert_eq '[]' "$(task_unit_history t042 auth)"
assert_eq 0 "$(task_unit_rounds t042 auth)"

task_history_append t042 auth feat/auth-r1 master 2026-08-20 delivered 'https://example.invalid/mr/31'
first=$(task_unit_history t042 auth)
assert_contains "$first" 'feat/auth-r1'
assert_contains "$first" '"end":"delivered"'
assert_contains "$first" '"mr":"https://example.invalid/mr/31"'

task_history_append t042 auth feat/auth-wip master 2026-08-25 abandoned
hist=$(task_unit_history t042 auth)
assert_eq 2 "$(printf '%s' "$hist" | jq 'length')"
assert_eq "$first" "$(printf '%s' "$hist" | jq -c '.[0:1]')" \
	"an existing history entry must survive a later append byte-identically"

# An abandoned round may never have opened an MR, so `mr` is optional and
# absent rather than empty - at most five fields, never more.
assert_eq false "$(printf '%s' "$hist" | jq '.[1] | has("mr")')"
assert_eq 4 "$(printf '%s' "$hist" | jq '.[1] | keys | length')"
assert_eq '["at","branch","end","target"]' "$(printf '%s' "$hist" | jq -c '.[1] | keys')"
assert_eq 5 "$(printf '%s' "$hist" | jq '.[0] | keys | length')"

# --- an invalid `end` is refused, and nothing is written ------------------

assert_fail task_history_append t042 auth feat/x master 2026-09-01 shipped
assert_fail task_history_append t042 auth feat/x master 2026-09-01 ''
assert_fail task_history_append t042 auth feat/x master 2026-09-01 DELIVERED
assert_fail task_history_append t042 auth '' master 2026-09-01 delivered
assert_eq "$hist" "$(task_unit_history t042 auth)" \
	"a refused history write must leave the array untouched"

# --- the current scalars are NOT the last history element -----------------

task_unit_set t042 auth branch feat/auth
task_unit_set t042 auth mr 'https://example.invalid/mr/88'
task_unit_rotate t042 auth delivered feat/auth-r3 2026-09-05

assert_eq feat/auth-r3 "$(task_unit_get t042 auth branch)" "rotate overwrites the current branch"
assert_eq '' "$(task_unit_get t042 auth mr)" "a new round starts with no outbound MR"
assert_eq 3 "$(task_unit_rounds t042 auth)"

hist=$(task_unit_history t042 auth)
assert_eq feat/auth "$(printf '%s' "$hist" | jq -r '.[-1].branch')"
assert_ne "$(task_unit_get t042 auth branch)" "$(printf '%s' "$hist" | jq -r '.[-1].branch')" \
	"the current branch must be a field of its own, not the last history entry"
assert_eq "$first" "$(printf '%s' "$hist" | jq -c '.[0:1]')" \
	"rotate must not disturb earlier entries"

assert_fail task_unit_rotate t042 auth shipped feat/auth-r4
assert_fail task_unit_rotate t042 auth delivered
assert_eq 3 "$(task_unit_rounds t042 auth)"

# --- the API surface has no history rewriter ------------------------------
#
# Same reasoning as the log test: "no such operation exists" cannot be proved
# by calling operations, so enumerate the surface instead.

surface=" $(declare -F | sed 's/^declare -f //' | grep '^task_' | LC_ALL=C sort | tr '\n' ' ')"
for forbidden in \
	history_set history_replace history_update history_delete history_remove \
	history_rewrite history_edit history_pop history_at unit_history_set; do
	assert_not_contains "$surface" " task_$forbidden " \
		"lib-task must offer no way to change an existing history entry"
done
assert_contains "$surface" ' task_history_append '

# Every history write in the library builds `old + [entry]`, and nothing ever
# addresses an entry by index.
src=$YAN_REPO_ROOT/bin/lib-task.sh
assert_eq 2 "$(grep -c -F '+ [$e]' "$src")" "both history writers must extend the array"
assert_eq 0 "$(grep -c -E 'history\[[0-9$]' "$src")" "no history entry may be addressed by index"
assert_eq 0 "$(grep -c -E 'del\(|history\) *= *\[' "$src")" "history entries are never deleted"

printf 'ok\n'
