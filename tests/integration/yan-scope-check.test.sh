#!/usr/bin/env bash
#
# Phase 5 Trace bullet 5: `yan scope-check` reports out-of-scope paths and
# NEVER blocks.
#
# Against a real repository, because prefix matching is only worth testing on a
# real diff: commits since the integration branch, edits that are not committed
# yet, and a file that was created and never added - the last one being exactly
# the stray edit `git diff` alone would never see.
#
# The assertion that matters most is the exit code. td delivery.md §8.3: going
# outside `scope` requires widening it explicitly, it is not forbidden - so
# finding something outside scope is a SUCCESSFUL run of this command.
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

# --- a repository with an integration branch and a shift branch ------------

bare=$tmp/remote.git
tree=$tmp/tree
mk_bare_remote "$bare"
mk_clone "$bare" "$tree"

mk_commit "$tree" apps/auth/header.ts 'export const header = 1' 'seed auth'
mk_commit "$tree" apps/common/types.ts 'export type T = 1' 'seed common'
fx_git -C "$tree" checkout -q -b feat/auth
fx_git -C "$tree" checkout -q -b yan/t042/s1

# committed on the shift branch: one inside scope, one outside
mk_commit "$tree" apps/auth/parse.ts 'export const parse = 1' 'in scope, committed'
mk_commit "$tree" apps/billing/invoice.ts 'export const invoice = 1' 'out of scope, committed'
# edited, not committed
printf 'export const header = 2\n' >"$tree/apps/auth/header.ts"
printf 'export type T = 2\n' >"$tree/apps/common/types.ts"
# created and never added
mkdir -p "$tree/tools"
printf 'scratch\n' >"$tree/tools/scratch.sh"

# --- the task, the unit and the shift --------------------------------------

task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth

run=$home/tasks/t042/shifts/s1/run
mkdir -p "$run"
# printf, not jq: MSYS2 rewrites a POSIX path handed to a native jq.exe into
# C:/..., and this fixture has to hold the path exactly as the test built it.
cat >"$run/meta.json" <<JSON
{ "version": 1,
  "unit": "auth",
  "branch": "yan/t042/s1",
  "tree": "$tree",
  "agent": "claude" }
JSON

# --- it reports, and it exits 0 --------------------------------------------

capture bash "$yan" scope-check s1
assert_eq 0 "$rc" "finding something outside scope is a successful run: $out"

assert_contains "$out" 'out of scope'
assert_contains "$out" 'apps/billing/invoice.ts' 'a commit outside scope is reported'
assert_contains "$out" 'apps/common/types.ts' 'an uncommitted edit outside scope is reported'
assert_contains "$out" 'tools/scratch.sh' 'a file that was never added is reported'
assert_contains "$out" 'widen' 'and it says what to do about it'

json=$(bash "$yan" scope-check s1 --json)
assert_eq 3 "$(printf '%s' "$json" | jq '.out_of_scope | length')"
assert_eq 2 "$(printf '%s' "$json" | jq '.in_scope | length')"
assert_eq false "$(printf '%s' "$json" | jq -r .blocked)" 'nothing here ever blocks'
assert_eq 'apps/auth' "$(printf '%s' "$json" | jq -r '.scope | join(" ")')"
assert_eq 'apps/auth/header.ts apps/auth/parse.ts' \
	"$(printf '%s' "$json" | jq -r '.in_scope | join(" ")')"
assert_eq 'apps/billing/invoice.ts apps/common/types.ts tools/scratch.sh' \
	"$(printf '%s' "$json" | jq -r '.out_of_scope | join(" ")')"

# --- widening the scope is what makes a path go away -----------------------
#
# This is the flow §8.3 describes, run end to end: the answer to an
# out-of-scope path is an edit to task.json, not a refusal from this command.

task_unit_set_scope t042 auth apps
json=$(bash "$yan" scope-check s1 --json)
assert_eq 'tools/scratch.sh' "$(printf '%s' "$json" | jq -r '.out_of_scope | join(" ")')" \
	'apps/billing and apps/common are inside the widened scope'

# --- a unit with no scope restricts nothing --------------------------------

task_unit_set_scope t042 auth
capture bash "$yan" scope-check s1
assert_eq 0 "$rc"
assert_contains "$out" 'restricts nothing'
assert_eq 0 "$(bash "$yan" scope-check s1 --json | jq '.out_of_scope | length')"

# --- a base that is not in the tree narrows the comparison, nothing more ---

task_unit_set_scope t042 auth apps/auth
fx_git -C "$tree" branch -D feat/auth >/dev/null
capture bash "$yan" scope-check s1
assert_eq 0 "$rc" 'a missing base narrows the comparison; it never turns into a refusal'
assert_contains "$out" 'only the working tree was compared'
assert_contains "$out" 'apps/common/types.ts'
assert_not_contains "$out" 'apps/billing/invoice.ts' 'that one is only visible against the base'

printf 'ok\n'
