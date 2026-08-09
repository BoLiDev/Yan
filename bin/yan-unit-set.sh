#!/usr/bin/env bash
#
# yan unit set - change a unit's branch, target, mode or scope
# (td branching.md §6.3-§6.4, boundaries.md §9.2, architecture.md §5.1).
#
# EVERY ONE OF THESE FOUR IS A DECISION, so `user` has to ask for it
# (boundaries.md §9.2). That authority lives in AGENTS.md, where the model is
# told not to run this on its own initiative. What this file guarantees is the
# other half: the command never invents a value. Nothing here has a default,
# nothing is guessed, and the one thing that could be guessed - how the round
# that is being replaced ended - is asked of the forge, not of the caller.
#
# --branch is the hard one, and it is ONE ATOMIC OPERATION (architecture.md
# §5.1). The integration branch is not long-lived: a round is delivered or
# abandoned and work continues on a NEW branch (td branching.md §6.3). Starting
# that new round is:
#
#     decide `end`  →  append the current branch/target/mr to history[] with
#     `at`  →  overwrite the current fields  →  add a line to log.md
#
# The middle two happen inside lib-task's task_unit_rotate, in a single
# tmp -> mv, so the file is never left with the old round archived but the new
# branch not yet recorded.
#
# `end` is not a flag to be remembered. It is looked up (td branching.md §6.4):
#
#     merged                      -> delivered
#     closed, or mr was empty     -> abandoned
#     still open                  -> NOT OVER. Ask `user` first.
#     unreachable                 -> ask `user`.
#
# The last two stop the command. They are the two cases where a wrong answer
# gets written into an append-only history and can never be corrected, so the
# command refuses to decide and says what to ask. When `user` has answered,
# --end carries the answer back in. --end is therefore not a way around the
# lookup; it is the only way `user`'s answer can reach the history at all.
# Once the conclusion is written, the forge is never asked about that round
# again - the history has to explain itself.
#
# AND AN ABANDONED ROUND MUST SAY WHY (td branching.md §6.4). --reason is
# required for `abandoned`, because the reason for a normal rotation is obvious
# from context - it shipped, or feedback came in - and the reason for dropping
# something is exactly the one that gets forgotten.
#
# Exit codes: 0 fine, 2 you called this wrongly, 4 this needs `user` to answer
# a question first (nothing was changed), 1 anything else.
#
set -euo pipefail

: "${YAN_HOME:?yan-unit-set: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"
# shellcheck source=bin/lib-hook.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-hook.sh"
# shellcheck source=bin/lib-forge.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-forge.sh"

# Nothing was changed; a person has to answer something first.
RC_ASK_USER=4

die() {
	printf 'yan unit set: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan unit set --task <id> --unit <name> [changes]

changes (at least one):
  --branch [<name>]   start a NEW ROUND on that integration branch. With no
                      name, yan asks conf/hooks/branch-name, and with no hook
                      falls back to yan/<task>-<unit>-r<n>. The old round is
                      archived into history[] in the same write.
  --target <branch>   where this unit delivers. Changing it usually means the
                      integration branch has to be rebased onto the new
                      target, which may need a shift.
  --mode <m>          scout | branch | mr
  --scope <path>      repeatable; REPLACES the whole scope list

for --branch only:
  --base <ref>        what to cut the new branch from when it does not exist.
                      Defaults to --target when the old round was delivered,
                      and to the OLD BRANCH when it was abandoned, so the
                      abandoned work is not lost (branching.md §6.3).
  --end <e>           delivered | abandoned. Only needed when the forge says
                      the round is still open, or cannot be reached: yan
                      refuses to decide those two, and this is how `user`'s
                      answer comes back.
  --reason <text>     REQUIRED when the round ends as `abandoned`. It goes into
                      log.md, because six months later nobody remembers why a
                      round stops dead in the history.
  --at <YYYY-MM-DD>   the retirement date recorded in history[]. Defaults to
                      today.

Every one of these is a decision: `user` has to ask for it (boundaries.md §9.2).
EOF
}

# --- arguments --------------------------------------------------------------

