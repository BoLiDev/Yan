#!/usr/bin/env bash
#
# `yan tree get | return | status` end to end, through bin/yan's dispatch.
#
# This is the layer the agents and `user` actually call, so it is also where
# the two contracts that face outward are pinned down: the --json shapes, and
# pool_size coming from mem/repos.json rather than a constant in the code.
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

pool_root=$tmp/trees
bare=$tmp/remote.git
clone=$home/repos/demo
mk_bare_remote "$bare"
mk_clone "$bare" "$clone"

# pool_size lives with the repository, not in the code (td Appendix D).
cat >"$home/mem/repos.json" <<JSON
{
  "version": 1,
  "demo": { "url": "$bare", "mode_default": "mr", "pool_size": 1 }
}
JSON

yan() { # yan <args...> - run the subcommand with a private pool root
	env YAN_HOME="$home" YAN_POOL_ROOT="$pool_root" bash "$YAN" "$@"
}

# --- an empty pool ----------------------------------------------------------

capture yan tree status --repo demo --json
assert_eq 0 "$rc"
assert_eq 0 "$(printf '%s' "$out" | jq 'length')"

# --- get --------------------------------------------------------------------

capture yan tree get --repo demo --base main --branch shift/s1 --holder t1/u1/s1 --json
assert_eq 0 "$rc" "$out"
assert_eq 'holder,lease_id,path' "$(printf '%s' "$out" | jq -r 'keys | join(",")')"

path=$(printf '%s' "$out" | jq -r '.path')
lease_id=$(printf '%s' "$out" | jq -r '.lease_id')
assert_eq t1/u1/s1 "$(printf '%s' "$out" | jq -r '.holder')"
assert_file_exists "$path/README.md"
assert_contains "$path" "$pool_root"

# --- pool_size really comes from mem/repos.json -----------------------------

capture yan tree get --repo demo --base main --branch shift/s2 --holder t1/u1/s2
assert_ne 0 "$rc" "pool_size 1 means the second get is refused"
assert_contains "$out" "pool is full"

# --- status -----------------------------------------------------------------

capture yan tree status --repo demo
assert_eq 0 "$rc"
assert_contains "$out" "t1/u1/s1"
assert_contains "$out" "shift/s1"
assert_contains "$out" "1 of 1 trees leased"

capture yan tree status --repo demo --json
assert_eq 1 "$(printf '%s' "$out" | jq 'length')"
assert_eq "$lease_id" "$(printf '%s' "$out" | jq -r '.[0].lease_id')"

# --- conditional return -----------------------------------------------------

capture yan tree return --repo demo --path "$path" --if-lease-id deadbeefdeadbeef
assert_eq 3 "$rc" "a mismatched lease id exits 3"
assert_contains "$out" "nothing was touched"

capture yan tree return --repo demo --path "$path" --if-lease-holder other/u/s
assert_eq 3 "$rc"

capture yan tree status --repo demo --json
assert_eq 1 "$(printf '%s' "$out" | jq 'length')" "a refused return leaves the lease in place"

capture yan tree return --repo demo --path "$path" --if-lease-id "$lease_id" --if-lease-holder t1/u1/s1
assert_eq 0 "$rc" "$out"
assert_contains "$out" "returned"

capture yan tree status --repo demo --json
assert_eq 0 "$(printf '%s' "$out" | jq 'length')"

# --- plain get prints the path, and --slot identifies a lease ---------------

yan tree get --repo demo --base main --branch shift/s3 --holder t1/u1/s3 >"$tmp/get.out"
assert_eq "$path" "$(cat "$tmp/get.out")" "without --json, get prints the path and nothing else"

# jq on Windows is a native program and writes CRLF. $(...) hides it for a
# single value, so this is checked against the RAW bytes: a path with a
# trailing carriage return names no directory anywhere.
assert_fail grep -q $'\r' "$tmp/get.out" "yan tree get printed a carriage return"

yan tree status --repo demo --json >"$tmp/status.json"
assert_fail grep -q $'\r' "$tmp/status.json" "pretty-printed json carried carriage returns"
assert_eq 1 "$(jq 'length' "$tmp/status.json")"

yan tree status --repo demo >"$tmp/status.txt"
assert_fail grep -q $'\r' "$tmp/status.txt" "the status table carried carriage returns"

capture yan tree return --repo demo --slot 1
assert_eq 0 "$rc" "$out"

# --- calling it wrongly -----------------------------------------------------

capture yan tree
assert_eq 0 "$rc"
assert_contains "$out" "usage: yan tree"

capture yan tree bogus --repo demo
assert_eq 2 "$rc"
assert_contains "$out" "unknown verb"

capture yan tree get --repo demo --branch shift/x --holder t/u/x
assert_eq 2 "$rc"
assert_contains "$out" "--base is required"

capture yan tree get --repo demo --base main --holder t/u/x
assert_eq 2 "$rc"
assert_contains "$out" "--branch is required"

capture yan tree get --repo demo --base main --branch shift/x
assert_eq 2 "$rc"
assert_contains "$out" "--holder is required"

capture yan tree status
assert_eq 2 "$rc"
assert_contains "$out" "--repo is required"

capture yan tree status --repo nope
assert_eq 2 "$rc"
assert_contains "$out" "unknown repository"

capture yan tree return --repo demo
assert_eq 2 "$rc"
assert_contains "$out" "which tree?"

capture yan tree get --repo demo --base
assert_eq 2 "$rc"
assert_contains "$out" "needs a value"

# There is no force escape hatch in the MVP: boundaries.md §9.2 forbids it and
# the orphan-commit guard is the last line of defence.
capture yan tree return --repo demo --slot 1 --force
assert_eq 2 "$rc"
assert_contains "$out" "unknown option"

# --- a clone given by path works too, so the pool is usable before repo-add -

capture yan tree get --repo "$clone" --base main --branch shift/s4 --holder t1/u1/s4
assert_eq 0 "$rc" "$out"
assert_eq "$path" "$out"
capture yan tree return --repo "$clone" --path "$path"
assert_eq 0 "$rc" "$out"

printf 'ok\n'
