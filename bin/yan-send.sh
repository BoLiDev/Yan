#!/usr/bin/env bash
#
# yan send <sid> "<line>" - yan -> shift, while it is running (td §5.4).
#
# One short line. The long contract was written once, into shifts/<sid>/brief.md,
# and anything long that comes up afterwards goes into a file: write the file,
# send the path. A wall of text typed into a running agent's prompt is how the
# terminal ends up with half a paragraph in it and the agent with the other
# half.
#
# THE TEXT AND THE ENTER GO SEPARATELY. That is td §5.4's requirement and
# lib-term already implements it, so this command only exposes it:
#
#     yan send s3 "check the failing test first"   type the line, press Enter
#     yan send s3 --no-enter "..."                 type it and stop there
#     yan send s3 --enter                          press Enter, nothing else
#
# The reason the split matters in practice: agent CLIs routinely swallow or
# re-render the first Enter while they are still painting their input box. The
# fix is to press Enter again - never to type the whole line a second time and
# have it arrive twice. So: type once, retry the Enter alone.
#
# The terminal id comes from run/meta.json, never a window label: tmux does not
# promise labels are unique (td agents.md §5.7 practice 1).
#
set -euo pipefail

: "${YAN_HOME:?yan-send: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"
# shellcheck source=bin/lib-term.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-term.sh"

# One line to a prompt, not a document. Long enough for a real instruction,
# short enough that "put it in a file and send the path" stays the habit.
: "${YAN_SEND_MAX:=500}"

die() {
	printf 'send: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan send <sid> "<line>" [--task <id>]
       yan send <sid> --no-enter "<line>"
       yan send <sid> --enter

  one short line; anything long goes in a file and only the path is sent
  --no-enter  type the text and do not press Enter
  --enter     press Enter and nothing else (retry a swallowed one)
EOF
}

sid=
text=
opt_task=
have_text=0
want_text=1
want_enter=1

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--enter)
		want_text=0
		shift
		;;
	--no-enter)
		want_enter=0
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
	--)
		shift
		while [ $# -gt 0 ]; do
			if [ -z "$sid" ]; then
				sid=$1
			elif [ "$have_text" -eq 0 ]; then
				text=$1
				have_text=1
			else
				usage >&2
				die "too many arguments - a line is one quoted argument" 2
			fi
			shift
		done
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		if [ -z "$sid" ]; then
			sid=$1
		elif [ "$have_text" -eq 0 ]; then
			text=$1
			have_text=1
		else
			usage >&2
			die "too many arguments - a line is one quoted argument" 2
		fi
		shift
		;;
	esac
done

if [ -z "$sid" ]; then
	usage >&2
	die "a shift id is required" 2
fi

if [ "$want_text" -eq 1 ]; then
	if [ "$have_text" -eq 0 ]; then
		usage >&2
		die "a line is required - or pass --enter to send only the Enter key" 2
	fi
	if [ -z "$text" ]; then
		die "refusing to send an empty line - pass --enter if that is what you meant" 2
	fi
	case $text in
	*$'\n'*)
		die "a line is one line - write the long version to a file and send its path" 2
		;;
	esac
	if [ "${#text}" -gt "$YAN_SEND_MAX" ]; then
		die "that line is ${#text} characters and the limit is $YAN_SEND_MAX - write it to a file and send the path instead" 2
	fi
elif [ "$have_text" -eq 1 ]; then
	die "--enter sends only the Enter key - it takes no text" 2
fi

# --- find the agent ---------------------------------------------------------

shift_resolve "$sid" "$opt_task" || exit $?

if ! shift_is_live; then
	die "shift $sid has clocked out - its run/ directory is gone, so there is no terminal left to talk to" 1
fi

agent_id=$(shift_meta_agent_id) ||
	die "no terminal id in $(shift_meta_file) - the spawn script records the id term_agent_start printed, and a shift is never located by label" 1

# --- send -------------------------------------------------------------------
#
# Two calls into the seam, not one: this is the same split lib-term makes, kept
# visible here so `--no-enter` followed by `--enter` really is the same two
# steps a plain send performs.

if [ "$want_text" -eq 1 ]; then
	term_send "$agent_id" --no-enter "$text" || exit $?
fi
if [ "$want_enter" -eq 1 ]; then
	term_send "$agent_id" --enter || exit $?
fi
