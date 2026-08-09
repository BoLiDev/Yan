#!/usr/bin/env bash
#
# yan wait - the watcher (td supervision.md, architecture.md §5.1).
#
# ---------------------------------------------------------------------------
# ONE COMMAND, TWO SHAPES, AND A PURE OBSERVER
# ---------------------------------------------------------------------------
#
#   yan wait                 Claude's Stop autoarm runs this IN THE HOOK'S
#                            FOREGROUND for minutes to hours
#   yan wait --seconds N     the Codex model calls this as a foreground tool,
#                            N defaults to $YAN_CODEX_CHECKPOINT or 180, and
#                            it stops dead at N so the model gets control back
#
# Same three sources either way. The only difference is when it gives up.
#
# It holds NO DURABLE STATE OF ITS OWN. A timeout, a kill, or dying with its
# process tree loses nothing: the shift is still in its own terminal and every
# fact it acted on is a file somebody else owns. The three things it does write
# are all somebody else's channel - the wake file the model drains, the
# single-flight lock, and the beacon other processes read (lib-watch.sh).
#
# ---------------------------------------------------------------------------
# EXACTLY THREE SOURCES. THERE IS NO FOURTH.
# ---------------------------------------------------------------------------
#
#   signal        run/signal exists          the shift reported via `yan report`
#   agent-alive   term_agent_alive = dead    the agent died and cannot say so
#   pane-hash     the pane's content hash     stuck, waiting on a dialog, or it
#                 has not changed for a       forgot to report - the most common
#                 long time                   agent failure of the three
#
# td supervision.md rules out the fourth by name: yan does not poll pull
# requests or CI, because a shift does not wait for CI before clocking out
# (td agents.md §5.3). When every shift has clocked out and outbound CI is
# running there is nothing here to wait for - the next `yan session-start` asks
# the forge. That is a known and accepted gap, not an omission.
#
# The sources live in this file and get no layer of their own: architecture.md
# §5.1 names this command as the one most likely to grow fat. $WAIT_SOURCES
# below is the whole list, and `yan wait --sources` prints it.
#
# ---------------------------------------------------------------------------
# EDGE-TRIGGERED VERSUS LEVEL-TRIGGERED
# ---------------------------------------------------------------------------
#
# `signal` is an edge: this command is its only reader, so it writes the reason
# down and THEN removes the marker - the same order `yan report` uses for the
# opposite reason. A crash in between repeats a wake; the reverse order would
# lose one.
#
# `agent-alive` and `pane-hash` are levels: a dead agent stays dead until
# somebody acts. A reason still sitting undrained in the wake file therefore
# suppresses an identical one, or a rearmed watcher would wake the model again
# the instant it started, forever.
#
# The pane-hash clock is IN MEMORY and starts again with every wait. That is a
# consequence of holding no durable state, and it has a real cost: a Codex
# checkpoint slice shorter than --stuck can never reach the threshold, so stuck
# detection is a Claude-path strength (td supervision.md: Codex is not
# zero-cost parity with Claude).
#
# ---------------------------------------------------------------------------
# EXIT CODES
# ---------------------------------------------------------------------------
#
#     0  something actionable happened; the reason is on stdout and in the wake
#        file. Claude's autoarm turns this into a rewake; Codex drains and acts
#   124  a --seconds slice ended quietly while shifts are still being watched:
#        drain, then start another slice
#     3  there is nothing (left) to supervise. This is the quiet end of the
#        unbounded shape, and it is SILENT there - nothing on stdout, no wake
#        file, so no model wake
#     4  another watcher already holds the single-flight lock; this process did
#        not start. Under Claude every Stop can fire autoarm, and without the
#        lock you would get several watchers
#     2  called wrongly            1  it did not work
#
set -euo pipefail

: "${YAN_HOME:?yan-wait: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-watch.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-watch.sh"
# shellcheck source=bin/lib-term.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-term.sh"

# The whole list. Adding a word here without adding a source below (or the
# other way round) is what tests/unit/yan-wait-sources.test.sh looks for.
WAIT_SOURCES='signal agent-alive pane-hash'

# Defaults, all overridable, because a test may not sleep for three minutes.
: "${YAN_WAIT_INTERVAL:=5}"
: "${YAN_WAIT_STUCK:=900}"
: "${YAN_CODEX_CHECKPOINT:=180}"

