#!/usr/bin/env bash
#
# yan land - merge the outbound merge requests into `target`, in `needs` order
# (td boundaries.md §9.2, branching.md §6.4, architecture.md §5.2).
#
# ---------------------------------------------------------------------------
# `user` HAS TO ASK FOR THIS
# ---------------------------------------------------------------------------
#
# It is the one line of boundaries.md §9.2 that this file exists to hold:
#
#   merge the outbound MR into `target`   `user` has to ask for it
#
# and the summary underneath it: *inside your own branches and your own
# machine, act on your own. Anything that affects `target`, or that a colleague
# will see, requires `user` to say so.*
#
# Everything up to here - dispatching shifts, merging shift MRs into the
# integration branch, opening the outbound MR with `yan mr` - `yan` does on its
# own, because all of it happens on branches `user` owns and all of it is
# reversible. This one is not: after it, `target` contains the work and
# colleagues are looking at it.
#
# So the authority is stated twice. In AGENTS.md, where the model is told not
# to reach for this on its own initiative; and here, as `--user-asked`, which
# is not a confirmation prompt and not a forcing switch. It is the flag that
# carries `user`'s answer in, exactly as `yan unit set --end` carries it
# into an append-only history. Without it nothing is merged, on a terminal or
# not: this is not a value the soft path could ask for on `user`'s behalf,
# because `user` is the only source of it.
#
# ---------------------------------------------------------------------------
# ORDER
# ---------------------------------------------------------------------------
#
# `needs` records the landing order (branching.md §6.4), so the units are
# topologically sorted before anything is merged and the run stops at the first
# unit that will not land. Stopping matters more than finishing: a unit that
# lands before the one it needs is exactly the breakage `needs` exists to
# prevent, and carrying on past a failure would do it deliberately.
#
# A cycle is refused outright. It is not a merge order that yan may pick a way
# out of; it is a mistake in `needs` that only `user` can resolve.
#
# Nothing is ever forced, nothing is commented on, and nobody is mentioned.
#
# Exit codes: 0 fine, 2 you called this wrongly (including "user has not asked"),
# 1 something did not land.
#
set -euo pipefail

: "${YAN_HOME:?yan-land: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-forge.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-forge.sh"

die() {
	printf 'yan land: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan land --task <id> --user-asked [--unit <name>]...
                [--strategy merge|squash|rebase] [--json]

Merges each unit's outbound merge request into its target, topologically
sorted by `needs`. With no --unit, every unit that has an outbound MR.

  --user-asked  REQUIRED. Merging into target is the one action `user` has to
                ask for (boundaries.md §9.2). This flag is how their answer
                reaches the command; it is not a confirmation prompt and not a
                force switch.
  --unit        repeatable; land only these (their `needs` must already be
                merged, or be in the same run).
  --strategy    how the forge should merge. Default: merge.

It stops at the first unit that will not land, so nothing ever lands out of
order. A cycle in `needs` is refused: only `user` can resolve that.
EOF
}

task=
user_asked=0
strategy=merge
as_json=0
want=()

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
		want+=("$1")
		;;
	--strategy)
		need_value "$1" "$#"
		shift
		strategy=$1
		;;
	--user-asked)
		user_asked=1
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

case $strategy in
merge | squash | rebase) ;;
*) die "--strategy is merge, squash or rebase, not '$strategy'" 2 ;;
esac

# The authority check, before anything is read and long before anything is
# merged. It is deliberately not softened on a TTY: `user` saying so is the
# input, and a program cannot supply it on their behalf.
if [ "$user_asked" -eq 0 ]; then
	die "merging into target is the one thing 'user' has to ask for (boundaries.md §9.2). Nothing was merged. When they have asked, re-run with --user-asked" 2
fi

task_exists "$task" || die "no such task: $task - 'yan ls' lists them" 2

for u in ${want[@]+"${want[@]}"}; do
	task_unit_json "$task" "$u" >/dev/null 2>&1 || die "no such unit: $u in $task" 2
done

# --- topological sort by `needs` --------------------------------------------
#
# Kahn's algorithm over the task's whole unit list, so that a unit's needs are
# resolved even when they were not asked for by name. Ties keep declaration
# order, which makes the printed plan stable and reviewable.

all=()
while IFS= read -r u; do
	[ -n "$u" ] || continue
	all+=("$u")
done < <(task_unit_names "$task")
[ "${#all[@]}" -gt 0 ] || die "task $task has no units" 2

in_list() { # in_list <needle> <haystack...>
	local needle=$1 x
	shift
	for x in "$@"; do
		[ "$x" = "$needle" ] && return 0
	done
	return 1
}

