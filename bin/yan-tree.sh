#!/usr/bin/env bash
#
# yan tree get | return | status - the entry point to the worktree pool
# (td worktree.md §7, architecture.md §5.1).
#
# The pool is part of yan, not a separate binary and not a wrapper around an
# outside tool. This file is the thin command layer: it resolves which
# repository is meant, reads pool_size from mem/repos.json (yan's own
# bookkeeping, which the seam must not read), and formats what lib-pool
# reports. Every decision that matters lives in lib-pool.sh.
#
# Exit codes: 0 fine, 2 you called this wrongly, 3 a conditional return was
# refused because the lease identity did not match (nothing was touched),
# 1 anything else.
#
set -euo pipefail

: "${YAN_HOME:?yan-tree: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-pool.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-pool.sh"

tree_die() {
	printf 'yan tree: %s\n' "$1" >&2
	exit "${2:-1}"
}

# Every line this command prints goes through tr -d '\r'.
#
# jq on Windows is a native program and writes CRLF. A value read back with
# $(...) survives, because bash drops the trailing CR with the newline, so the
# damage only shows up in what we print: `yan tree get` would emit "<path>\r"
# and the next script to read that line from a file would look for a directory
# whose name ends in a carriage return. Stripping it once, here, keeps the
# output identical on both runtimes.
tree_print() {
	tr -d '\r'
}

tree_usage() {
	cat <<'EOF'
usage: yan tree <get | return | status> --repo <repo> [options]

  get     --base <branch> --branch <branch> --holder <task/unit/sid> [--json]
          Lease a tree and cut the shift branch in it. Prints the path, or
          {path, lease_id, holder} with --json. Fails when the pool is full.

  return  (--path <path> | --slot <n>)
          [--if-lease-id <id>] [--if-lease-holder <holder>]
          Reset and clean the tree, then release the lease. The --if-* options
          are compared while the lock is held and before anything destructive
          happens; a mismatch exits 3 and touches nothing, which is what makes
          an automatic retry safe.

  status  [--json]
          Who holds what. An array with --json.

  --repo  a repository registered under repos/, or the path to a clone.

Returning a tree is `git reset --hard` plus `git clean -fd`, never with -x, so
gitignored dependencies and build caches survive into the next shift.

A return is refused when the tree has uncommitted changes, or when no remote
branch contains HEAD: that is the moment the work exists nowhere else. There is
no way to override it - stop and investigate instead.

The pool lives under ~/.yan-trees (YAN_POOL_ROOT overrides it) and its size is
pool_size in mem/repos.json, default 8.
EOF
}

tree_repo_dir() { # tree_repo_dir <name-or-path>
	local r=$1
	if [ -d "$YAN_HOME/repos/$r" ]; then
		(cd -P "$YAN_HOME/repos/$r" >/dev/null 2>&1 && pwd)
		return 0
	fi
	if [ -d "$r" ]; then
		(cd -P "$r" >/dev/null 2>&1 && pwd)
		return 0
	fi
	tree_die "unknown repository: $r - register it with 'yan repo-add', or pass the path to a clone" 2
}

tree_pool_size() { # tree_pool_size <repo-name>
	local key=$1 file=$YAN_HOME/mem/repos.json v=
	if [ -f "$file" ]; then
		v=$(jq -r --arg r "$key" '.[$r].pool_size // empty' "$file" 2>/dev/null) || v=
	fi
	case ${v:-} in
	'' | *[!0-9]* | 0) v=8 ;;
	esac
	printf '%s\n' "$v"
}

tree_need_value() { # tree_need_value <flag> <remaining-argument-count>
	if [ "$2" -lt 2 ]; then
		tree_die "$1 needs a value" 2
	fi
}

verb=${1:-}
case $verb in
'' | -h | --help | help)
	tree_usage
	exit 0
	;;
get | return | status)
	shift
	;;
*)
	printf 'yan tree: unknown verb: %s\n\n' "$verb" >&2
	tree_usage >&2
	exit 2
	;;
esac

repo=
base=
branch=
holder=
path=
slot=
if_id=
if_holder=
as_json=0

while [ $# -gt 0 ]; do
	case $1 in
	--repo)
		tree_need_value "$1" "$#"
		shift
		repo=$1
		;;
	--base)
		tree_need_value "$1" "$#"
		shift
		base=$1
		;;
	--branch)
		tree_need_value "$1" "$#"
		shift
		branch=$1
		;;
	--holder)
		tree_need_value "$1" "$#"
		shift
		holder=$1
		;;
	--path)
		tree_need_value "$1" "$#"
		shift
		path=$1
		;;
	--slot)
		tree_need_value "$1" "$#"
		shift
		slot=$1
		;;
	--if-lease-id)
		tree_need_value "$1" "$#"
		shift
		if_id=$1
		;;
	--if-lease-holder)
		tree_need_value "$1" "$#"
		shift
		if_holder=$1
		;;
	--json)
		as_json=1
		;;
	-h | --help)
		tree_usage
		exit 0
		;;
	-*)
		tree_die "unknown option: $1 - run 'yan tree --help'" 2
		;;
	*)
		if [ "$verb" = return ] && [ -z "$path" ]; then
			path=$1
		else
			tree_die "unexpected argument: $1" 2
		fi
		;;
	esac
	shift
done

[ -n "$repo" ] || tree_die "--repo is required: a repository name under repos/, or the path to a clone" 2
clone=$(tree_repo_dir "$repo") || exit $?
repo_key=${clone##*/}

rc=0
case $verb in
get)
	[ -n "$base" ] || tree_die "--base is required: a tree is always cut from an explicit integration branch" 2
	[ -n "$branch" ] || tree_die "--branch is required: leasing a tree creates the shift branch" 2
	[ -n "$holder" ] || tree_die "--holder is required, in the form <task>/<unit>/<sid>" 2
	size=$(tree_pool_size "$repo_key")
	out=$(pool_get "$clone" "$size" "$base" "$branch" "$holder") || rc=$?
	[ "$rc" -eq 0 ] || exit "$rc"
	if [ "$as_json" -eq 1 ]; then
		printf '%s\n' "$out" | jq . | tree_print
	else
		printf '%s\n' "$out" | jq -r '.path' | tree_print
	fi
	;;
return)
	target=$path
	if [ -z "$target" ]; then
		target=$slot
	fi
	[ -n "$target" ] || tree_die "which tree? pass --path <path> (what 'yan tree get' printed) or --slot <n>" 2
	out=$(pool_return "$clone" "$target" "$if_id" "$if_holder") || rc=$?
	[ "$rc" -eq 0 ] || exit "$rc"
	printf 'returned %s\n' "$out"
	;;
status)
	arr=$(pool_status "$clone") || rc=$?
	[ "$rc" -eq 0 ] || exit "$rc"
	if [ "$as_json" -eq 1 ]; then
		printf '%s\n' "$arr" | jq . | tree_print
	else
		size=$(tree_pool_size "$repo_key")
		printf '%s\n' "$arr" | jq -r '.[] | "slot \(.slot)\t\(.holder)\t\(.branch)\t\(.path)"' | tree_print
		printf '%s of %s trees leased\n' "$(printf '%s\n' "$arr" | jq 'length')" "$size"
	fi
	;;
esac