task=
unit=
branch=
want_branch=0
target=
mode=
base=
end=
reason=
at=
as_json=0
scope=()
want_scope=0

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
	--branch)
		# The value is optional, and that is deliberate: `--branch <name>` is
		# "use this name", bare `--branch` is "start a new round and let the
		# configured authority name it". A git branch may not begin with a
		# dash, so the next word starting with one is never a name.
		want_branch=1
		if [ "$#" -ge 2 ]; then
			case $2 in
			-*) ;;
			*)
				shift
				branch=$1
				;;
			esac
		fi
		;;
	--target)
		need_value "$1" "$#"
		shift
		target=$1
		;;
	--mode)
		need_value "$1" "$#"
		shift
		mode=$1
		;;
	--base)
		need_value "$1" "$#"
		shift
		base=$1
		;;
	--end)
		need_value "$1" "$#"
		shift
		end=$1
		;;
	--reason)
		need_value "$1" "$#"
		shift
		reason=$1
		;;
	--at)
		need_value "$1" "$#"
		shift
		at=$1
		;;
	--scope)
		need_value "$1" "$#"
		shift
		want_scope=1
		scope+=("$1")
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
if [ "$want_branch" -eq 0 ] && [ -z "$target" ] && [ -z "$mode" ] && [ "$want_scope" -eq 0 ]; then
	usage >&2
	die "nothing to change - pass --branch, --target, --mode or --scope" 2
fi

case $end in
'' | delivered | abandoned) ;;
*) die "--end is 'delivered' or 'abandoned', not '$end'" 2 ;;
esac
if [ -n "$end" ] && [ "$want_branch" -eq 0 ]; then
	die "--end only applies to --branch: it says how the round being replaced finished" 2
fi

task_exists "$task" || die "no such task: $task" 2
task_unit_json "$task" "$unit" >/dev/null || die "no such unit: $unit in $task" 2

repo=$(task_unit_get "$task" "$unit" repo)

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

changed=()

# --- --branch: one round ends and the next begins ---------------------------

