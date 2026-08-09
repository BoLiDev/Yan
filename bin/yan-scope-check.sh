#!/usr/bin/env bash
#
# yan scope-check <sid> - which changed paths are outside the unit's scope.
#
# ---------------------------------------------------------------------------
# IT REPORTS. IT NEVER BLOCKS.
# ---------------------------------------------------------------------------
#
# td delivery.md §8.3 is explicit, and the reason is worth keeping in front of
# whoever edits this next:
#
#   > While changing `apps/auth` you discover you have to touch a type in
#   > `apps/common`. This happens constantly in real work. Refusing outright
#   > would leave the agent stuck, or quietly working around the check.
#
# The rule is "going outside `scope` requires expanding it explicitly", not
# "going outside `scope` is forbidden". So finding out-of-scope paths is a
# SUCCESSFUL run of this command: it exits 0 and says what to do about it -
# widen `scope` in task.json and add a line to log.md. A non-zero exit here
# means something really went wrong (no such shift, git could not be asked),
# never that the diff was inconvenient. Anything that turned this into a gate
# would be turning it into the thing §8.3 rejected.
#
# It is one of exactly two commands a shift may run on itself (the other is
# `yan report`), which is why it reads and prints and writes nothing at all.
#
# What counts as changed: everything the shift has done to the tree it leased -
# commits since the integration branch, staged and unstaged edits, and files it
# has created but not yet added. An untracked file in the wrong package is
# exactly the kind of stray edit this is meant to surface, and `git diff` alone
# would never see it.
#
set -euo pipefail

: "${YAN_HOME:?yan-scope-check: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"

die() {
	printf 'scope-check: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan scope-check <sid> [--task <id>] [--json]

Reports paths the shift has changed that lie outside its unit's `scope`.
It never fails because of what it found: going outside scope means widening
scope explicitly, not being refused.
EOF
}

