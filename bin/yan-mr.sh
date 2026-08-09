#!/usr/bin/env bash
#
# yan mr - open the OUTBOUND merge request, integration branch -> target
# (td delivery.md §8.2, boundaries.md §9.2, branching.md §6.2/§6.4,
# architecture.md §5.1).
#
# ---------------------------------------------------------------------------
# WHY THIS IS A SEPARATE COMMAND FROM `yan land`
# ---------------------------------------------------------------------------
#
# Authority, and nothing else. boundaries.md §9.2:
#
#   open the outbound MR from the integration branch to `target`
#                                        yan, ON ITS OWN, because opening an
#                                        MR is reversible
#   merge the outbound MR into `target`  `user` HAS TO ASK FOR IT
#
# Two rows of that table, two files. Splitting them is the whole point: `yan`
# may run this one without being told, because an MR that should not exist can
# be closed and nothing outside `user`'s own branches has changed. It may not
# run `yan land`, because that writes into `target`, which colleagues own.
#
# The two levels of review (branching.md §6.2) are why this MR matters: shift
# branches merge into the integration branch as internal checkpoints that
# nobody outside sees, and THIS is the single MR colleagues review. Its size is
# the size of the unit (branching.md §6.7).
#
# ---------------------------------------------------------------------------
# WHAT IT DOES NOT DO
# ---------------------------------------------------------------------------
#
#   * it does not push. Pushing the integration branch is `yan sync`'s step,
#     and duplicating it here would give that write two owners. If the branch
#     is not on the remote yet, this says so and stops;
#   * it does not comment on anything, and it never mentions anyone
#     (boundaries.md §9.2: that interrupts colleagues, so `user` has to ask);
#   * it does not know which forge this machine uses. Everything remote goes
#     through lib-forge, which is the only file allowed to know
#     (delivery.md §8.4).
#
# Exit codes: 0 fine, 2 you called this wrongly, 1 it did not work.
#
set -euo pipefail

: "${YAN_HOME:?yan-mr: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"
# shellcheck source=bin/lib-forge.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-forge.sh"

die() {
	printf 'yan mr: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan mr --task <id> --unit <name> [--title <text>]
              [--body <text> | --body-file <path>] [--draft] [--json]

Opens the outbound merge request for one unit: its integration branch into its
target. The URL is recorded in unit.mr.

  --title      defaults to the task's title (with the unit name when the task
               has more than one unit)
  --body-file  defaults to the task's brief.md when it exists
  --draft      open it as a draft

`yan` may do this on its own: opening an MR is reversible (boundaries.md §9.2).
Merging it into target is `yan land`, and `user` has to ask for that.
EOF
}

task=
unit=
title=
body=
body_file=
draft=0
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
	--title)
		need_value "$1" "$#"
		shift
		title=$1
		;;
	--body)
		need_value "$1" "$#"
		shift
		body=$1
		;;
	--body-file)
		need_value "$1" "$#"
		shift
		body_file=$1
		;;
	--draft)
		draft=1
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
if [ -n "$body" ] && [ -n "$body_file" ]; then
	die "--body and --body-file are alternatives - pass one" 2
fi

task_exists "$task" || die "no such task: $task - 'yan ls' lists them" 2
task_unit_json "$task" "$unit" >/dev/null 2>&1 || die "no such unit: $unit in $task - 'yan ls $task' lists them" 2

repo=$(task_unit_get "$task" "$unit" repo)
branch=$(task_unit_get "$task" "$unit" branch)
target=$(task_unit_get "$task" "$unit" target)
mode=$(task_unit_get "$task" "$unit" mode)
existing=$(task_unit_get "$task" "$unit" mr)

# --- the four refusals ------------------------------------------------------

case $mode in
mr) ;;
scout)
	die "unit $unit is a scout: it delivers a report and artifacts, and never pushes or opens an MR (delivery.md §8.2). If that is wrong, 'user' has to ask for 'yan unit set --mode mr'" 2
	;;
