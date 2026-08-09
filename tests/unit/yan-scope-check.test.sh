#!/usr/bin/env bash
#
# Phase 5 Trace bullet 5, the half that needs no git: `yan scope-check` refuses
# nothing, and the only things it does fail on are real errors.
#
# The prefix matching against a real diff is in tests/integration, where there
# is a real repository to diff.
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
mkdir -p "$run"

# --- the failures are only ever real errors --------------------------------

capture bash "$yan" scope-check
assert_eq 2 "$rc" 'no shift id is a usage error'

capture bash "$yan" scope-check s1 --task
assert_eq 2 "$rc" '--task needs a value'

capture bash "$yan" scope-check nosuchshift
assert_eq 1 "$rc" 'a shift that does not exist is a real error'
assert_contains "$out" 'no such shift'

printf '{ "version": 1, "unit": "auth" }\n' >"$run/meta.json"
capture bash "$yan" scope-check s1
assert_eq 1 "$rc" 'no tree recorded is a real error'
assert_contains "$out" 'no working tree'

printf '{ "version": 1, "unit": "auth", "tree": "%s" }\n' "$tmp/gone" >"$run/meta.json"
capture bash "$yan" scope-check s1
assert_eq 1 "$rc" 'a tree that is not there is a real error'

# --- `yan scope check` reaches the same file -------------------------------

capture bash "$yan" scope check nosuchshift
assert_eq 1 "$rc" 'a hyphen may be written as a space'
assert_contains "$out" 'no such shift'

printf 'ok\n'