sid=
opt_task=
as_json=0

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--json)
		as_json=1
		shift
		;;
	--task)
		if [ $# -lt 2 ]; then
			usage >&2
			die "--task needs a value" 2
		fi
		opt_task=$2
		shift 2
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
		shift
		;;
	esac
done

if [ -z "$sid" ]; then
	usage >&2
	die "a shift id is required" 2
fi

shift_resolve "$sid" "$opt_task" || exit $?

unit=$(shift_meta_unit || true)
tree=$(shift_meta_tree || true)

if [ -z "$tree" ]; then
	die "run/meta.json for $sid records no tree - there is no working tree to diff" 1
fi
if [ ! -d "$tree" ]; then
	die "the tree recorded for $sid is not there: $tree" 1
fi

# --- the scope --------------------------------------------------------------
#
# `scope` belongs to the unit in task.json, so a shift whose meta names no unit
# (or a task that has no such unit) has nothing to check against. That is
# reported plainly rather than being treated as "everything is out of scope".

scope=()
scope_known=0
if [ -n "$SHIFT_TASK" ] && [ -n "$unit" ] && task_exists "$SHIFT_TASK"; then
	if scope_lines=$(task_unit_scope "$SHIFT_TASK" "$unit" 2>/dev/null); then
		scope_known=1
		while IFS= read -r p; do
			[ -n "$p" ] || continue
			scope+=("${p%/}")
		done <<<"$scope_lines"
	fi
fi

# --- what changed -----------------------------------------------------------

base=
if [ "$scope_known" -eq 1 ]; then
	base=$(task_unit_get "$SHIFT_TASK" "$unit" branch 2>/dev/null || true)
fi

base_ref=
base_why=
if [ -n "$base" ]; then
	if git_branch_exists "$tree" "$base" 2>/dev/null; then
		base_ref=$base
	elif git_rev_parse "$tree" --verify --quiet "origin/$base^{commit}" >/dev/null 2>&1; then
		base_ref=origin/$base
	else
		base_why="the integration branch '$base' is not in this tree, so only the working tree was compared"
	fi
else
	base_why='no integration branch recorded, so only the working tree was compared'
fi

changed=$(
	{
		if [ -n "$base_ref" ]; then
			# Three dots: what this branch changed since it left the integration
			# branch, not everything that has happened on the other side of it.
			git_diff_name_only "$tree" "$base_ref...HEAD" || true
		fi
		# Staged and unstaged edits that are not committed yet.
		git_diff_name_only "$tree" HEAD || true
		# Files created and not yet added - `git diff` cannot see them.
		git_status_porcelain "$tree" --untracked-files=all |
			awk '$1 == "??" { sub(/^\?\? /, ""); print }' || true
	} | tr -d '\r' | LC_ALL=C sort -u | grep -v '^$' || true
)

# --- prefix matching --------------------------------------------------------

in_scope() { # <path>
	local path=$1 s
	for s in ${scope[@]+"${scope[@]}"}; do
		case $s in
		'' | '.') return 0 ;;
		esac
		if [ "$path" = "$s" ]; then
			return 0
		fi
		case $path in
		"$s"/*) return 0 ;;
		esac
	done
	return 1
}

inside=()
outside=()
while IFS= read -r path; do
	[ -n "$path" ] || continue
	if [ "$scope_known" -eq 0 ] || [ "${#scope[@]}" -eq 0 ] || in_scope "$path"; then
		inside+=("$path")
	else
		outside+=("$path")
	fi
done <<<"$changed"

n_in=${#inside[@]}
n_out=${#outside[@]}

# --- report -----------------------------------------------------------------

if [ "$as_json" -eq 1 ]; then
	scope_json=$(printf '%s\n' ${scope[@]+"${scope[@]}"} | jq -Rnc '[inputs | select(length > 0)]')
	in_json=$(printf '%s\n' ${inside[@]+"${inside[@]}"} | jq -Rnc '[inputs | select(length > 0)]')
	out_json=$(printf '%s\n' ${outside[@]+"${outside[@]}"} | jq -Rnc '[inputs | select(length > 0)]')
	jq -nc \
		--arg sid "$SHIFT_SID" --arg task "$SHIFT_TASK" --arg unit "$unit" \
		--arg tree "$tree" --arg base "${base_ref:-$base}" \
		--argjson scope_known "$scope_known" \
		--argjson scope "$scope_json" \
		--argjson in_scope "$in_json" \
		--argjson out_of_scope "$out_json" '{
			version: 1, sid: $sid, task: $task, unit: $unit, tree: $tree,
			base: $base, scope_known: ($scope_known == 1), scope: $scope,
			in_scope: $in_scope, out_of_scope: $out_of_scope,
			blocked: false
		}'
	exit 0
fi

printf '%s  task %s  unit %s\n' "$SHIFT_SID" "${SHIFT_TASK:--}" "${unit:--}"
printf 'tree     %s\n' "$tree"
if [ "$scope_known" -eq 0 ]; then
	printf 'scope    (unknown: no unit recorded for this shift, or no such unit in task.json)\n'
elif [ "${#scope[@]}" -eq 0 ]; then
	printf 'scope    (empty: unit %s restricts nothing, so nothing can be outside it)\n' "$unit"
else
	printf 'scope    %s\n' "${scope[*]}"
fi
if [ -n "$base_why" ]; then
	printf 'base     %s\n' "$base_why"
else
	printf 'base     %s\n' "$base_ref"
fi
printf 'changed  %s file(s): %s in scope, %s outside\n' "$((n_in + n_out))" "$n_in" "$n_out"

if [ "$n_out" -gt 0 ]; then
	printf '\nout of scope\n'
	for path in "${outside[@]}"; do
		printf '  %s\n' "$path"
	done
	printf '\nThis is a report, not a refusal. If the work belongs here, widen the\n'
	printf 'unit'"'"'s scope in task.json and add a line to log.md (td delivery.md §8.3).\n'
fi

# Always 0 when the check ran. Reporting is the whole job.
exit 0