# needs_of <unit> - declared needs that are units of this task. A `needs` entry
# naming something that is not a unit here is reported and then ignored: it
# cannot be ordered against, and refusing the whole run for a typo in an
# unrelated unit would be worse than saying so.
needs_of() {
	local n
	while IFS= read -r n; do
		[ -n "$n" ] || continue
		if in_list "$n" "${all[@]}"; then
			printf '%s\n' "$n"
		else
			printf 'yan land: unit %s needs "%s", which is not a unit of %s - ignoring it for ordering\n' "$1" "$n" "$task" >&2
		fi
	done < <(task_unit_needs "$task" "$1")
}

order=()
remaining=("${all[@]}")
progress=1
while [ "${#remaining[@]}" -gt 0 ] && [ "$progress" -eq 1 ]; do
	progress=0
	next=()
	for u in "${remaining[@]}"; do
		ready=1
		while IFS= read -r n; do
			[ -n "$n" ] || continue
			if ! in_list "$n" ${order[@]+"${order[@]}"}; then
				ready=0
			fi
		done < <(needs_of "$u")
		if [ "$ready" -eq 1 ]; then
			order+=("$u")
			progress=1
		else
			next+=("$u")
		fi
	done
	if [ "${#next[@]}" -gt 0 ]; then
		remaining=("${next[@]}")
	else
		remaining=()
	fi
done

if [ "${#remaining[@]}" -gt 0 ]; then
	die "the 'needs' of ${remaining[*]} form a cycle, so there is no order to land them in. Nothing was merged - 'user' has to break the cycle with 'yan unit set'" 2
fi

# --- what is actually being landed ------------------------------------------

plan=()
for u in "${order[@]}"; do
	if [ "${#want[@]}" -gt 0 ] && ! in_list "$u" "${want[@]}"; then
		continue
	fi
	mr=$(task_unit_get "$task" "$u" mr)
	if [ -z "$mr" ]; then
		if [ "${#want[@]}" -gt 0 ]; then
			die "unit $u has no outbound merge request - open it with 'yan mr --task $task --unit $u' first. Nothing was merged" 2
		fi
		continue
	fi
	plan+=("$u")
done

[ "${#plan[@]}" -gt 0 ] ||
	die "nothing to land: no unit of $task has an outbound merge request yet - 'yan mr' opens one" 2

# --- merge, in order, stopping at the first refusal --------------------------

results='[]'
record() { # record <unit> <mr> <what happened>
	results=$(printf '%s' "$results" | jq -c --arg u "$1" --arg mr "$2" --arg r "$3" \
		'. + [{unit: $u, mr: $mr, result: $r}]' | tr -d '\r')
}

say() { # say <format> <args...> - the human line, silent under --json
	[ "$as_json" -eq 0 ] || return 0
	# shellcheck disable=SC2059 # the format string is ours, never user data
	printf "$@"
}

for u in "${plan[@]}"; do
	mr=$(task_unit_get "$task" "$u" mr)
	repo=$(task_unit_get "$task" "$u" repo)
	target=$(task_unit_get "$task" "$u" target)

	forge_args=(--mr "$mr")
	clone=$YAN_HOME/repos/$repo
	if [ -d "$clone" ]; then
		clone=$(cd -P "$clone" >/dev/null 2>&1 && pwd)
		forge_args+=(--dir "$clone")
	fi

	# Ask before merging. Whether it merged is the forge's answer and never
	# git ancestry (branching.md §6.4), and the four words it may answer with
	# are exactly the four cases below.
	state=$(forge_mr_state "${forge_args[@]}") || state=unknown
	case $state in
	merged)
		record "$u" "$mr" "already merged"
		say '%-16s %s  already merged\n' "$u" "$mr"
		continue
		;;
	open) ;;
	closed)
		die "unit $u's merge request $mr is closed, not merged, so it cannot land. Stopping here so that nothing lands out of 'needs' order - 'user' has to decide whether this round is abandoned ('yan unit set --branch')"
		;;
	*)
		die "cannot tell what state unit $u's merge request $mr is in - the forge could not be reached, or it no longer exists. Stopping here so that nothing lands out of 'needs' order"
		;;
	esac

	# --delete-source is deliberately not passed: deleting the integration
	# branch is not this command's business, and boundaries.md §9.2 forbids
	# deleting a branch that is not merged - a decision this command must not
	# make for the forge.
	if ! forge_mr_merge "${forge_args[@]}" --strategy "$strategy"; then
		record "$u" "$mr" "refused"
		die "unit $u's merge request $mr did not merge (see the message above). Stopping here so that nothing lands out of 'needs' order"
	fi

	record "$u" "$mr" "merged"
	log_append "$task" "$u  landed: $mr merged into $target ('user' asked)" ||
		printf 'yan land: %s landed but log.md was not appended to\n' "$u" >&2
	say '%-16s %s  merged into %s\n' "$u" "$mr" "$target"
done

if [ "$as_json" -eq 1 ]; then
	printf '%s' "$results" | jq -c --arg task "$task" --arg strategy "$strategy" \
		'{version: 1, task: $task, strategy: $strategy, landed: .}' | tr -d '\r'
fi
