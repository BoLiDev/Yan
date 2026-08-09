#!/usr/bin/env bash
#
# yan session-start - the full rebuild (td agents.md §5.1, architecture.md
# §5.2). Registered as the SessionStart hook for both harnesses.
#
# ---------------------------------------------------------------------------
# A RESTART IS A NON-EVENT, AND THIS COMMAND IS WHY
# ---------------------------------------------------------------------------
#
# yan holds no persistent running state. Every time it starts it rebuilds its
# picture from scratch:
#
#     scan tasks/  ->  ask the terminal  ->  ask the pool  ->  ask the forge
#
# Whatever those say is the answer. That is what makes "close it and open a new
# one" cost nothing: there is nothing to hand over and nothing to resume, and
# therefore nothing that can drift out of sync (td §5.1).
#
# SO THIS COMMAND WRITES NOTHING. Not a session file, not a cache of what it
# found, not a "last seen" timestamp. The moment it writes one, a restart stops
# being a non-event, because there is now a file that can disagree with the
# world. Its own test asserts that $YAN_HOME is byte-for-byte unchanged after
# it runs.
#
# IT ALSO NEVER CRASHES ON A SOURCE THAT WILL NOT ANSWER. There is no tmux
# server yet on a fresh boot; the pool root may be on a disk that is not
# mounted; the forge may be unreachable on a train. Each of those costs one
# fact and is reported as `unknown`, exactly as `yan state` and the seams
# themselves do (architecture.md §4.3): where we cannot tell, we say so, and we
# never round a guess up to a fact.
#
set -euo pipefail

: "${YAN_HOME:?yan-session-start: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"
# shellcheck source=bin/lib-term.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-term.sh"
# shellcheck source=bin/lib-pool.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-pool.sh"
# shellcheck source=bin/lib-forge.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-forge.sh"

die() {
	printf 'yan session-start: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan session-start [<task-id>] [--task <id>] [--all] [--json]

Rebuilds the picture of the world from what is actually there: the task
directories, the terminal, the worktree pool and the forge. It stores nothing,
which is what makes restarting yan a non-event.

  (no id)   the task in $YAN_TASK, or every task when that is unset
  --all     every task, even when $YAN_TASK is set
  --json    the same facts, machine readable

A source that cannot be reached is reported as `unknown` rather than being
treated as an error: a fresh machine has no tmux server yet, and a train has no
forge.
EOF
}

id=${YAN_TASK:-}
all=0
as_json=0

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--task)
		if [ $# -lt 2 ]; then
			usage >&2
			die "--task needs a value" 2
		fi
		id=$2
		shift
		;;
	--all)
		all=1
		id=
		;;
	--json)
		as_json=1
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		if [ "$all" -eq 1 ]; then
			usage >&2
			die "--all and a task id are alternatives" 2
		fi
		id=$1
		;;
	esac
	shift
done

if [ -n "$id" ] && [ "$all" -eq 0 ]; then
	task_exists "$id" || die "no such task: $id" 2
fi

# --- the four sources -------------------------------------------------------
#
# Each one answers with a word from a closed set, and `unknown` is always one
# of the options. None of them is allowed to end the command.

ask_terminal() { # ask_terminal <agent-id> -> alive | dead | unknown
	local agent_id=${1-} v rc=0
	if [ -z "$agent_id" ]; then
		printf 'unknown\n'
		return 0
	fi
	v=$(term_agent_alive "$agent_id" 2>/dev/null) || rc=$?
	if [ "$rc" -ne 0 ] || [ -z "$v" ]; then
		printf 'unknown\n'
		return 0
	fi
	printf '%s\n' "$v"
}

# The pool is asked once per clone and the answer is remembered for the length
# of this command only - it is a local variable, not a file.
_pool_cache_key=
_pool_cache_val=

pool_leases_of() { # pool_leases_of <clone> -> a JSON array, or `null`
	local clone=${1-} out rc=0
	if [ -z "$clone" ] || [ ! -d "$clone" ]; then
		printf 'null\n'
		return 0
	fi
	if [ "$clone" = "$_pool_cache_key" ]; then
		printf '%s\n' "$_pool_cache_val"
		return 0
	fi
	out=$(pool_status "$clone" 2>/dev/null) || rc=$?
	if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
		out=null
	fi
	_pool_cache_key=$clone
	_pool_cache_val=$out
	printf '%s\n' "$out"
}

ask_pool() { # ask_pool <clone> <tree> <lease-id> -> leased | free | unknown
	local leases
	leases=$(pool_leases_of "${1-}")
	if [ "$leases" = null ]; then
		printf 'unknown\n'
		return 0
	fi
	if printf '%s' "$leases" | jq -e --arg t "${2-}" --arg l "${3-}" \
		'any(.[]?; (($t != "" and .path == $t)) or ($l != "" and .lease_id == $l))' >/dev/null 2>&1; then
		printf 'leased\n'
	else
		printf 'free\n'
	fi
}

