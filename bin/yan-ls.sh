#!/usr/bin/env bash
#
# yan ls [<id>] [--json] - the queue, and the deeper view of one task.
#
# THIS COMMAND STORES NOTHING. There is no backlog file and there must never
# be one (td INDEX.md §3): the queue is a view produced by scanning
# tasks/*/task.json every single time it is asked for. That is design
# principle 1 - do not store state you can derive - and it removes the most
# bug-prone thing in the system, a second list that can disagree with the
# directory.
#
#   no argument   render the queue, one line per task, including a `scope`
#                 column. Showing scope is useful information and `user`
#                 decides whether to care; yan does NOT scan for overlapping
#                 scopes and warn about them, because overlap is common and
#                 the warning would be noise (td agents.md §5.2).
#   <id>          that task's units (integration branch, target, mode, scope)
#                 and every live shift with its shift branch name and worktree
#                 absolute path, read from shifts/*/run/meta.json.
#   --json        the same two shapes, machine readable.
#
set -euo pipefail

: "${YAN_HOME:?yan-ls: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"

die() {
	printf 'ls: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan ls [<task-id>] [--json]

  (no id)   the queue: every task in tasks/, derived by scanning
  <id>      one task: its units, and every live shift's branch and worktree
  --json    machine readable output for either form
EOF
}

as_json=0
id=

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
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		if [ -n "$id" ]; then
			usage >&2
			die "only one task id may be given" 2
		fi
		id=$1
		shift
		;;
	esac
done

