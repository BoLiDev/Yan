#!/usr/bin/env bash
#
# Phase 2 trace bullet 4 plus the concurrency requirement:
#
#   4. a full pool makes get FAIL rather than grow - and no extra tree is
#      created on the way out
#   +  two get calls racing must never hand out the same tree
#
# Silent growth would be worse than the failure it hides: every extra tree is a
# cold one, which is the same as having no pool (td worktree.md §7).
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export YAN_HOME=$tmp/home
mk_yan_home "$YAN_HOME"
export YAN_POOL_ROOT=$tmp/trees

# shellcheck source=bin/lib-pool.sh
. "$YAN_HOME/bin/lib-pool.sh"

bare=$tmp/remote.git
clone=$YAN_HOME/repos/demo
mk_bare_remote "$bare"
mk_clone "$bare" "$clone"

pooldir=$(pool_dir "$clone")

worktree_count() {
	git_worktree_list "$clone" | grep -c '^worktree ' || true
}

# The main clone itself counts as a worktree.
assert_eq 1 "$(worktree_count)"

# --- trace 4: a full pool fails, it does not grow --------------------------

a=$(pool_get "$clone" 2 main shift/a t1/u1/a)
b=$(pool_get "$clone" 2 main shift/b t1/u1/b)
pa=$(printf '%s' "$a" | jq -r '.path')
pb=$(printf '%s' "$b" | jq -r '.path')

assert_ne "$pa" "$pb" "two leases are two different trees"
assert_eq 3 "$(worktree_count)"

capture pool_get "$clone" 2 main shift/c t1/u1/c
assert_ne 0 "$rc" "a full pool refuses"
assert_contains "$out" "pool is full"
assert_contains "$out" "cannot start a new shift" "the message must not read like a sync failure"

assert_file_missing "$pooldir/3" "backpressure: no third tree is created"
assert_eq 3 "$(worktree_count)" "no extra worktree was registered either"
assert_eq 2 "$(pool_status "$clone" | jq 'length')"

# The size is a per-repository setting, so the same pool with a larger size
# hands out a third tree - the refusal above was backpressure, not breakage.
c=$(pool_get "$clone" 3 main shift/c t1/u1/c)
assert_eq 3 "$(pool_status "$clone" | jq 'length')"
assert_ok pool_return "$clone" "$(printf '%s' "$c" | jq -r '.path')"

assert_ok pool_return "$clone" "$pa"
assert_ok pool_return "$clone" "$pb"
assert_eq '[]' "$(pool_status "$clone")"

# --- two racing gets must never hand out the same tree ---------------------

race() { # race <tag> <branch> <holder>
	local rc=0
	pool_get "$clone" 2 main "$2" "$3" >"$tmp/$1.json" 2>"$tmp/$1.err" || rc=$?
	printf '%s\n' "$rc" >"$tmp/$1.rc"
}

race one shift/x1 t2/u1/x1 &
p1=$!
race two shift/x2 t2/u1/x2 &
p2=$!
wait "$p1" || true
wait "$p2" || true

assert_eq 0 "$(cat "$tmp/one.rc")" "racer one: $(cat "$tmp/one.err")"
assert_eq 0 "$(cat "$tmp/two.rc")" "racer two: $(cat "$tmp/two.err")"

p_one=$(jq -r '.path' "$tmp/one.json")
p_two=$(jq -r '.path' "$tmp/two.json")
assert_ne "$p_one" "$p_two" "two concurrent gets handed out the same tree"
assert_ne "$(jq -r '.lease_id' "$tmp/one.json")" "$(jq -r '.lease_id' "$tmp/two.json")"

assert_eq 2 "$(pool_status "$clone" | jq 'length')" "both leases were recorded"
assert_file_exists "$pooldir/leases/1.json"
assert_file_exists "$pooldir/leases/2.json"
assert_eq 2 "$(pool_status "$clone" | jq '[.[].path] | unique | length')"

# --- a lease survives its process; only a vanished tree releases one -------

assert_file_missing "$pooldir/lock" "the lock is always released"

printf 'ok\n'