ask_forge() { # ask_forge <mr> <dir> -> merged | closed | open | unknown | none
	local mr=${1-} dir=${2-} v rc=0
	local args=()
	if [ -z "$mr" ]; then
		printf 'none\n'
		return 0
	fi
	args=(--mr "$mr")
	if [ -n "$dir" ] && [ -d "$dir" ]; then
		args+=(--dir "$dir")
	fi
	v=$(forge_mr_state "${args[@]}" 2>/dev/null) || rc=$?
	if [ "$rc" -ne 0 ] || [ -z "$v" ]; then
		printf 'unknown\n'
		return 0
	fi
	printf '%s\n' "$v"
}

# --- one task ---------------------------------------------------------------

shift_row_json() { # shift_row_json <task> <shift-dir>
	local t=$1 dir=$2
	local unit branch tree clone agent agent_id container mr live events
	local terminal pool_state mr_state

	shift_resolve_dir "$dir" >/dev/null 2>&1 || return 0
	SHIFT_TASK=$t

	unit=$(shift_meta_unit || true)
	branch=$(shift_meta_branch || true)
	tree=$(shift_meta_tree || true)
	clone=$(shift_meta_get clone || true)
	agent=$(shift_meta_agent || true)
	agent_id=$(shift_meta_agent_id || true)
	container=$(shift_meta_get container || true)
	mr=$(shift_meta_mr || true)
	events=$(shift_event_count)

	if shift_is_live; then
		live=true
		terminal=$(ask_terminal "$agent_id")
		pool_state=$(ask_pool "$clone" "$tree" "$(shift_meta_get lease_id || true)")
		mr_state=$(ask_forge "$mr" "${tree:-$clone}")
	else
		# run/ is gone, so the shift clocked out and every live source is about
		# something that no longer exists. Asking would be noise.
		live=false
		terminal=n/a
		pool_state=n/a
		mr_state=n/a
	fi

	jq -nc --arg sid "$SHIFT_SID" --arg unit "$unit" --arg branch "$branch" \
		--arg tree "$tree" --arg agent "$agent" --arg agent_id "$agent_id" \
		--arg container "$container" --arg mr "$mr" --arg terminal "$terminal" \
		--arg pool "$pool_state" --arg mr_state "$mr_state" \
		--argjson live "$live" --argjson events "$events" \
		'{sid: $sid, unit: $unit, branch: $branch, tree: $tree, agent: $agent,
		  agent_id: $agent_id, container: $container, live: $live,
		  terminal: $terminal, pool: $pool, mr: $mr, mr_state: $mr_state,
		  events: $events}'
}

task_json_of() { # task_json_of <task-id>
	local t=$1 dir d rows='[]' row
	dir=$(task_dir "$t")

	while IFS= read -r d; do
		[ -n "$d" ] || continue
		row=$(shift_row_json "$t" "$d") || continue
		[ -n "$row" ] || continue
		rows=$(printf '%s' "$rows" | jq -c --argjson r "$row" '. + [$r]')
	done < <(
		shopt -s nullglob
		for d in "$dir"/shifts/*/; do
			[ -d "$d" ] && printf '%s\n' "${d%/}"
		done
	)

	jq -c --argjson shifts "$rows" '{
			id:       (.id // ""),
			title:    (.title // ""),
			complete: (.complete == true),
			units:    [(.units // [])[] | {name, repo, branch, target, mode, mr,
			                               scope: (.scope // [])}],
			shifts:   $shifts
		}' "$(task_file "$t")"
}

ids=()
if [ -n "$id" ] && [ "$all" -eq 0 ]; then
	ids=("$id")
else
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		ids+=("$t")
	done < <(task_list)
fi

rows='[]'
for t in ${ids[@]+"${ids[@]}"}; do
	row=$(task_json_of "$t") || continue
	rows=$(printf '%s' "$rows" | jq -c --argjson r "$row" '. + [$r]')
done

out=$(printf '%s' "$rows" | jq -c --arg home "$YAN_HOME" '{version: 1, home: $home, tasks: .}')

if [ "$as_json" -eq 1 ]; then
	printf '%s\n' "$out" | tr -d '\r'
	exit 0
fi

# --- rendering --------------------------------------------------------------

n=$(printf '%s' "$out" | jq '.tasks | length')
printf 'yan session-start\n'
printf '  home     %s\n' "$YAN_HOME"
printf '  tasks    %s\n' "$n"
if [ "$n" -eq 0 ]; then
	printf '\nnothing to rebuild: %s/tasks is empty\n' "$YAN_HOME"
	exit 0
fi

printf '%s' "$out" | jq -r '
	def d: if . == null or . == "" then "-" else . end;
	.tasks[] |
	"",
	"\(.id)  \(.title | d)   [\(if .complete then "done" else "open" end)]",
	(.units[]? |
		"  unit \(.name | d)  branch \(.branch | d)  target \(.target | d)  mode \(.mode | d)  mr \(.mr | d)"),
	(if (.shifts | length) == 0 then "  (no shift has ever been dispatched)" else empty end),
	(.shifts[]? |
		"  shift \(.sid)  \(.unit | d)  \(.branch | d)" +
		"  terminal=\(.terminal)  pool=\(.pool)  mr=\(.mr_state)" +
		"  events=\(.events)" +
		(if .live then "" else "  (clocked out)" end))
' | tr -d '\r'

printf '\n'
printf 'Nothing was stored: this picture was rebuilt from the task directories,\n'
printf 'the terminal, the pool and the forge, and it is rebuilt again next time.\n'
