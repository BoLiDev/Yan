#!/usr/bin/env bash
#
# The pool's contract, checked without touching git.
#
# Two kinds of check live here. The runtime ones prove the seam refuses to be
# called wrongly. The source-level ones guard the invariants that never fail
# loudly when they break: -x creeping into the clean, a seam calling another
# seam, the pool writing bookkeeping under $YAN_HOME, and the path
# normalisation that only misbehaves on one of the two runtimes.
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

LIBPOOL=$YAN_REPO_ROOT/bin/lib-pool.sh
TREE=$YAN_REPO_ROOT/bin/yan-tree.sh

# --- the three functions of the seam exist ---------------------------------

for fn in pool_get pool_return pool_status; do
	assert_ok declare -F "$fn"
done

# --- calling them wrongly exits 2 ------------------------------------------

capture pool_get
assert_eq 2 "$rc"
assert_contains "$out" "usage: pool_get"

capture pool_return
assert_eq 2 "$rc"
assert_contains "$out" "usage: pool_return"

capture pool_status
assert_eq 2 "$rc"
assert_contains "$out" "usage: pool_status"

mkdir -p "$tmp/notarepo"
capture pool_get "$tmp/notarepo" 0 main shift/x t/u/x
assert_eq 2 "$rc" "a pool size of zero is a caller error"
assert_contains "$out" "positive whole number"

capture pool_get "$tmp/notarepo" 2 main '' t/u/x
assert_eq 2 "$rc"
assert_contains "$out" "detached HEAD" "the reason a branch is required is worth saying"

capture pool_get "$tmp/notarepo" 2 main shift/x ''
assert_eq 2 "$rc"
assert_contains "$out" "<task>/<unit>/<sid>"

capture pool_get "$tmp/does-not-exist" 2 main shift/x t/u/x
assert_eq 2 "$rc"
assert_contains "$out" "not a directory"

capture pool_return "$tmp/notarepo" ''
assert_eq 2 "$rc"

# --- an empty pool answers, it does not fail -------------------------------

assert_eq '[]' "$(pool_status "$tmp/notarepo")"
assert_eq 3 "$POOL_RC_MISMATCH" "a refused conditional return has its own exit code"

# --- the pool lives outside $YAN_HOME, and YAN_POOL_ROOT moves it ----------

dir=$(pool_dir "$tmp/notarepo")
assert_contains "$dir" "/notarepo-" "the pool directory is <repo>-<hash>"
assert_not_contains "$dir" "$YAN_HOME"
assert_contains "$dir" "trees" "YAN_POOL_ROOT decides where the pool lives"

# Two clones with the same basename get two pools.
mkdir -p "$tmp/a/notarepo" "$tmp/b/notarepo"
assert_ne "$(pool_dir "$tmp/a/notarepo")" "$(pool_dir "$tmp/b/notarepo")"

# --- path normalisation ----------------------------------------------------
#
# On Git Bash the shell says /tmp/x and git.exe says C:/Users/.../Temp/x for
# the same directory, so a path the pool built never string-matches one git
# printed. _pool_key is what makes the two comparable; on Linux it is the
# identity function and this still has to hold.

assert_eq "$(_pool_key "$tmp")" "$(_pool_key "$(native_path "$tmp")")" \
	"a path we built and the same path as a native tool prints it must compare equal"
assert_eq "$(_pool_key "$tmp")" "$(_pool_key "$tmp/")" "a trailing slash is not a different directory"
assert_ne "$(_pool_key "$tmp")" "$(_pool_key "$tmp/elsewhere")"

# --- source-level invariants ------------------------------------------------

# The clean is git_clean_fd's, and -x never appears next to a clean.
assert_ok grep -q 'git_clean_fd' "$LIBPOOL"
capture grep -nE 'clean[^;&|]*-[a-zA-Z]*x' "$LIBPOOL"
assert_ne 0 "$rc" "the pool must never clean with -x: $out"

# Seams never call each other (architecture.md §2). lib-git is a stateless
# utility, so that edge is allowed and is the only one.
capture grep -nE 'lib-(term|forge|hook)' "$LIBPOOL"
assert_ne 0 "$rc" "lib-pool must not source another seam: $out"
assert_ok grep -q 'lib-git.sh' "$LIBPOOL"

# A seam never writes yan's bookkeeping: every mention of YAN_HOME in the
# library is a sourcing line and nothing else (architecture.md §4.3).
while IFS= read -r line; do
	[ -n "$line" ] || continue
	assert_contains "$line" '${YAN_LIB:-$YAN_HOME/bin}' \
		"lib-pool may name YAN_HOME only when sourcing a library"
done < <(grep -n 'YAN_HOME' "$LIBPOOL" | grep -v '^[0-9]*:#' || true)

# git runs through lib-git, never directly from the pool. Comments are
# stripped first, because they talk about git commands on purpose.
grep -v '^[[:space:]]*#' "$LIBPOOL" >"$tmp/pool-code" || true
capture grep -nE '(^|[;&|(]|\$\()[[:space:]]*git[[:space:]]' "$tmp/pool-code"
assert_ne 0 "$rc" "lib-pool must run git only through lib-git: $out"

# The subcommand is a thin layer: it holds no git of its own.
grep -v '^[[:space:]]*#' "$TREE" >"$tmp/tree-code" || true
capture grep -nE '(^|[;&|(]|\$\()[[:space:]]*(git|mkdir)[[:space:]]' "$tmp/tree-code"
assert_ne 0 "$rc" "yan-tree.sh must leave git and the file system to lib-pool: $out"

printf 'ok\n'