# --- live shifts ------------------------------------------------------------
#
# "Live" means run/ still exists: run/ is the only throwaway layer and a shift
# clocking out deletes it whole (td INDEX.md §3), so its presence IS the fact.
#
# Phase 7 seam: once lib-pool exists, `yan ls <id>` should cross-check each
# tree path against the pool's lease records, so a stale meta.json can be told
# from a tree that is genuinely held. There is no pool in Phase 1 and no
# terminal either, so this reads what run/meta.json says and presents it. It
# deliberately does not fake a pool query - a stand-in that always answers
# "leased" would be worse than no answer at all.
#
# The meta.json keys read here are the contract Phase 7's spawn script has to
# write: .unit, .branch (the shift branch name) and .tree (the worktree
# absolute path), plus .agent for the CLI that was started.
shifts_json() { # <task-id>
	local dir=$1 meta sid
	dir=$(task_dir "$dir") || return $?
	(
		shopt -s nullglob
		for meta in "$dir"/shifts/*/run/meta.json; do
			sid=${meta%/run/meta.json}
			sid=${sid##*/}
			jq -c --arg sid "$sid" '{
					sid:    $sid,
					unit:   (.unit   // ""),
					branch: (.branch // ""),
					tree:   (.tree   // ""),
					agent:  (.agent  // "")
				}' "$meta" 2>/dev/null || true
		done
	) | jq -sc .
}

queue_json() {
	local t
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		jq -c --argjson s "$(shifts_json "$t")" '{
				id:       (.id // ""),
				title:    (.title // ""),
				complete: (.complete == true),
				units:    [.units[]?.name],
				scope:    ([.units[]?.scope[]?] | unique),
				shifts:   ($s | length)
			}' "$(task_file "$t")"
	done < <(task_list) | jq -sc '{version: 1, tasks: .}'
}

task_detail_json() { # <task-id>
	jq -c --argjson s "$(shifts_json "$1")" '{
			version:  1,
			id:       (.id // ""),
			title:    (.title // ""),
			complete: (.complete == true),
			units:    (.units // []),
			shifts:   $s
		}' "$(task_file "$1")"
}

# --- rendering --------------------------------------------------------------

# table [indent] - read TSV on stdin, first line is the header, print aligned.
table() {
	local pad=${1:-} lines=() widths=() line fields=() i out cell
	while IFS= read -r line; do
		# jq.exe on Git Bash terminates every line with CRLF; a stray \r in
		# the last column would be printed straight at the terminal.
		line=${line%$'\r'}
		[ -n "$line" ] || continue
		lines+=("$line")
	done
	[ "${#lines[@]}" -gt 0 ] || return 0

	for line in "${lines[@]}"; do
		IFS=$'\t' read -r -a fields <<<"$line"
		i=0
		while [ "$i" -lt "${#fields[@]}" ]; do
			if [ "${#fields[i]}" -gt "${widths[i]:-0}" ]; then
				widths[i]=${#fields[i]}
			fi
			i=$((i + 1))
		done
	done

	for line in "${lines[@]}"; do
		IFS=$'\t' read -r -a fields <<<"$line"
		out=$pad
		i=0
		while [ "$i" -lt "${#fields[@]}" ]; do
			if [ "$i" -eq $((${#fields[@]} - 1)) ]; then
				out+=${fields[i]}
			else
				# printf -v, not $(...): command substitution would strip the
				# trailing spaces that are the whole point of a column.
				printf -v cell '%-*s  ' "${widths[i]}" "${fields[i]}"
				out+=$cell
			fi
			i=$((i + 1))
		done
		printf '%s\n' "$out"
	done
}

dash() { # jq helper text: empty becomes a dash so columns stay visible
	printf '%s' 'def d: if . == null or . == "" then "-" else . end;'
}

render_queue() {
	local json=$1 n
	n=$(printf '%s' "$json" | jq '.tasks | length')
	if [ "$n" -eq 0 ]; then
		printf 'no tasks in %s/tasks\n' "$YAN_HOME"
		return 0
	fi
	{
		printf 'ID\tSTATE\tUNITS\tSHIFTS\tSCOPE\tTITLE\n'
		printf '%s' "$json" | jq -r "$(dash)"'
			.tasks[] | [
				.id,
				(if .complete then "done" else "open" end),
				(.units | length | tostring),
				(.shifts | tostring),
				(.scope | join(" ") | d),
				(.title | d)
			] | @tsv'
	} | table
}

render_task() {
	local json=$1 n
	printf '%s\n' "$(printf '%s' "$json" | jq -r '"\(.id)  \(.title)"')"
	printf 'state    %s\n' "$(printf '%s' "$json" | jq -r 'if .complete then "done" else "open" end')"
	printf 'dir      %s\n' "$(task_dir "$id")"

	printf '\nunits\n'
	n=$(printf '%s' "$json" | jq '.units | length')
	if [ "$n" -eq 0 ]; then
		printf '  (none)\n'
	else
		{
			printf 'NAME\tREPO\tBRANCH\tTARGET\tMODE\tMR\tSCOPE\tNEEDS\n'
			printf '%s' "$json" | jq -r "$(dash)"'
				.units[] | [
					(.name | d), (.repo | d), (.branch | d), (.target | d),
					(.mode | d), (.mr | d),
					((.scope // []) | join(" ") | d),
					((.needs // []) | join(" ") | d)
				] | @tsv'
		} | table '  '
	fi

	printf '\nshifts (live)\n'
	n=$(printf '%s' "$json" | jq '.shifts | length')
	if [ "$n" -eq 0 ]; then
		printf '  (none)\n'
	else
		{
			printf 'SID\tUNIT\tBRANCH\tTREE\n'
			printf '%s' "$json" | jq -r "$(dash)"'
				.shifts[] | [(.sid | d), (.unit | d), (.branch | d), (.tree | d)] | @tsv'
		} | table '  '
	fi
}

# --- go ---------------------------------------------------------------------

if [ -z "$id" ]; then
	out=$(queue_json)
	if [ "$as_json" -eq 1 ]; then
		printf '%s\n' "$out"
	else
		render_queue "$out"
	fi
	exit 0
fi

task_exists "$id" || die "no such task: $id - $(task_dir "$id" 2>/dev/null || printf '%s' "$id")/task.json does not exist"

out=$(task_detail_json "$id")
if [ "$as_json" -eq 1 ]; then
	printf '%s\n' "$out"
else
	render_task "$out"
fi
