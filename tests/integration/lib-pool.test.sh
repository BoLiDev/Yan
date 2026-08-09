#!/usr/bin/env bash
#
# The pool against real git and a real (local, bare) remote.
#
# Phase 2 trace bullets 1, 2, 3 and 5:
#   1. get leases a tree, cuts the shift branch, returns {path, lease_id, holder}
#   2. return is reset --hard + clean -fd and NEVER -x, so gitignored
#      dependencies survive into the next shift
#   3. the orphan-commit guard refuses on uncommitted OR unpushed HEAD
#   5. a mismatched --if-lease-id / --if-lease-holder is refused BEFORE any
#      destructive step
#
# Local filesystem only - no network.
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

# The pool never touches the real ~/.yan-trees during a test run.
export YAN_POOL_ROOT=$tmp/trees

# shellcheck source=bin/lib-pool.sh
. "$YAN_HOME/bin/lib-pool.sh"

# --- a repository with an integration branch that exists only on the remote --

bare=$tmp/remote.git
clone=$YAN_HOME/repos/demo
mk_bare_remote "$bare"
mk_clone "$bare" "$clone"

mk_commit "$clone" .gitignore 'node_modules/' 'ignore node_modules'
fx_git -C "$clone" push origin main >/dev/null 2>&1
fx_git -C "$clone" branch integ main
fx_git -C "$clone" push origin integ >/dev/null 2>&1
fx_git -C "$clone" branch -D integ >/dev/null
fx_git -C "$clone" fetch origin >/dev/null 2>&1
assert_fail git_branch_exists "$clone" integ

# --- trace 1: get leases a tree and cuts the shift branch ------------------

holder=t042/auth/s1
lease=$(pool_get "$clone" 2 integ shift/t042-s1 "$holder")

path=$(printf '%s' "$lease" | jq -r '.path')
lease_id=$(printf '%s' "$lease" | jq -r '.lease_id')

assert_eq 'holder,lease_id,path' "$(printf '%s' "$lease" | jq -r 'keys | join(",")')" \
	"get returns exactly {path, lease_id, holder}"
assert_eq "$holder" "$(printf '%s' "$lease" | jq -r '.holder')"
assert_ne "" "$lease_id"
assert_file_exists "$path/README.md" "the tree is a real checkout"
assert_eq shift/t042-s1 "$(git_current_branch "$path")" "the tree is on a real branch, never detached"

# The layout is <pool root>/<repo>-<hash>/<slot>/<repo> and the leases live in
# the pool's own root, not under $YAN_HOME (td INDEX.md §3).
#
# The comparison against $pooldir is also the regression test for path
# spelling: $pooldir is built by the shell, so this fails the moment the
# reported path comes back in git.exe's native spelling instead (which is what
# MSYS2 does to a POSIX path handed to a native jq).
pooldir=$(pool_dir "$clone")
assert_contains "$path" "/1/demo"
assert_contains "$path" "$pooldir/"
assert_file_exists "$pooldir/leases/1.json"
assert_not_contains "$path" "$YAN_HOME" "trees are not in the yan home"
capture grep -rl "$lease_id" "$YAN_HOME"
assert_ne 0 "$rc" "a seam never writes bookkeeping under \$YAN_HOME"

# git knows the tree by its own spelling of the path; the pool has to
# normalise before it can compare (Git Bash prints C:/... for /tmp/...).
assert_contains "$(git_worktree_list "$clone")" "$(native_path "$path")"

# --- status is a registry of who holds what --------------------------------

pool_status "$clone" >"$tmp/status.json"
assert_fail grep -q $'\r' "$tmp/status.json" "jq.exe writes CRLF; the seam's output must not carry it"

st=$(pool_status "$clone")
assert_eq 1 "$(printf '%s' "$st" | jq 'length')"
assert_eq "$holder" "$(printf '%s' "$st" | jq -r '.[0].holder')"
assert_eq "$lease_id" "$(printf '%s' "$st" | jq -r '.[0].lease_id')"
assert_eq shift/t042-s1 "$(printf '%s' "$st" | jq -r '.[0].branch')"

# --- work in the tree: a gitignored dependency and a stray file ------------

