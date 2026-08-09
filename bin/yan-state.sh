#!/usr/bin/env bash
#
# yan state <sid> - what is true about a shift RIGHT NOW.
#
# ---------------------------------------------------------------------------
# THIS COMMAND DOES NOT READ THE LAST LINE OF run/status. NOT EVER.
# ---------------------------------------------------------------------------
#
# td agents.md §5.4: *every line in run/status is an event, not the current
# state.* A shift that reported `done` and then died has `done` as its last
# line; so has a shift that reported `done` an hour ago and is still waiting
# for its merge request to be reviewed; so has a shift whose work has since
# landed. The last line is the most recent thing that HAPPENED, and reading it
# as the state is the single mistake this command exists to prevent.
#
# The state is DERIVED, every time, from the live sources (architecture.md
# §5.1): run/meta.json plus the terminal, git and the forge. run/status is
# reported here as a COUNT of events and in no other way - the number tells you
# whether anything has happened, and refuses to tell you what.
#
# The five verdicts, and the order they are decided in:
#
#   clocked-out  run/ is gone. Clocking out deletes it whole (td INDEX.md §3),
#                so its absence is the fact - checked first, because every
#                other source is about a shift that is still running.
#   merged       the forge says the shift branch's merge request is merged.
#                That is a shift's objective end condition (td §5.3) and it
#                outranks the terminal on purpose: an agent still sitting in
#                its pane after the work landed is a shift to clock out, not a
#                shift to wait for. Ancestry is never used for this, for the
#                squash-merge reason in td §5.3.
#   dead         the terminal says the agent is gone.
#   running      the terminal says the agent is alive.
#   unknown      nothing above could be established. Said out loud rather than
#                rounded up to something more comfortable - the same rule the
#                seams follow (architecture.md §4.3).
#
# run/meta.json is read defensively (lib-shift): Phase 1 fixed .unit, .branch,
# .tree and .agent; Phase 7 owns writing the file and adds the terminal ids and
# the lease id. A missing key costs one fact, never a crash.
#
set -euo pipefail

: "${YAN_HOME:?yan-state: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"
# shellcheck source=bin/lib-term.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-term.sh"
# shellcheck source=bin/lib-forge.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-forge.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"

die() {
	printf 'state: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan state <sid> [--task <id>] [--json | --verdict]

  <sid>       the shift id; the task is taken from $YAN_TASK when it is set
  --verdict   print only the derived state word
  --json      every fact this derived, machine readable

Verdicts: clocked-out | merged | dead | running | unknown
EOF
}

sid=
opt_task=
as_json=0
verdict_only=0

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
	--verdict)
		verdict_only=1
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
if [ "$as_json" -eq 1 ] && [ "$verdict_only" -eq 1 ]; then
	die "--json and --verdict are alternatives - pass one" 2
fi

shift_resolve "$sid" "$opt_task" || exit $?

# --- what run/meta.json says (never fatal) ----------------------------------

unit=$(shift_meta_unit || true)
branch=$(shift_meta_branch || true)
tree=$(shift_meta_tree || true)
agent=$(shift_meta_agent || true)
agent_id=$(shift_meta_agent_id || true)
mr=$(shift_meta_mr || true)
events=$(shift_event_count)

live=0
if shift_is_live; then
	live=1
fi

# --- source 1: the terminal -------------------------------------------------
#
# term_agent_alive is called with ONE argument. Its optional second argument
# cannot mean the same thing on both runtimes - on Windows every agent runs
# under winpty, so the pane's command is always `winpty` and naming the
# expected CLI could only ever turn `alive` into `unknown` there (lib-term,
# conventions §2.1). One argument, one meaning, both platforms.
terminal=unknown
terminal_why=
if [ "$live" -eq 0 ]; then
	terminal_why='run/ is gone; there is nothing left to ask about'
elif [ -z "$agent_id" ]; then
	terminal_why='no terminal id in run/meta.json'
else
	rc=0
	terminal=$(term_agent_alive "$agent_id") || rc=$?
	if [ "$rc" -ne 0 ]; then
		# A backend that cannot answer is a real error, not an `unknown`:
		# `backend: herdr` fails closed here exactly as it does everywhere else.
		die "cannot ask the terminal about $agent_id (see the message above)" 1
	fi
