#!/usr/bin/env bash
#
# yan report <state> "<note>" - the shift -> yan channel (td agents.md §5.4).
#
# This is a script rather than two sentences in the brief for one reason, and
# td §5.4 states it plainly: DO NOT COUNT ON AN AGENT REMEMBERING STEP TWO.
# Appending the event and touching the wake marker is one command, so a shift
# that reports at all reports completely. Wrapping it also buys three things
# the brief could not enforce: the state is checked against the allowed words,
# a timestamp is added, and the line is written atomically.
#
# It is one of exactly two commands a shift needs (the other is
# `yan scope-check`), and it stays inside the shift's write boundary: it
# touches run/status and run/signal and nothing else (td boundaries.md §9.3).
#
# ---------------------------------------------------------------------------
# THE FIVE ALLOWED STATES, and where they come from
# ---------------------------------------------------------------------------
#
# td §5.4 says "one of the five allowed words" but never lists all five. Three
# are named outright and two are derived; the derivation is recorded here so
# the next person changes the set on purpose rather than by accident:
#
#   done            td §5.4 ("a shift reports `done`") and td §8.2, whose three
#                   final states - `done: report`, `done: branch <name>`,
#                   `done: mr <url>` - are one state plus a deliverable. The
#                   deliverable goes in the note: `yan report done "mr <url>"`.
#   blocked         td §5.4, named.
#   needs-decision  td §5.4, named.
#   conflict        td §5.4's wake table lists "the merge has conflicts" as its
#                   own reason to wake the model, beside blocked and
#                   needs-decision. Of the four events in that column it is the
#                   only other one a shift discovers about itself - a shift has
#                   died (term_agent_alive), is stuck (the pane hash) and CI is
#                   red (the forge) are all observed from outside, and a shift
#                   does not wait for CI at all (td §5.3).
#   started         td §5.3's first tier ("Start"). It also earns its place
#                   operationally: on Windows every agent runs under winpty, so
#                   term_agent_alive can only ever say `alive` about the
#                   wrapper (conventions §2.1 and lib-term). One `started` line
#                   is the only positive proof that the agent booted, read the
#                   brief and can call back at all - which is precisely the
#                   thing yan has to act on when it never arrives.
#
# Everything else is refused loudly. A sixth word would quietly become a sixth
# meaning nobody handles.
#
set -euo pipefail

: "${YAN_HOME:?yan-report: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"

REPORT_STATES='started done blocked needs-decision conflict'

die() {
	printf 'report: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<EOF
usage: yan report <state> "<note>" [--sid <sid>] [--task <id>] [--dir <shift-dir>]

  <state>   one of: $REPORT_STATES
  <note>    one short line saying what happened

Appends the event to run/status and touches run/signal in one go.

Which shift is reporting is normally taken from the environment the spawn
script set (YAN_SHIFT_DIR, or YAN_TASK_DIR plus YAN_SID); --sid / --dir are
for yan itself and for tests.
EOF
}

state=
note=
opt_sid=
opt_task=
opt_dir=
positional=0

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--sid | --task | --dir)
		if [ $# -lt 2 ]; then
			usage >&2
			die "$1 needs a value" 2
		fi
		case $1 in
		--sid) opt_sid=$2 ;;
		--task) opt_task=$2 ;;
		--dir) opt_dir=$2 ;;
		esac
		shift 2
		;;
	--)
		shift
		while [ $# -gt 0 ]; do
			positional=$((positional + 1))
			case $positional in
			1) state=$1 ;;
			2) note=$1 ;;
			*)
				usage >&2
				die "too many arguments - a note is one quoted line" 2
				;;
			esac
			shift
		done
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		positional=$((positional + 1))
		case $positional in
		1) state=$1 ;;
		2) note=$1 ;;
		*)
			usage >&2
			die "too many arguments - a note is one quoted line" 2
			;;
		esac
		shift
		;;
	esac
done

# --- the state is checked before anything is written ------------------------

if [ -z "$state" ]; then
	usage >&2
	die "a state is required - one of: $REPORT_STATES" 2
fi

state_ok=0
for w in $REPORT_STATES; do
	if [ "$state" = "$w" ]; then
		state_ok=1
	fi
done
if [ "$state_ok" -ne 1 ]; then
	die "'$state' is not a shift state - use one of: $REPORT_STATES" 2
fi

if [ -z "$note" ]; then
	die "a note is required - say in one line what yan has to act on" 2
fi
case $note in
*$'\n'*)
	die "a note is one line - every line in run/status is one event, so a newline would forge a second one" 2
	;;
esac

# --- which shift is reporting ----------------------------------------------

if [ -n "$opt_dir" ]; then
	shift_resolve_dir "$opt_dir" || exit $?
elif [ -n "$opt_sid" ]; then
	shift_resolve "$opt_sid" "$opt_task" || exit $?
elif ! shift_resolve_env; then
	die "cannot tell which shift is reporting - set YAN_SHIFT_DIR (or YAN_TASK_DIR and YAN_SID) as the spawn script does, or pass --sid <sid>" 2
fi

# --- write ------------------------------------------------------------------

shift_event_append "$state" "$note" || exit $?

printf 'recorded %s in %s\n' "$state" "$(shift_status_file)"