mkdir -p "$path/node_modules/dep"
printf 'expensive to reinstall\n' >"$path/node_modules/dep/index.js"
printf 'scratch\n' >"$path/stray.txt"

# --- trace 3a: uncommitted changes -> refuse -------------------------------

capture pool_return "$clone" "$path"
assert_ne 0 "$rc" "a tree with uncommitted changes may not be returned"
assert_contains "$out" "uncommitted changes"
assert_file_exists "$path/stray.txt" "a refusal changes nothing"
assert_file_exists "$path/node_modules/dep/index.js"
assert_file_exists "$pooldir/leases/1.json" "a refusal leaves the lease alone"

rm -f "$path/stray.txt"
mk_commit "$path" feature.txt 'the shift did some work' 'add feature.txt'

# --- trace 3b: committed but unpushed HEAD -> refuse -----------------------

capture pool_return "$clone" "$path"
assert_ne 0 "$rc" "an unpushed HEAD may not be destroyed"
assert_contains "$out" "no remote branch contains HEAD"
assert_file_exists "$path/feature.txt"
assert_file_exists "$path/node_modules/dep/index.js"

# --- trace 5: identity is compared before anything destructive -------------
#
# The tree is deliberately dirty here. A dirty tree would fail the orphan
# guard with 1, so exit code 3 proves the identity check ran first - before
# the guard, before reset, before clean.

printf 'scratch again\n' >"$path/stray2.txt"

capture pool_return "$clone" "$path" "not-the-lease-id"
assert_eq 3 "$rc" "a mismatched lease id is refused before any destructive step"
assert_contains "$out" "lease id does not match"
assert_contains "$out" "nothing was touched"
assert_file_exists "$path/stray2.txt"
assert_file_exists "$path/node_modules/dep/index.js"
assert_file_exists "$pooldir/leases/1.json"

capture pool_return "$clone" "$path" "" "someone/else/s9"
assert_eq 3 "$rc" "a mismatched holder is refused before any destructive step"
assert_contains "$out" "holder does not match"
assert_file_exists "$path/stray2.txt"
assert_file_exists "$pooldir/leases/1.json"

# The right identity still refuses while the guard has something to say.
capture pool_return "$clone" "$path" "$lease_id" "$holder"
assert_ne 0 "$rc"
assert_ne 3 "$rc" "with a matching identity the guard is what refuses"
assert_contains "$out" "uncommitted changes"

rm -f "$path/stray2.txt"

# --- trace 2: a real return keeps the gitignored tree warm -----------------

assert_ok git_push "$path" origin shift/t042-s1

capture pool_return "$clone" "$path" "$lease_id" "$holder"
assert_eq 0 "$rc" "pushed and clean: the tree may be returned"
assert_file_exists "$path/node_modules/dep/index.js" \
	"clean -fd must NOT remove gitignored files - the whole point of the pool"
assert_file_exists "$path/feature.txt" "reset --hard keeps what HEAD contains"
assert_ok git_is_clean "$path"
assert_file_missing "$pooldir/leases/1.json"
assert_eq '[]' "$(pool_status "$clone")"

# --- and the next shift leases the same slot, still warm -------------------

lease2=$(pool_get "$clone" 2 integ shift/t042-s2 t042/auth/s2)
path2=$(printf '%s' "$lease2" | jq -r '.path')

assert_eq "$path" "$path2" "a returned slot is reused rather than a new tree grown"
assert_file_exists "$path2/node_modules/dep/index.js" \
	"gitignored dependencies survive from one shift to the next"
assert_eq shift/t042-s2 "$(git_current_branch "$path2")"
assert_ne "$lease_id" "$(printf '%s' "$lease2" | jq -r '.lease_id')" \
	"every acquisition gets its own lease id"
assert_file_missing "$path2/feature.txt" "the new branch is cut from the base, not from the last shift"

# The slot number, not just the path, identifies a lease.
capture pool_return "$clone" 1
assert_eq 0 "$rc"
assert_eq '[]' "$(pool_status "$clone")"

# --- returning something nobody leased is an error, not a silent no-op -----

capture pool_return "$clone" "$path"
assert_ne 0 "$rc"
assert_contains "$out" "no lease matches"

printf 'ok\n'
