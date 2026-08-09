#!/usr/bin/env bash
#
# yan unit add - add a unit and make its integration branch exist
# (td branching.md §6.4-§6.5, boundaries.md §10, architecture.md §5.2).
#
# One unit is one sub-application is one branch is one tree. Adding one settles
# two things, and the second is not yan's to settle alone:
#
#   target   MUST BE GIVEN EXPLICITLY. There is no default and there must not
#            be one (td branching.md §6.4): during a big release the team keeps
#            a shared branch and everyone merges into it, and in quiet periods
#            everyone merges into master. A tool that guessed would be wrong
#            about half the time, silently, and the mistake would only surface
#            at the outbound MR.
#
#   branch   `user`'s decision (td branching.md §6.5), supplied in one of three
#            ways, checked in this order:
#
#              --branch <name>      user said it outright; used AS IS, any
#                                   shape is fine, and the round number plays
#                                   no part
#              conf/hooks/branch-name  the team's own tooling answers
#              neither              the built-in default,
#                                   yan/<task>-<unit>-r<n>, n = len(history)+1
#
#            IF THE HOOK EXITS NON-ZERO, THIS COMMAND STOPS AND REPORTS. It
#            never falls back to the built-in default (td boundaries.md §10).
#            Silently creating a branch that breaks the team's rules - and may
#            not be mergeable at all - is far worse than failing outright.
#
# The branch then has to exist. Already there, locally or on the remote, and it
# is adopted; absent, and it is cut from the base (the target, unless --base
# says otherwise). Note what "adopted" means here: a ref is created in the main
# clone, never a checkout. boundaries.md §9.1 allows exactly one write under
# repos/ - `git fetch` - and forbids checking out, touching the working tree
# and committing. Working trees come from the pool, not from the main clone.
#
# yan does not parse the resulting name (td branching.md §6.6). It stores it in
# unit.branch and that is where ownership is looked up afterwards.
#
# Exit codes: 0 fine, 2 you called this wrongly, 1 it did not work.
#
set -euo pipefail

: "${YAN_HOME:?yan-unit-add: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"
# shellcheck source=bin/lib-hook.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-hook.sh"

die() {
	printf 'yan unit add: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan unit add --task <id> --unit <name> --repo <repo> --target <branch>
                    [--branch <name>] [--base <ref>] [--mode scout|branch|mr]
                    [--scope <path>]... [--needs <unit>]... [--json]

  --target  REQUIRED, and never defaulted: which branch this unit's work is
            ultimately delivered into. There is no safe default (branching.md
            §6.4) - during a release the team merges into a shared branch, in
            quiet periods into master.
  --branch  the integration branch's name. Omit it and yan asks
            conf/hooks/branch-name; with no hook installed the built-in
            default is yan/<task>-<unit>-r<n>. A name that was given, or that
            the hook returned, is used exactly as it stands.
  --base    what to cut the branch from when it does not exist yet.
            Defaults to --target.
  --scope   repeatable; the paths this unit is allowed to touch.
  --needs   repeatable; unit names that must land before this one.

If the branch-name hook exits non-zero, this command stops and reports. It
never falls back to the built-in default.
EOF
}

# --- arguments --------------------------------------------------------------

task=
unit=
repo=
target=
branch=
base=
mode=
as_json=0
scope=()
needs=()

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
	--repo)
		need_value "$1" "$#"
		shift
		repo=$1
		;;
	--target)
		need_value "$1" "$#"
		shift
		target=$1
		;;
	--branch)
		need_value "$1" "$#"
		shift
		branch=$1
		;;
	--base)
		need_value "$1" "$#"
		shift
		base=$1
		;;
	--mode)
		need_value "$1" "$#"
		shift
		mode=$1
		;;
	--scope)
		need_value "$1" "$#"
		shift
		scope+=("$1")
		;;
	--needs)
		need_value "$1" "$#"
		shift
		needs+=("$1")
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
[ -n "$repo" ] || die "--repo is required: a repository under repos/, or the path to a clone" 2

# The one argument with no default anywhere in yan.
[ -n "$target" ] ||
	die "--target is required and is never guessed: say which branch this unit delivers into (branching.md §6.4 - a release period and a quiet period have different answers, so there is no safe default)" 2

task_exists "$task" || die "no such task: $task - create it first" 2
if task_unit_json "$task" "$unit" >/dev/null 2>&1; then
	die "unit already exists: $unit - 'yan unit set' changes one, 'yan ls $task' shows them"
fi

# --- the repository ---------------------------------------------------------

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
	die "unknown repository: $r - register it with 'yan repo-add', or pass the path to a clone" 2
}

clone=$(repo_dir "$repo")

# --- the branch name --------------------------------------------------------
#
# The hook is asked only when yan would otherwise have to invent a name. A
# name `user` typed is already `user`'s decision, and the hook is one way of
# supplying that decision, not a second owner of it (td branching.md §6.5).

# n is the round number: len(history) + 1, so it needs no storage of its own.
# A unit that is only now being added has no history, so this is r1 - but the
# expression is written once, here and in `yan unit set`, because that is the
# rule and not a coincidence.
round=1

