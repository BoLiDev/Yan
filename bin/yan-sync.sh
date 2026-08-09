#!/usr/bin/env bash
#
# yan sync - bring a unit's integration branch up to date with its target
# (td branching.md §6.3, worktree.md §7, architecture.md §5.2).
#
#     lease a tree  →  fetch  →  rebase or merge target  →  push  →  return the tree
#
# THIS IS A SCRIPT ACTION, NOT A SHIFT. No agent is involved, and catching up
# with `target` must never be handed to a shift branch's agent: that agent sees
# only its own small change, and asking it to rebase the whole integration
# branch is a disaster (td branching.md §6.3). Its timing is fixed - sync
# before starting each new shift - so the new shift branch comes off a head
# that has just caught up, and conflicts stay in ONE place, the integration
# branch against target, instead of being scattered across every shift branch
# to be solved again and again.
#
# TWO THINGS THIS COMMAND WILL NOT DO.
#
#   1. IT NEVER RESOLVES A CONFLICT. On a conflict it undoes what it started,
#      returns the tree, prints the conflicting paths and exits 5. Resolving is
#      a shift's job (td branching.md §6.3, boundaries.md §9.3). The script's
#      one entry into a worktree is this command, and it leaves as soon as the
#      work stops being mechanical.
#
#      Why it aborts the merge and hands the tree back instead of parking the
#      conflict in the leased tree for a shift to pick up: a tree with an
#      unresolved merge in it is dirty, the pool's orphan-commit guard refuses
#      to take a dirty tree back, and there is deliberately no override for
#      that refusal anywhere in the MVP (boundaries.md §9.2). Leaving
#      it would take a slot out of the pool with no way to recover it. Nothing
#      is lost by aborting - the same merge conflicts again the moment the
#      shift runs it.
#
#   2. IT NEVER FORCE-PUSHES (boundaries.md §9.2), which is also why the
#      default strategy is `merge`. Rebasing an integration branch that has
#      already been pushed rewrites published history, and the only way to
#      publish that is a force push. --strategy rebase stays available for a
#      branch that has not been published yet; when the push is then rejected,
#      this command says so and stops rather than reaching for -f.
#
# THE POOL-FULL TRAP (td worktree.md §7, called out there by name). sync takes
# a short lease, and sync is the first step of `yan shift new`. When the pool
# is full the lease fails - and the error has to say "the pool is full, cannot
# start a new shift", NOT "sync failed", or the reader goes hunting for a
# synchronisation problem that does not exist.
#
# Exit codes: 0 fine, 2 you called this wrongly, 3 the pool is full, 5 a
# conflict needs a shift, 1 anything else.
#
set -euo pipefail

: "${YAN_HOME:?yan-sync: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-pool.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-pool.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"

RC_POOL_FULL=3
RC_CONFLICT=5

die() {
	printf 'yan sync: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan sync --task <id> --unit <name> [--strategy merge|rebase] [--json]

Leases a tree for a moment, fetches, brings the unit's integration branch up
to date with its target, pushes it, and gives the tree back.

  --strategy  merge (default) or rebase. merge is the default because a
              published integration branch can only be rebased by rewriting
              history, and force-pushing is forbidden (boundaries.md §9.2).

On a conflict this command aborts what it started, returns the tree, prints
the conflicting paths and exits 5. It never resolves a conflict: that is a
shift's job (branching.md §6.3).

When the pool is full the lease fails and this command says so as what it is -
the pool is full, no new shift can start - not as a synchronisation failure.
EOF
}

# --- arguments --------------------------------------------------------------

task=
unit=
strategy=merge
as_json=0

need_value() { # need_value <flag> <remaining-argument-count>
	if [ "$2" -lt 2 ]; then
		die "$1 needs a value" 2
	fi
}

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--task)
		need_value "$1" "$#"
		shift
		task=$1
		;;
	--unit)
		need_value "$1" "$#"
		shift
		unit=$1
		;;
	--strategy)
		need_value "$1" "$#"
		shift
		strategy=$1
		;;
	--json)
		as_json=1
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		usage >&2
		die "unexpected argument: $1" 2
		;;
	esac
	shift
done

[ -n "$task" ] || die "--task is required" 2
[ -n "$unit" ] || die "--unit is required" 2
case $strategy in
merge | rebase) ;;
*) die "--strategy is 'merge' or 'rebase', not '$strategy'" 2 ;;
esac

