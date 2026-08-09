#!/usr/bin/env bash
#
# yan shift done - clock a shift out (td agents.md §5.3, worktree.md §7).
#
# ---------------------------------------------------------------------------
# THE ORDER IS THE WHOLE COMMAND
# ---------------------------------------------------------------------------
#
#   verify the MR is merged
#     -> write outcome.md
#       -> write the log line
#         -> rm -rf run/
#           -> RETURN THE TREE
#             -> THEN delete the remote shift branch
#
# Two of those arrows are load-bearing, and neither fails loudly when it is got
# wrong. architecture.md §7 lists them among the four ordering regressions.
#
# 1. "MERGED" IS ANSWERED BY THE MR'S STATE, NEVER BY GIT ANCESTRY.
#    If the internal merge request was SQUASH-merged, the integration branch
#    does not contain the shift branch's HEAD at all, so `merge-base --is-
#    ancestor` would say "not merged" about work that landed an hour ago
#    (td §5.3). The forge is the source of truth; this command asks it and does
#    not look at the shape of the history.
#
# 2. THE TREE GOES BACK BEFORE THE REMOTE BRANCH IS DELETED.
#    The pool's orphan-commit guard refuses to return a tree when
#    `git branch -r --contains HEAD` is empty, because that is exactly the
#    moment the commits exist nowhere else. Deleting the remote shift branch
#    also removes its remote-tracking ref - which worktrees share with the main
#    clone - so after a squash merge, deleting first makes that list empty and
#    the guard refuses. The slot is then stranded with no way to recover it,
#    since there is deliberately no forcing flag anywhere in the MVP
#    (boundaries.md §9.2). Return first and the copy test always passes; delete
#    last and the work is in the integration branch by then. This way yan never
#    has to care whether the team configured internal MRs to merge or to squash
#    - and in a work repository that setting may not be ours to decide.
#
# Everything the teardown needs is read out of run/meta.json BEFORE run/ is
# deleted, because deleting it is step four and the tree path, the lease id and
# the branch name all live in there.
#
# rm -rf run/ is the whole cleanup for the throwaway layer: one directory, not
# a list of files (td INDEX.md §3). A list would eventually miss one.
#
# Exit codes: 0 fine, 2 you called this wrongly, 4 the merge request has not
# merged, so there is nothing to clock out yet, 1 anything else.
#
set -euo pipefail

: "${YAN_HOME:?yan-shift-done: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"
# shellcheck source=bin/lib-forge.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-forge.sh"
# shellcheck source=bin/lib-pool.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-pool.sh"
# shellcheck source=bin/lib-term.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-term.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"

RC_NOT_MERGED=4

die() {
	printf 'yan shift done: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan shift done <sid> [--task <id>] [--mr <url>]
                      [--outcome <file>] [--keep-pane] [--json]

Clocks a shift out, in the one order that survives a squash merge:

  the merge request is merged -> outcome.md -> the log line
    -> rm -rf run/ -> return the tree -> delete the remote shift branch

  <sid>        the shift; the task comes from $YAN_TASK when it is set
  --mr         the shift branch's merge request, when run/meta.json has none
  --outcome    a file whose contents become outcome.md if the shift wrote none
  --keep-pane  leave the agent's terminal window open
  --json       print the teardown record instead of a summary

Whether it merged is asked of the forge, never inferred from git ancestry: a
squash-merged branch is not an ancestor of the branch it landed on.

Exit code 4 means the merge request has not merged, so there is nothing to
clock out yet.
EOF
}

# --- arguments --------------------------------------------------------------

sid=
opt_task=${YAN_TASK:-}
mr=
outcome_file=
keep_pane=0
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
		opt_task=$1
		;;
	--mr)
		need_value "$1" "$#"
		shift
		mr=$1
		;;
	--outcome)
		need_value "$1" "$#"
		shift
		outcome_file=$1
		;;
	--keep-pane)
		keep_pane=1
		;;
	--json)
		as_json=1
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		if [ -n "$sid" ]; then
			usage >&2
			die "only one shift id may be given" 2
		fi
		sid=$1
		;;
	esac
	shift
done

[ -n "$sid" ] || {
	usage >&2
	die "a shift id is required" 2
}
if [ -n "$outcome_file" ] && [ ! -f "$outcome_file" ]; then
	die "no such outcome file: $outcome_file" 2
fi

shift_resolve "$sid" "$opt_task" || exit $?

# --- everything the teardown needs, read before run/ is deleted -------------

unit=$(shift_meta_unit || true)
branch=$(shift_meta_branch || true)
tree=$(shift_meta_tree || true)
clone=$(shift_meta_get clone || true)
holder=$(shift_meta_get holder || true)
lease_id=$(shift_meta_get lease_id || true)
agent_id=$(shift_meta_agent_id || true)
if [ -z "$mr" ]; then
	mr=$(shift_meta_mr || true)
fi

if ! shift_is_live; then
	die "shift $(shift_label) has already clocked out - run/ is gone, which is the fact that says so" 2
fi
[ -n "$branch" ] || die "run/meta.json does not say which shift branch $(shift_label) is on - it cannot be cleaned up automatically"

# The main clone. meta.json records it at spawn time; task.json is the fallback
# for a shift dispatched before that key existed.
if [ -z "$clone" ] && [ -n "$SHIFT_TASK" ] && [ -n "$unit" ]; then
	repo=$(task_unit_get "$SHIFT_TASK" "$unit" repo 2>/dev/null) || repo=
	if [ -n "$repo" ] && [ -d "$YAN_HOME/repos/$repo" ]; then
		clone=$(cd -P "$YAN_HOME/repos/$repo" >/dev/null 2>&1 && pwd)
	fi