die() {
	printf 'wait: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<EOF
usage: yan wait [<task-id>] [--seconds [N]] [--interval S] [--stuck S] [--sources]

  (no --seconds)   watch until something happens. Claude's Stop autoarm runs
                   this in the hook's foreground for minutes to hours
  --seconds [N]    stop after N seconds whatever happens (default
                   \$YAN_CODEX_CHECKPOINT, currently $YAN_CODEX_CHECKPOINT). The Codex
                   checkpoint slice
  --interval S     how often to look (default \$YAN_WAIT_INTERVAL, $YAN_WAIT_INTERVAL)
  --stuck S        how long a pane may go unchanged before it counts as stuck
                   (default \$YAN_WAIT_STUCK, $YAN_WAIT_STUCK)
  --sources        print the sources this watches, one per line, and exit

The task comes from <task-id>, --task or \$YAN_TASK, in that order.

Exit: 0 something happened (reason on stdout and in the wake file) | 124 the
slice ended quietly | 3 nothing left to supervise | 4 another watcher holds the
single-flight lock.
EOF
}

id=
bounded=0
seconds=0
interval=$YAN_WAIT_INTERVAL
stuck=$YAN_WAIT_STUCK
sources_only=0

is_number() { # <candidate> - a whole number of seconds, one or more digits
	case ${1:-} in
	'' | *[!0-9]*) return 1 ;;
	esac
	return 0
}

is_delay() { # <candidate> - seconds, possibly fractional (sleep 0.2)
	case ${1:-} in
	'' | *[!0-9.]* | *.*.*) return 1 ;;
	esac
	return 0
}

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--sources)
		sources_only=1
		shift
		;;
	--seconds)
		bounded=1
		seconds=$YAN_CODEX_CHECKPOINT
		if [ $# -ge 2 ] && is_number "${2:-}"; then
			seconds=$2
			shift
		fi
		shift
		;;
	--interval | --stuck | --task)
		if [ $# -lt 2 ]; then
			usage >&2
			die "$1 needs a value" 2
		fi
		case $1 in
		--interval)
			is_delay "$2" || die "--interval takes seconds, got: $2" 2
			interval=$2
			;;
		--stuck)
			is_number "$2" || die "--stuck takes a whole number of seconds, got: $2" 2
			stuck=$2
			;;
		--task) id=$2 ;;
		esac
		shift 2
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

if [ "$sources_only" -eq 1 ]; then
	for s in $WAIT_SOURCES; do
		printf '%s\n' "$s"
	done
	exit 0
fi

if [ "$bounded" -eq 1 ] && { ! is_number "$seconds" || [ "$seconds" -lt 1 ]; }; then
	die "--seconds takes a whole number of seconds of at least 1, got: $seconds" 2
fi
is_number "$stuck" || die "--stuck takes a whole number of seconds, got: $stuck" 2

if [ -z "$id" ]; then
	id=${YAN_TASK:-}
fi
if [ -z "$id" ]; then
	usage >&2
	die "cannot tell which task to watch - pass a task id, or set \$YAN_TASK as the task container does" 2
fi
task_exists "$id" || die "no such task: $id" 2

watch_use "$id" || exit $?

# --- nothing to supervise ---------------------------------------------------
#
# Silent in the unbounded shape (td supervision.md: a quiet end there is a
# silent non-zero exit and no model wake). The bounded shape says so on stderr,
# because the Codex model is the caller and needs to know to stop slicing.

quiet_no_work() {
	if [ "$bounded" -eq 1 ]; then
		printf 'wait: nothing to supervise in task %s - every shift has clocked out\n' "$id" >&2
	fi
	exit 3
}

[ "$(watch_live_count)" -gt 0 ] || quiet_no_work

# --- single flight ----------------------------------------------------------
#
# lib-lock.sh, never a second scheme (conventions §2.2). The lock records $$,
# which is this process - `yan` exec's this file, so the pid is the yan the
# harness started, and that is exactly the owner the identity check wants.

if watch_lock_taken; then
	printf 'wait: another watcher is already on duty for task %s (pid %s) - not starting a second one\n' \
		"$id" "$(lock_owner_pid "$WATCH_LOCK" 2>/dev/null || printf '?')" >&2
	exit 4
fi

mkdir -p -- "$WATCH_RUN" || die "cannot create $WATCH_RUN"
if ! lock_acquire "$WATCH_LOCK" 0 2>/dev/null; then
	if watch_lock_taken || lock_is_held "$WATCH_LOCK"; then
		printf 'wait: another watcher took the single-flight lock first - not starting a second one\n' >&2
		exit 4
	fi
	die "cannot take the single-flight lock at $WATCH_LOCK" 1