if [ "$want_branch" -eq 1 ]; then
	clone=$(repo_dir "$repo")
	old_branch=$(task_unit_get "$task" "$unit" branch)
	old_target=$(task_unit_get "$task" "$unit" target)
	mr=$(task_unit_get "$task" "$unit" mr)
	rounds=$(task_unit_rounds "$task" "$unit")
	# The round number of whatever is in unit.branch right now is
	# len(history) + 1 (td branching.md §6.5). This rotation appends one entry,
	# so the round being STARTED is len(history) + 2. Getting this wrong is not
	# cosmetic: the built-in default would hand back the name of the branch
	# being replaced, which is exactly the collision the round number exists to
	# prevent - the same branch name cannot be created twice.
	retiring=$((rounds + 1))
	round=$((rounds + 2))

	[ -n "$old_branch" ] ||
		die "this unit has no current branch to replace - 'yan unit add' should have set one"

	# --- decide `end` -------------------------------------------------------
	if [ -n "$end" ]; then
		end_from="user"
	elif [ -z "$mr" ]; then
		# No outbound MR was ever opened for this round, so there is nothing
		# that could have been delivered (td branching.md §6.4).
		end=abandoned
		end_from="no mr was ever opened"
	else
		# A forge that errors and a forge that answers `unknown` mean the same
		# thing here - we cannot tell how the round ended - so both land in
		# the same branch below.
		state=$(forge_mr_state --mr "$mr" --dir "$clone" 2>/dev/null) || state=unknown
		case $state in
		merged)
			end=delivered
			end_from="the forge says $mr is merged"
			;;
		closed)
			end=abandoned
			end_from="the forge says $mr is closed"
			;;
		open)
			die "this round is NOT OVER: $mr is still open on the forge. Ask 'user' first - should it be abandoned, or was replacing the branch a mistake? If it is to be abandoned, re-run with --end abandoned --reason '<why>'. Nothing was changed." "$RC_ASK_USER"
			;;
		*)
			die "cannot tell how this round ended: the forge could not be reached, or $mr no longer exists. Ask 'user' whether it was delivered or abandoned, then re-run with --end <delivered|abandoned> (and --reason for abandoned). Nothing was changed." "$RC_ASK_USER"
			;;
		esac
	fi

	# An abandoned round has to say why (td branching.md §6.4).
	if [ "$end" = abandoned ] && [ -z "$reason" ]; then
		die "--reason is required when a round is abandoned: log.md has to say why, because that is the one thing nobody remembers six months later. ($end_from.) Nothing was changed." 2
	fi

	# --- the new branch's name ---------------------------------------------
	if [ -z "$branch" ]; then
		ctx=$(jq -nc \
			--arg task "$task" \
			--arg task_title "$(task_title "$task")" \
			--arg unit "$unit" \
			--arg repo "$repo" \
			--arg target "${target:-$old_target}" \
			--argjson round "$round" \
			--argjson scope "$(task_unit_json "$task" "$unit" | jq -c '.scope // []')" \
			'{task: $task, task_title: $task_title, unit: $unit, repo: $repo,
			  target: $target, scope: $scope, round: $round}' | tr -d '\r')

		hook_rc=0
		branch=$(hook_call branch-name "$ctx") || hook_rc=$?
		case $hook_rc in
		0) name_from=hook ;;
		"$HOOK_RC_MISSING")
			branch="yan/$task-$unit-r$round"
			name_from=default
			;;
		*)
			die "the branch-name hook refused, so the round was not rotated - ask 'user' what the new integration branch should be called and pass it with --branch <name>. yan never falls back to its built-in default once an outside authority has said no."
			;;
		esac
	else
		name_from=user
	fi

	if [ "$branch" = "$old_branch" ]; then
		die "the new integration branch is the same as the current one ($branch) - a round is replaced by a DIFFERENT branch (branching.md §6.3)" 2
	fi
	case $branch in
	*[[:space:]]* | -*)
		die "'$branch' is not usable as a git ref" 2
		;;
	esac

	# --- make it exist ------------------------------------------------------
	#
	# The base is not a detail. td branching.md §6.3: a delivered round is
	# followed by a branch off `target`, which already contains it; an
	# abandoned round is followed by a branch off THE OLD BRANCH ITSELF, so
	# the work that was dropped is still there to pick over.
	if [ -z "$base" ]; then
		if [ "$end" = abandoned ]; then
			base=$old_branch
		else
			base=${target:-$old_target}
		fi
	fi

	if ! git_fetch "$clone" origin >/dev/null 2>&1; then
		printf 'yan unit set: could not fetch %s - working from the refs already in the clone\n' "$repo" >&2
	fi

	# origin/ wins over a local ref of the same name: a main clone is never
	# checked out or pulled, so its own branches are as old as the clone while
	# the remote-tracking refs were just fetched. An integration branch's local
	# ref is the exception - worktrees share the ref store, so `yan sync` moves
	# it - and there origin/ and local agree because sync pushes.
	remote_ref() { # remote_ref <branch>
		if git_rev_parse "$clone" --verify --quiet "refs/remotes/origin/$1" >/dev/null 2>&1; then
			printf 'origin/%s\n' "$1"
		fi
	}

	if git_branch_exists "$clone" "$branch"; then
		how="adopted the existing local branch"
	elif [ -n "$(remote_ref "$branch")" ]; then
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
				die "cannot resolve the base '$base' in $clone - pass --base with something that exists"
			fi
		fi
		git_create_branch "$clone" "$branch" "$base_ref" >/dev/null ||
			die "cannot cut '$branch' from '$base_ref' in $clone"
		how="cut from $base_ref"
	fi

	# --- the atomic part ----------------------------------------------------
	task_unit_rotate "$task" "$unit" "$end" "$branch" "$at" ||
		die "the round was NOT rotated - task.json is untouched"

	if [ "$end" = abandoned ]; then
		log_append "$task" "$unit  abandoned $old_branch → $branch (based on $base; $reason)" ||
			printf 'yan unit set: task.json was updated but log.md was not appended to\n' >&2
	else
		log_append "$task" "$unit  delivered $old_branch → $branch (based on $base${reason:+; $reason})" ||
			printf 'yan unit set: task.json was updated but log.md was not appended to\n' >&2
	fi
	changed+=("round $retiring $end on $old_branch; round $round is now $branch ($how, name from $name_from)")
fi

# --- the three plain scalars -------------------------------------------------
#
# These run after the rotation on purpose: the history entry has to record the
# target the RETIRED round actually used, not the one the next round will.

if [ -n "$target" ]; then
	old=$(task_unit_get "$task" "$unit" target)
	task_unit_set "$task" "$unit" target "$target" || die "could not set target"
	log_append "$task" "$unit  target $old → $target" || true
	changed+=("target=$target")
fi

if [ -n "$mode" ]; then
	old=$(task_unit_get "$task" "$unit" mode)
	task_unit_set "$task" "$unit" mode "$mode" || die "could not set mode" 2
	log_append "$task" "$unit  mode $old → $mode" || true
	changed+=("mode=$mode")
fi

if [ "$want_scope" -eq 1 ]; then
	task_unit_set_scope "$task" "$unit" "${scope[@]}" || die "could not set scope"
	log_append "$task" "$unit  scope → ${scope[*]}" || true
	changed+=("scope=${scope[*]}")
fi

if [ "$as_json" -eq 1 ]; then
	task_unit_json "$task" "$unit"
else
	printf '%s %s  %s\n' "$task" "$unit" "${changed[*]}"
fi