fi

# --- 1. is it merged? -------------------------------------------------------
#
# The forge answers, and it answers with one of yan's four words. Ancestry is
# never consulted: see the header.

[ -n "$mr" ] || die "no merge request recorded for $(shift_label) - pass --mr <url>. Whether the work landed is the forge's answer, and yan will not guess it from git history" 2

forge_args=(--mr "$mr")
if [ -n "$tree" ] && [ -d "$tree" ]; then
	forge_args+=(--dir "$tree")
elif [ -n "$clone" ] && [ -d "$clone" ]; then
	forge_args+=(--dir "$clone")
fi

state=$(forge_mr_state "${forge_args[@]}") || die "cannot ask the forge about $mr (see the message above)"
case $state in
merged) ;;
*)
	die "$mr is '$state', not merged - a shift clocks out when its merge request has been merged into the integration branch, and nothing sooner (td §5.3)" "$RC_NOT_MERGED"
	;;
esac

# --- 2. outcome.md ----------------------------------------------------------
#
# The shift writes this itself before wrapping up. yan is the fallback for a
# shift that died without doing so, and Appendix A says it marks the file as
# written after the fact rather than pretending the shift wrote it.

outcome=$SHIFT_DIR/outcome.md
if [ -f "$outcome" ]; then
	outcome_by='shift'
elif [ -n "$outcome_file" ]; then
	outcome_by=yan
	cp -- "$outcome_file" "$outcome" || die "cannot write $outcome"
else
	outcome_by=yan
	{
		printf '# %s %s\n\n' "$SHIFT_SID" "${unit:-}"
		printf -- '- shift branch: %s\n' "$branch"
		printf -- '- merge request: %s (merged)\n' "$mr"
		printf -- '- events reported: %s\n' "$(shift_event_count)"
		printf '\n'
		printf 'Written by yan when the shift clocked out: the shift did not leave an\n'
		printf 'outcome of its own, so this records only what could be observed.\n'
	} >"$outcome" || die "cannot write $outcome"
fi

# --- 3. the log line --------------------------------------------------------

if [ -n "$SHIFT_TASK" ]; then
	log_append "$SHIFT_TASK" "$SHIFT_SID ${unit:-}  $mr merged into the integration branch" || true
fi

# --- 4. rm -rf run/ ---------------------------------------------------------
#
# One directory. Lifetime is expressed by the directory, not by a list of files
# (td INDEX.md §3), which is why nothing here enumerates meta.json / status /
# signal - a list would eventually miss one.

rm -rf -- "$SHIFT_RUN" || die "cannot delete $SHIFT_RUN"

# --- 5. return the tree, BEFORE the branch is deleted -----------------------

returned=
if [ -z "$tree" ]; then
	printf 'yan shift done: no worktree recorded for %s, so there is none to return\n' "$(shift_label)" >&2
elif [ -z "$clone" ]; then
	printf 'yan shift done: the main clone of %s is not recorded, so the tree at %s must be returned by hand\n' "$(shift_label)" "$tree" >&2
else
	rc=0
	returned=$(pool_return "$clone" "$tree" "$lease_id" "$holder") || rc=$?
	if [ "$rc" -ne 0 ]; then
		# Deliberately fatal, and deliberately BEFORE the branch is deleted.
		# A refusal here means the commits may exist nowhere else, and deleting
		# the remote branch next would make that permanent.
		die "the tree at $tree could not be returned, so the remote branch $branch has NOT been deleted - investigate before anything else touches it" "$rc"
	fi
fi

# --- 6. and only now, the remote shift branch -------------------------------

deleted=false
if [ -n "$clone" ] && [ -d "$clone" ]; then
	if git_delete_remote_branch "$clone" origin "$branch" >/dev/null 2>&1; then
		deleted=true
	else
		printf 'yan shift done: the remote branch %s could not be deleted (it may already be gone) - the tree is back in the pool either way\n' "$branch" >&2
	fi
fi

# --- 7. the agent's window --------------------------------------------------
#
# Last, and never fatal: this closes exactly one recorded agent and can never
# touch the container, whose lifetime belongs to user (td §5.7).

if [ "$keep_pane" -eq 0 ] && [ -n "$agent_id" ]; then
	term_agent_close "$agent_id" >/dev/null 2>&1 || true
fi

# --- report -----------------------------------------------------------------

if [ "$as_json" -eq 1 ]; then
	jq -nc --arg sid "$SHIFT_SID" --arg task "$SHIFT_TASK" --arg unit "$unit" \
		--arg branch "$branch" --arg tree "${returned:-$tree}" --arg mr "$mr" \
		--arg outcome_by "$outcome_by" --argjson branch_deleted "$deleted" \
		'{version: 1, sid: $sid, task: $task, unit: $unit, branch: $branch,
		  mr: $mr, mr_state: "merged", tree: $tree, outcome_by: $outcome_by,
		  run_removed: true, tree_returned: ($tree != ""), branch_deleted: $branch_deleted}'
else
	printf '%s clocked out\n' "$SHIFT_SID"
	printf 'mr       %s (merged)\n' "$mr"
	printf 'outcome  %s (%s)\n' "$outcome" "$outcome_by"
	printf 'run      removed\n'
	printf 'tree     %s\n' "${returned:-not returned}"
	if [ "$deleted" = true ]; then
		printf 'branch   %s deleted on origin\n' "$branch"
	else
		printf 'branch   %s left on origin\n' "$branch"
	fi
fi