task_exists "$task" || die "no such task: $task" 2
task_unit_json "$task" "$unit" >/dev/null || die "no such unit: $unit in $task" 2

repo=$(task_unit_get "$task" "$unit" repo)
branch=$(task_unit_get "$task" "$unit" branch)
target=$(task_unit_get "$task" "$unit" target)

[ -n "$branch" ] || die "unit $unit has no integration branch yet - 'yan unit add' or 'yan unit set --branch' sets one" 2
[ -n "$target" ] || die "unit $unit has no target - 'yan unit set --target' sets one" 2

repo_dir() { # repo_dir <name-or-path>
	local r=$1
	if [ -d "$YAN_HOME/repos/$r" ]; then
		(cd -P "$YAN_HOME/repos/$r" >/dev/null 2>&1 && pwd)
		return 0
	fi
	if [ -d "$r" ]; then
		(cd -P "$r" >/dev/null 2>&1 && pwd)
		return 0
	fi
	die "unknown repository: $r - the unit names it, but there is no clone under repos/" 2
}

# pool_size follows the repository, not the code (td Appendix D). The seam must
# not read mem/repos.json - that is yan's own bookkeeping - so the subcommand
# reads it and passes it in, exactly as `yan tree` does.
pool_size() { # pool_size <repo-key>
	local key=$1 file=$YAN_HOME/mem/repos.json v=
	if [ -f "$file" ]; then
		v=$(jq -r --arg r "$key" '.[$r].pool_size // empty' "$file" 2>/dev/null) || v=
		v=${v//$'\r'/}
	fi
	case ${v:-} in
	'' | *[!0-9]* | 0) v=8 ;;
	esac
	printf '%s\n' "$v"
}

clone=$(repo_dir "$repo")
size=$(pool_size "${clone##*/}")
holder=$task/$unit/sync

# --- lease a tree -----------------------------------------------------------

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

rc=0
lease_json=$(pool_get "$clone" "$size" "$branch" "$branch" "$holder" 2>"$tmpdir/pool.err") || rc=$?
pool_err=$(cat "$tmpdir/pool.err" 2>/dev/null || true)

if [ "$rc" -ne 0 ]; then
	# THE POOL-FULL TRAP. Same failure, completely different thing to go and
	# look at, so it gets its own sentence and its own exit code.
	#
	# Recognising it by lib-pool's own wording is a coupling, and a deliberate
	# one: pool_get answers "full" and "it went wrong" with the same exit code,
	# and giving the pool a second one is Phase 2's file to change. The phrase
	# is pinned by tests/integration/lib-pool-limits.test.sh and
	# tests/integration/yan-tree.test.sh, so it cannot drift unnoticed.
	case $pool_err in
	*"pool is full"*)
		printf 'yan sync: the pool is full, cannot start a new shift - every tree is leased, so there is nowhere to sync %s. This is not a synchronisation problem. Run '"'"'yan tree status --repo %s'"'"' to see who holds them; a shift has to finish before another can start.\n' "$branch" "$repo" >&2
		exit "$RC_POOL_FULL"
		;;
	esac
	printf '%s\n' "$pool_err" >&2
	die "could not lease a tree for $branch"
fi

tree=$(printf '%s' "$lease_json" | jq -r '.path' | tr -d '\r')
lease_id=$(printf '%s' "$lease_json" | jq -r '.lease_id' | tr -d '\r')
[ -n "$tree" ] && [ -d "$tree" ] || die "the pool returned a path that is not a directory: ${tree:-<empty>}"

before=$(git_rev_parse "$tree" HEAD | tr -d '\r')
pushed=0
leased=1

# The lease is short and it is always given back - including on the conflict
# path. Anything this command committed but did not manage to push is undone
# first: it exists nowhere else, it is mechanical, and re-running produces it
# again. That also keeps the orphan-commit guard from having to refuse the
# return and taking a slot out of the pool with it.
cleanup() {
	local saved=$?
	if [ "$leased" -eq 1 ]; then
		git_merge "$tree" --abort >/dev/null 2>&1 || true
		git_rebase "$tree" --abort >/dev/null 2>&1 || true
		if [ "$pushed" -eq 0 ]; then
			git_reset_hard "$tree" "$before" >/dev/null 2>&1 || true
		fi
		if ! pool_return "$clone" "$tree" "$lease_id" "$holder" >/dev/null 2>&1; then
			printf 'yan sync: the tree at %s could not be returned - '"'"'yan tree status --repo %s'"'"' shows the lease; investigate before it is leased again\n' "$tree" "$repo" >&2
		fi
		leased=0
	fi
	rm -rf "$tmpdir"
	exit "$saved"
}
trap cleanup EXIT