if [ -z "$branch" ]; then
	if [ "${#scope[@]}" -gt 0 ]; then
		scope_json=$(printf '%s\n' "${scope[@]}" | jq -Rnc '[inputs]')
	else
		scope_json='[]'
	fi
	ctx=$(jq -nc \
		--arg task "$task" \
		--arg task_title "$(task_title "$task")" \
		--arg unit "$unit" \
		--arg repo "$repo" \
		--arg target "$target" \
		--argjson round "$round" \
		--argjson scope "$scope_json" \
		'{task: $task, task_title: $task_title, unit: $unit, repo: $repo,
		  target: $target, scope: $scope, round: $round}' | tr -d '\r')

	hook_rc=0
	branch=$(hook_call branch-name "$ctx") || hook_rc=$?
	case $hook_rc in
	0)
		source_of_name=hook
		;;
	"$HOOK_RC_MISSING")
		# No outside authority is configured. That is not an error; it is the
		# ordinary case, and the built-in default applies.
		branch="yan/$task-$unit-r$round"
		source_of_name=default
		;;
	*)
		# THE ONE RULE THIS COMMAND EXISTS TO HOLD. The hook refused, so we
		# stop. Falling back here would create a branch the team's own tooling
		# has just rejected (boundaries.md §10).
		die "the branch-name hook refused, so no unit was added - ask 'user' how this unit's integration branch should be named, then pass it with --branch. yan will not fall back to its built-in default when an outside authority has said no"
		;;
	esac
else
	source_of_name=user
fi

case $branch in
*[[:space:]]* | -*)
	die "the integration branch name '$branch' is not usable as a git ref - fix the hook, or pass --branch" 2
	;;
esac

# --- make it exist ----------------------------------------------------------

[ -n "$base" ] || base=$target

# git fetch is the ONE write allowed inside a main clone (boundaries.md §9.1).
# It may legitimately fail offline, so it warns rather than stopping: the local
# refs are then simply older than they could be.
if ! git_fetch "$clone" origin >/dev/null 2>&1; then
	printf 'yan unit add: could not fetch %s - working from the refs already in the clone\n' "$repo" >&2
fi

# remote_ref <branch> - prints origin/<branch> when it resolves.
#
# origin/ is preferred over a local ref of the same name wherever both exist,
# because a main clone is never checked out or pulled - the only write allowed
# in it is a fetch (boundaries.md §9.1) - so its own `main` is whatever it was
# on the day it was cloned, while origin/main is current.
remote_ref() {
	if git_rev_parse "$clone" --verify --quiet "refs/remotes/origin/$1" >/dev/null 2>&1; then
		printf 'origin/%s\n' "$1"
	fi
}

if git_branch_exists "$clone" "$branch"; then
	how="adopted the existing local branch"
elif [ -n "$(remote_ref "$branch")" ]; then
	# "The branch already exists on the remote -> check it out" (boundaries.md
	# §10), done the only way a main clone allows: a ref, never a checkout.
	git_create_branch "$clone" "$branch" "origin/$branch" >/dev/null ||
		die "cannot create a local ref for the existing remote branch '$branch'"
	how="adopted origin/$branch"
else
	base_ref=$(remote_ref "$base")
	if [ -z "$base_ref" ]; then
		if git_branch_exists "$clone" "$base"; then
			base_ref=$base
		elif git_rev_parse "$clone" --verify --quiet "$base^{commit}" >/dev/null 2>&1; then
			base_ref=$base
		else
			die "cannot resolve the base '$base' in $clone - fetch it, or pass --base with something that exists"
		fi
	fi
	git_create_branch "$clone" "$branch" "$base_ref" >/dev/null ||
		die "cannot cut '$branch' from '$base_ref' in $clone"
	how="cut from $base_ref"
fi

# --- record it --------------------------------------------------------------

add_args=(--branch "$branch")
if [ -n "$mode" ]; then
	add_args+=(--mode "$mode")
fi
if [ "${#scope[@]}" -gt 0 ]; then
	for p in "${scope[@]}"; do
		add_args+=(--scope "$p")
	done
fi
if [ "${#needs[@]}" -gt 0 ]; then
	for n in "${needs[@]}"; do
		add_args+=(--needs "$n")
	done
fi

task_unit_add "$task" "$unit" "$repo" "$target" "${add_args[@]}" ||
	die "the branch '$branch' is ready in $clone, but task.json was not updated - fix the error above and re-run"

log_append "$task" "$unit  unit added on $branch → $target ($how; name from $source_of_name)" ||
	printf 'yan unit add: the unit was written but log.md was not appended to\n' >&2

if [ "$as_json" -eq 1 ]; then
	jq -nc --arg task "$task" --arg unit "$unit" --arg branch "$branch" \
		--arg target "$target" --arg src "$source_of_name" --arg how "$how" \
		'{task: $task, unit: $unit, branch: $branch, target: $target,
		  name_from: $src, branch_state: $how}' | tr -d '\r'
else
	printf '%s  %s → %s  (%s, name from %s)\n' "$unit" "$branch" "$target" "$how" "$source_of_name"
fi