branch)
	die "unit $unit is mode 'branch': its deliverable is a clean local branch and it does not open an MR (delivery.md §8.2). If that is wrong, 'user' has to ask for 'yan unit set --mode mr'" 2
	;;
*)
	die "unit $unit has an unusable mode '$mode'" 2
	;;
esac

if [ -n "$existing" ]; then
	die "unit $unit already has an outbound merge request: $existing. One round has one outbound MR (branching.md §6.4) - to start a new round, 'user' has to ask for 'yan unit set --branch <new>'" 2
fi

[ -n "$branch" ] || die "unit $unit has no integration branch recorded - 'yan unit add' should have set one"
[ -n "$target" ] || die "unit $unit has no target recorded, and yan never guesses one (branching.md §6.4)"
if [ "$branch" = "$target" ]; then
	die "unit $unit's integration branch and target are both '$branch' - there is nothing to merge into anything" 2
fi

clone=$YAN_HOME/repos/$repo
[ -d "$clone" ] || die "no clone of $repo under $YAN_HOME/repos - register it with 'yan repo-add'" 2
clone=$(cd -P "$clone" >/dev/null 2>&1 && pwd)

# The branch has to be on the remote before a merge request can point at it.
# Pushing it is `yan sync`'s step and stays there (branching.md §6.3), so this
# only checks and reports.
if ! git_remote_branch_exists "$clone" "$branch"; then
	die "$branch is not on the remote yet, so there is nothing to open a merge request from - run 'yan sync --task $task --unit $unit' first"
fi

# --- title and body ---------------------------------------------------------

if [ -z "$title" ]; then
	title=$(task_title "$task")
	[ -n "$title" ] || title="$task $unit"
	n_units=$(task_units_json "$task" | jq 'length')
	if [ "${n_units:-1}" -gt 1 ]; then
		title="$title ($unit)"
	fi
fi

if [ -z "$body" ] && [ -z "$body_file" ]; then
	brief=$(task_dir "$task")/brief.md
	if [ -f "$brief" ]; then
		body_file=$brief
	fi
fi

# --- open it ----------------------------------------------------------------

forge_args=(--dir "$clone" --source "$branch" --target "$target" --title "$title")
[ -n "$body" ] && forge_args+=(--body "$body")
[ -n "$body_file" ] && forge_args+=(--body-file "$body_file")
[ "$draft" -eq 1 ] && forge_args+=(--draft)

url=$(forge_mr_create "${forge_args[@]}") || die "the forge did not open a merge request (see the message above) - nothing was recorded"
url=${url//$'\r'/}
[ -n "$url" ] || die "the forge reported success but printed no merge request URL - nothing was recorded"

# `mr` is one of the unit's four current scalars (branching.md §6.4), and it is
# written only after the forge has confirmed the URL: a recorded MR that does
# not exist would later be read as "this round was delivered".
task_unit_set "$task" "$unit" mr "$url" ||
	die "the merge request is open at $url but task.json was not updated - record it with 'yan unit set' or re-run after fixing the error above"

log_append "$task" "$unit  outbound MR opened: $branch → $target  $url" ||
	printf 'yan mr: the MR was recorded in task.json but log.md was not appended to\n' >&2

draft_json=false
[ "$draft" -eq 1 ] && draft_json=true

if [ "$as_json" -eq 1 ]; then
	jq -nc --arg task "$task" --arg unit "$unit" --arg branch "$branch" \
		--arg target "$target" --arg mr "$url" --argjson draft "$draft_json" \
		'{version: 1, task: $task, unit: $unit, branch: $branch, target: $target,
		  mr: $mr, draft: $draft}' | tr -d '\r'
else
	printf '%s %s  %s → %s\n' "$task" "$unit" "$branch" "$target"
	printf 'mr       %s\n' "$url"
	printf '\n'
	printf 'Merging it into %s is `yan land`, and `user` has to ask for that.\n' "$target"
fi