fi
watch_lock_stamp || true

release() {
	lock_release "$WATCH_LOCK" >/dev/null 2>&1 || true
}
trap 'release' EXIT
# A watcher is meant to be killable: it is the process tree of a hook that the
# harness owns. Dying must leave the lock behind for nobody.
trap 'release; trap - INT TERM; kill -INT $$' INT TERM

# --- the three sources ------------------------------------------------------

# pane_hash <agent-id> - a hash of what is on the agent's terminal right now.
#
# cksum because it is on both runtimes and needs no dialect. The pipeline is
# safe under `set -o pipefail`: cksum reads its input to the end, so the
# producer never takes SIGPIPE the way it would with `grep -q`.
pane_hash() {
	local id=${1:-} text rc=0
	text=$(term_read "$id" 2>/dev/null) || rc=$?
	[ "$rc" -eq 0 ] || return 1
	printf '%s' "$text" | cksum | tr -d ' \t\r\n'
}

declare -A LAST_HASH=()
declare -A HASH_SINCE=()

REASON=

# fire <kind> <sid> <text> - remember why this wait is ending.
fire() {
	REASON="$1: $2 - $3"
}

# --- the loop ---------------------------------------------------------------

started=$(date +%s)
deadline=$((started + seconds))

while :; do
	watch_beacon_touch || die "cannot write the beacon at $WATCH_BEACON" 1

	live=0
	REASON=
	signal_file=
	while IFS=$'\t' read -r sid aid sdir; do
		[ -n "$sid" ] || continue
		live=$((live + 1))

		# Source 1: the shift reported on its own. An edge - consumed below.
		if [ -f "$sdir/run/signal" ]; then
			fire signal "$sid" "the shift reported - 'yan state $sid' says what is true now"
			signal_file=$sdir/run/signal
			break
		fi

		[ -n "$aid" ] || continue

		# Source 2: the agent died, which it cannot report itself.
		#
		# ONE ARGUMENT. term_agent_alive's optional expected-command cannot mean
		# the same thing on both runtimes - on Windows every agent runs under
		# winpty, so naming the CLI could only ever turn `alive` into `unknown`
		# there (conventions §2.1, lib-term). `unknown` is never an event: we do
		# not round "I cannot tell" up to "it died".
		verdict=$(term_agent_alive "$aid" 2>/dev/null) || verdict=unknown
		if [ "$verdict" = dead ]; then
			reason="died: $sid - the agent is gone (term_agent_alive said dead)"
			if ! watch_wake_has "$reason"; then
				fire died "$sid" "the agent is gone (term_agent_alive said dead)"
				break
			fi
			continue
		fi

		# Source 3: the pane has stopped moving - stuck, waiting on a dialog, or
		# it forgot to report. The clock is in memory and starts again with every
		# wait, which is what "holds no durable state" costs.
		h=$(pane_hash "$aid") || continue
		now=$(date +%s)
		if [ "${LAST_HASH[$sid]:-}" != "$h" ]; then
			LAST_HASH[$sid]=$h
			HASH_SINCE[$sid]=$now
			continue
		fi
		age=$((now - ${HASH_SINCE[$sid]:-$now}))
		if [ "$age" -ge "$stuck" ]; then
			# The threshold and not the measured age: the age grows every loop,
			# and a reason that changes every second could never match the one
			# already sitting undrained in the wake file.
			reason="stuck: $sid - the pane has not changed for at least ${stuck}s"
			if ! watch_wake_has "$reason"; then
				fire stuck "$sid" "the pane has not changed for at least ${stuck}s"
				break
			fi
		fi
	done < <(watch_live_shifts)

	if [ -n "$REASON" ]; then
		# The reason is written down before the marker is consumed: a crash in
		# between repeats a wake, and repeating one is free.
		watch_wake_write "$REASON" || die "cannot write the wake file at $WATCH_WAKE" 1
		if [ -n "${signal_file:-}" ]; then
			rm -f -- "$signal_file" || true
			signal_file=
		fi
		printf '%s\n' "$REASON"
		exit 0
	fi

	[ "$live" -gt 0 ] || quiet_no_work

	if [ "$bounded" -eq 1 ] && [ "$(date +%s)" -ge "$deadline" ]; then
		exit 124
	fi

	sleep "$interval" 2>/dev/null || sleep 1
done
