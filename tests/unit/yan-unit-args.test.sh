#!/usr/bin/env bash
#
# Phase 6: what these subcommands refuse before they touch anything.
#
# Everything here fails on its arguments alone, so no git, no forge and no pool
# is involved - which is exactly why it belongs in the unit suite.
#
# `unit add` and `unit set` moved to TypeScript in Phase 7; their assertions
# live in tests/integration/unit-{add,set}.test.ts (plan/INDEX.md rule 6).
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

capture yan sync --help
assert_eq 0 "$rc"
assert_contains "$out" "usage: yan sync"

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