fi

# --- source 2: git ----------------------------------------------------------

tree_state=unknown
head_branch=
if [ -z "$tree" ]; then
	tree_state=unrecorded
elif [ ! -d "$tree" ]; then
	tree_state=missing
elif ! head_branch=$(git_current_branch "$tree" 2>/dev/null); then
	head_branch=
	tree_state=unknown
elif git_is_clean "$tree" 2>/dev/null; then
	tree_state=clean
else
	tree_state=dirty
fi

# --- source 3: the forge ----------------------------------------------------
#
# Only when a merge request has been recorded. There is no branch-to-MR lookup
# here: forge_mr_state takes the URL forge_mr_create returned, and inventing a
# search would put forge vocabulary in a subcommand (td §8.4).
mr_state=none
if [ -n "$mr" ]; then
	forge_args=(--mr "$mr")
	if [ -n "$tree" ] && [ -d "$tree" ]; then
		forge_args+=(--dir "$tree")
	fi
	rc=0
	mr_state=$(forge_mr_state "${forge_args[@]}") || rc=$?
	if [ "$rc" -ne 0 ]; then
		# The query verbs answer with a closed-set value even when the forge is
		# unreachable; a non-zero exit means the call or the configuration was
		# wrong, and that is worth failing on rather than papering over.
		die "cannot ask the forge about $mr (see the message above)" 1
	fi
fi

# --- the derivation ---------------------------------------------------------

derive() {
	if [ "$live" -eq 0 ]; then
		printf 'clocked-out\n'
		return 0
	fi
	if [ "$mr_state" = merged ]; then
		printf 'merged\n'
		return 0
	fi
	case $terminal in
	dead)
		printf 'dead\n'
		return 0
		;;
	alive)
		printf 'running\n'
		return 0
		;;
	esac
	printf 'unknown\n'
}

verdict=$(derive)

# --- output -----------------------------------------------------------------

if [ "$verdict_only" -eq 1 ]; then
	printf '%s\n' "$verdict"
	exit 0
fi

if [ "$as_json" -eq 1 ]; then
	jq -nc \
		--arg sid "$SHIFT_SID" --arg task "$SHIFT_TASK" --arg unit "$unit" \
		--arg branch "$branch" --arg tree "$tree" --arg agent "$agent" \
		--arg agent_id "$agent_id" --arg terminal "$terminal" \
		--arg tree_state "$tree_state" --arg head_branch "$head_branch" \
		--arg mr "$mr" --arg mr_state "$mr_state" \
		--argjson events "$events" --argjson live "$live" \
		--arg state "$verdict" '{
			version: 1, sid: $sid, task: $task, unit: $unit, branch: $branch,
			tree: $tree, agent: $agent, agent_id: $agent_id, live: ($live == 1),
			terminal: $terminal, tree_state: $tree_state,
			head_branch: $head_branch, mr: $mr, mr_state: $mr_state,
			events: $events, state: $state
		}'
	exit 0
fi

row() { printf '%-10s %s\n' "$1" "$2"; }
dash() { if [ -z "${1:-}" ]; then printf -- '-'; else printf '%s' "$1"; fi; }

printf '%s\n' "$SHIFT_SID"
row task "$(dash "$SHIFT_TASK")"
row unit "$(dash "$unit")"
row branch "$(dash "$branch")"
row tree "$(dash "$tree")"
row agent "$(dash "$agent")"
printf '\n'
if [ -n "$terminal_why" ]; then
	row terminal "$terminal  ($terminal_why)"
else
	row terminal "$terminal  (id $agent_id)"
fi
if [ -n "$head_branch" ] && [ -n "$branch" ] && [ "$head_branch" != "$branch" ]; then
	row git "$tree_state  (HEAD is on $head_branch, meta says $branch)"
else
	row git "$tree_state"
fi
if [ "$mr_state" = none ]; then
	row forge 'none  (no merge request recorded in run/meta.json)'
else
	row forge "$mr_state  ($mr)"
fi
row events "$events  (run/status lines are EVENTS, not the state)"
printf '\n'
row state "$verdict"
