#!/usr/bin/env bash
#
# Phase 1 Trace bullet 3: `yan ls` with no id derives the queue from disk;
# with an id it prints units and live shifts - and it STORES NOTHING.
#
# The last part is the one that matters most (td INDEX.md §3: there is no
# backlog file), so it is asserted the only way that really proves it: take a
# full listing of everything under $YAN_HOME before and after, and require the
# two to be identical.
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

# --- an empty home still answers ------------------------------------------

capture bash "$yan" ls
assert_eq 0 "$rc"
assert_contains "$out" 'no tasks'

capture bash "$yan" ls --json
assert_eq 0 "$rc"
assert_eq 0 "$(printf '%s' "$out" | jq '.tasks | length')"

# --- build two tasks, one of them with a live shift -----------------------

task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth
task_unit_add t042 gateway monorepo-x master --branch feat/gw --scope apps/gateway --needs auth

task_init t007 'retire the legacy client'
task_unit_add t007 client service-y release/2026.9 --branch chore/retire --scope src/client --mode branch
task_set_complete t007 true

# run/meta.json is written by Phase 7's spawn script; Phase 1 only reads it.
# These are the keys yan ls treats as the contract.
mkdir -p "$home/tasks/t042/shifts/s3/run"
tree_path=$tmp/trees/1/monorepo-x
mkdir -p "$tree_path"
# Written with printf rather than jq on purpose: MSYS2 rewrites a POSIX
# absolute path passed as an argument to a native jq.exe into C:/... , and this
# fixture has to hold the path verbatim so the assertions below mean something.
cat >"$home/tasks/t042/shifts/s3/run/meta.json" <<JSON
{ "version": 1,
  "unit": "auth",
  "branch": "yan/t042-auth-s3",
  "tree": "$tree_path",
  "agent": "claude" }
JSON

# A clocked-out shift keeps brief.md and outcome.md but no run/, so it must not
# show up as live.
mkdir -p "$home/tasks/t042/shifts/s1"
printf 'done\n' >"$home/tasks/t042/shifts/s1/outcome.md"

snapshot() { find "$home" | LC_ALL=C sort; }
before=$(snapshot)

# --- the queue ------------------------------------------------------------

capture bash "$yan" ls
assert_eq 0 "$rc"
assert_contains "$out" 't042'
assert_contains "$out" 't007'
assert_contains "$out" 'unify the auth header'
assert_contains "$out" 'apps/auth'    # the scope column (td agents.md §5.2)
assert_contains "$out" 'apps/gateway'
assert_contains "$out" 'src/client'
assert_contains "$out" 'SCOPE'
assert_contains "$out" 'open'
assert_contains "$out" 'done'

capture bash "$yan" ls --json
assert_eq 0 "$rc"
q=$out
assert_eq 2 "$(printf '%s' "$q" | jq '.tasks | length')"
assert_eq 1 "$(printf '%s' "$q" | jq '.version')"
assert_eq false "$(printf '%s' "$q" | jq '.tasks[] | select(.id=="t042") | .complete')"
assert_eq true "$(printf '%s' "$q" | jq '.tasks[] | select(.id=="t007") | .complete')"
assert_eq 2 "$(printf '%s' "$q" | jq '.tasks[] | select(.id=="t042") | .units | length')"
assert_eq 1 "$(printf '%s' "$q" | jq '.tasks[] | select(.id=="t042") | .shifts')"
assert_eq 0 "$(printf '%s' "$q" | jq '.tasks[] | select(.id=="t007") | .shifts')"
assert_eq '["apps/auth","apps/gateway"]' \
	"$(printf '%s' "$q" | jq -c '.tasks[] | select(.id=="t042") | .scope')"

# The queue really is derived: add a task directory by hand and it appears,
# with no command having been told about it.
task_init t900 'a third task'
capture bash "$yan" ls --json
assert_eq 3 "$(printf '%s' "$out" | jq '.tasks | length')"
rm -rf "${home:?}/tasks/t900"
capture bash "$yan" ls --json
assert_eq 2 "$(printf '%s' "$out" | jq '.tasks | length')"

# --- one task: units and live shifts --------------------------------------

capture bash "$yan" ls t042
assert_eq 0 "$rc"
assert_contains "$out" 'unify the auth header'
assert_contains "$out" 'feat/auth'
assert_contains "$out" 'feat/gw'
assert_contains "$out" 'master'
assert_contains "$out" 'apps/auth'
assert_contains "$out" 'yan/t042-auth-s3' # the shift branch name
assert_contains "$out" "$tree_path"       # the worktree absolute path

capture bash "$yan" ls t042 --json
assert_eq 0 "$rc"
d=$out
assert_eq 2 "$(printf '%s' "$d" | jq '.units | length')"
assert_eq 1 "$(printf '%s' "$d" | jq '.shifts | length')"
assert_eq s3 "$(printf '%s' "$d" | jq -r '.shifts[0].sid')"
assert_eq 'yan/t042-auth-s3' "$(printf '%s' "$d" | jq -r '.shifts[0].branch')"
assert_eq "$tree_path" "$(printf '%s' "$d" | jq -r '.shifts[0].tree')"
assert_eq auth "$(printf '%s' "$d" | jq -r '.shifts[0].unit')"
assert_eq 0 "$(printf '%s' "$d" | jq '[.shifts[] | select(.sid == "s1")] | length')" \
	"a shift whose run/ is gone has clocked out and is not live"
assert_eq '["apps/gateway"]' "$(printf '%s' "$d" | jq -c '.units[] | select(.name=="gateway") | .scope')"
assert_eq '["auth"]' "$(printf '%s' "$d" | jq -c '.units[] | select(.name=="gateway") | .needs')"

capture bash "$yan" ls t007
assert_eq 0 "$rc"
assert_contains "$out" '(none)' "a task with no live shift says so"

# --- nothing was stored ---------------------------------------------------

after=$(snapshot)
assert_eq "$before" "$after" \
	"yan ls must not create a single file anywhere under \$YAN_HOME - there is no backlog file"

# And there is nowhere it could hide one: no backlog-shaped path exists.
assert_file_missing "$home/mem/backlog.json"
assert_file_missing "$home/tasks/backlog.json"
assert_file_missing "$home/mem/queue.json"
assert_eq 0 "$(grep -c -E 'json_write|json_edit|json_init|>>|mkdir' "$YAN_REPO_ROOT/bin/yan-ls.sh")" \
	"yan-ls.sh must contain no write operation at all"

# --- errors ---------------------------------------------------------------

assert_fail bash "$yan" ls nosuchtask
assert_fail bash "$yan" ls t042 t007
assert_fail bash "$yan" ls --nope

printf 'ok\n'