# --- fetch ------------------------------------------------------------------

git_fetch "$tree" origin >/dev/null 2>&1 ||
	die "cannot fetch from origin - a sync without the remote's current state would be a lie"

resolves() { # resolves <ref>
	git_rev_parse "$tree" --verify --quiet "$1^{commit}" >/dev/null 2>&1
}

# Catch up with our own branch first. Other shifts merge into the integration
# branch through the forge, so origin/<branch> can be ahead of the leased tree;
# without this the push at the end would simply be rejected.
if resolves "refs/remotes/origin/$branch"; then
	if ! git_merge "$tree" "origin/$branch" --ff-only >/dev/null 2>&1; then
		printf 'yan sync: %s and origin/%s have diverged, so this is not a fast-forward\n' "$branch" "$branch" >&2
		die "the local integration branch cannot catch up with its own remote without rewriting history - dispatch a shift to reconcile them" "$RC_CONFLICT"
	fi
fi

target_ref=
if resolves "refs/remotes/origin/$target"; then
	target_ref=origin/$target
elif resolves "$target"; then
	target_ref=$target
else
	die "cannot resolve the target '$target' in the leased tree - does the branch still exist on the remote?"
fi

# --- rebase or merge --------------------------------------------------------

conflict_paths() {
	git_diff_name_only "$tree" --diff-filter=U 2>/dev/null | tr -d '\r' || true
}

hand_off() { # hand_off <what>
	local paths
	paths=$(conflict_paths)
	printf 'yan sync: %s conflicts with %s\n' "$branch" "$target_ref" >&2
	if [ -n "$paths" ]; then
		printf 'yan sync: conflicting paths:\n' >&2
		printf '%s\n' "$paths" | sed 's/^/  /' >&2
	fi
	die "$1 stopped on a conflict, and yan does not resolve conflicts - dispatch a shift to reconcile $branch with $target_ref. The merge is undone, the tree goes back to the pool, and nothing was pushed." "$RC_CONFLICT"
}

if [ "$strategy" = rebase ]; then
	git_rebase "$tree" "$target_ref" >/dev/null 2>&1 || hand_off "the rebase"
else
	git_merge "$tree" "$target_ref" --no-edit >/dev/null 2>&1 || hand_off "the merge"
fi

after=$(git_rev_parse "$tree" HEAD | tr -d '\r')

# --- push -------------------------------------------------------------------
#
# Pushing the integration branch after a sync is yan's own authority
# (boundaries.md §9.2). Never with force, and lib-git refuses one anyway.

if ! git_push "$tree" origin "$branch" >"$tmpdir/push.out" 2>&1; then
	cat -- "$tmpdir/push.out" >&2
	die "cannot push $branch - if it was rejected as non-fast-forward, someone else has moved it; re-run the sync. yan never force-pushes."
fi
pushed=1

# --- report -----------------------------------------------------------------

if [ "$before" = "$after" ]; then
	moved=false
else
	moved=true
fi

if [ "$as_json" -eq 1 ]; then
	jq -nc --arg task "$task" --arg unit "$unit" --arg branch "$branch" \
		--arg target "$target_ref" --arg strategy "$strategy" \
		--arg before "$before" --arg after "$after" --argjson moved "$moved" \
		'{task: $task, unit: $unit, branch: $branch, target: $target,
		  strategy: $strategy, before: $before, after: $after, moved: $moved}' | tr -d '\r'
elif [ "$moved" = true ]; then
	printf '%s  %s caught up with %s by %s (%s → %s) and was pushed\n' \
		"$unit" "$branch" "$target_ref" "$strategy" "${before:0:8}" "${after:0:8}"
else
	printf '%s  %s is already up to date with %s\n' "$unit" "$branch" "$target_ref"
fi
