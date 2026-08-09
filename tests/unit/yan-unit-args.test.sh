#!/usr/bin/env bash
#
# Phase 6: what the three subcommands refuse before they touch anything.
#
# Everything here fails on its arguments alone, so no git, no forge and no pool
# is involved - which is exactly why it belongs in the unit suite. The first
# assertion is Trace bullet 1's front half:
#
#   `unit add` requires an explicit target. There is no safe default
#   (branching.md §6.4), so there is no default at all.
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
YAN=$home/bin/yan

yan() { env YAN_HOME="$home" bash "$YAN" "$@"; }

# --- the dispatcher finds the two-word forms --------------------------------

capture yan unit add --help
assert_eq 0 "$rc"
assert_contains "$out" "usage: yan unit add"

capture yan unit set --help
assert_eq 0 "$rc"
assert_contains "$out" "usage: yan unit set"

capture yan sync --help
assert_eq 0 "$rc"
assert_contains "$out" "usage: yan sync"

# --- unit add: target has no default ----------------------------------------

capture yan unit add --task t1 --unit auth --repo demo
assert_eq 2 "$rc" "a unit without a target is refused"
assert_contains "$out" "--target is required"
assert_contains "$out" "no safe default"

capture yan unit add --unit auth --repo demo --target main
assert_eq 2 "$rc"
assert_contains "$out" "--task is required"

capture yan unit add --task t1 --repo demo --target main
assert_eq 2 "$rc"
assert_contains "$out" "--unit is required"

capture yan unit add --task t1 --unit auth --target main
assert_eq 2 "$rc"
assert_contains "$out" "--repo is required"

capture yan unit add --task t1 --unit auth --repo demo --target
assert_eq 2 "$rc"
assert_contains "$out" "needs a value"

capture yan unit add --task t1 --unit auth --repo demo --target main --bogus
assert_eq 2 "$rc"
assert_contains "$out" "unknown option"

capture yan unit add --task t1 --unit auth --repo demo --target main
assert_eq 2 "$rc" "the task has to exist"
assert_contains "$out" "no such task"

# --- unit set: it changes nothing unless asked -------------------------------

capture yan unit set --task t1 --unit auth
assert_eq 2 "$rc"
assert_contains "$out" "nothing to change"

capture yan unit set --unit auth --branch x
assert_eq 2 "$rc"
assert_contains "$out" "--task is required"

capture yan unit set --task t1 --unit auth --end merged --branch x
assert_eq 2 "$rc" "end is delivered or abandoned - the forge's own words never leak in"
assert_contains "$out" "delivered"

capture yan unit set --task t1 --unit auth --end delivered --target main
assert_eq 2 "$rc" "--end only means anything when a round is being replaced"
assert_contains "$out" "only applies to --branch"

# --- sync --------------------------------------------------------------------

capture yan sync --task t1
assert_eq 2 "$rc"
assert_contains "$out" "--unit is required"

capture yan sync --task t1 --unit auth --strategy squash
assert_eq 2 "$rc" "sync rebases or merges; nothing else"
assert_contains "$out" "merge"

capture yan sync --task t1 --unit auth
assert_eq 2 "$rc"
assert_contains "$out" "no such task"

# --- yan never resolves conflicts, and the source says so --------------------
#
# One of the four ordering regressions in architecture.md §7 is `yan sync`
# quietly gaining the ability to fix a conflict itself. It is not a thing that
# fails loudly when it goes wrong, so the shape is pinned here as well as in
# the behaviour test: no continue, no theirs/ours, no rerere.

for bad in 'rebase --continue' 'merge --continue' 'checkout --theirs' 'checkout --ours' 'rerere'; do
	assert_not_contains "$(cat "$YAN_REPO_ROOT/bin/yan-sync.sh")" "$bad" \
		"yan sync must never resolve a conflict itself"
done

printf 'ok\n'
