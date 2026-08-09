#!/usr/bin/env bash
#
# Phase 9 Trace bullet 1, the half a test can actually prove:
#
#   NON-TTY WITH MISSING ARGUMENTS -> REFUSE, LISTING THE FLAGS
#
# cli-ux.md §1 gives the rule two halves, and they are not equally testable. A
# real terminal cannot be conjured up inside a test runner, so the prompt half
# is covered by tests/unit/ui-soft-path.test.sh, which drives the ui's
# ARGUMENT ASSEMBLY directly. This file drives the branch that must never
# prompt - the one every agent, hook, script and CI job takes - because a
# prompt reached with nobody at the keyboard is a hang, and a hang inside a
# Stop hook is invisible.
#
# The whole test runs with stdin at /dev/null, which IS the non-TTY condition.
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
export YAN_HOME=$home
yan=$home/bin/yan

run() { # run <args...> - always without a terminal
	capture env bash "$yan" task new "$@" <"/dev/null"
}

# --- nothing at all: refuse, and name what is missing -----------------------

run
assert_eq 2 "$rc" 'no TTY and no arguments is a refusal, never a prompt'
assert_contains "$out" 'missing: --title --repo' 'the refusal names the flags to pass'
assert_not_contains "$out" 'not implemented'

# --- a title but no repository is still incomplete --------------------------
#
# The refusal lists what is MISSING, not everything the command takes.

run --title 'unify the auth header'
assert_eq 2 "$rc"
assert_contains "$out" 'missing: --repo (with its --target)'

# --- --target is required for every unit, and never guessed -----------------
#
# branching.md §6.4. A half-specified unit is deliberately NOT sent to the soft
# path either: the prompts collect a task from the top and would silently drop
# the --repo the caller already typed.

run --title t --repo monorepo-x
assert_eq 2 "$rc"
assert_contains "$out" '--target is required for --repo monorepo-x'
assert_contains "$out" 'never guesses'

# --- the flag grammar groups by position ------------------------------------

run --title t --scope apps/auth --repo monorepo-x --target main
assert_eq 2 "$rc"
assert_contains "$out" '--scope belongs to a unit'

run --title t --repo monorepo-x --target main --unknown
assert_eq 2 "$rc"
assert_contains "$out" 'unknown option: --unknown'

run --title t --repo monorepo-x --target main stray
assert_eq 2 "$rc"
assert_contains "$out" 'unexpected argument: stray'

run --title
assert_eq 2 "$rc"
assert_contains "$out" '--title needs a value'

# --- an id that is already taken --------------------------------------------

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
task_init t007 'already here'

run --title t --id t007 --repo monorepo-x --target main
assert_eq 2 "$rc"
assert_contains "$out" 'already exists'

# --- an unregistered repository is refused BEFORE anything is entered -------

run --title t --repo nosuchrepo --target main
assert_ne 0 "$rc"
assert_contains "$out" 'nosuchrepo'

# --- --help works without a terminal ----------------------------------------

capture env bash "$yan" task new --help <"/dev/null"
assert_eq 0 "$rc"
assert_contains "$out" 'order sensitive'

printf 'ok\n'
