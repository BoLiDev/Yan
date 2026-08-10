#!/usr/bin/env bash
#
# hook-turnend-guard.sh --claude | --codex - the blocking Stop hook
# (td supervision.md, architecture.md §6).
#
# One file, two harnesses, because the question is the same one - "may this
# turn end while shifts are still live?" - and only the evidence differs.
#
# ---------------------------------------------------------------------------
# CLAUDE
# ---------------------------------------------------------------------------
#
# Block when there is still supervision responsibility AND the watcher is not
# healthy. Ending a turn while shifts are live is perfectly fine when autoarm
# is holding `yan wait`; what is not fine is ending it with nobody on duty.
#
# The guard's value shows up exactly when autoarm never ran at all - broken
# settings, a skipped hook - and only a second hook can detect that.
#
#   THE 800 ms WAIT. Both Stop hooks fire concurrently, so on a healthy turn
#   this hook can easily ask "is the lock taken?" while autoarm is still
#   claiming it. Waiting first is the difference between a guard and a false
#   alarm. What earns a pass inside that window is a lock that was NOT there
#   when the window opened - autoarm claiming it, with its first beacon still
#   to come. A lock that was already there while the watcher is unhealthy does
#   not become healthy by being looked at again, and is still a block.
#
#   IT DOES NOT READ STDIN, AND IT DOES NOT USE stop_hook_active. Claude sets
#   that flag true after asyncRewake continuations too, so the very turn that
#   needs a new watcher armed - the one right after a rewake - already looks
#   "already continued". A one-shot guard lets exactly that turn through, which
#   is the blind window this hook exists to close (td supervision.md). It keeps
#   its own count in run/guard-failures instead, reset when the watcher is
#   healthy again or when there is nothing left to supervise.
#
# ---------------------------------------------------------------------------
# CODEX
# ---------------------------------------------------------------------------
#
# The primary predicate is REMAINING SUPERVISION RESPONSIBILITY, not Claude's
# "autoarm lock plus fresh beacon". There is no autoarm on Codex and no
# long-lived wait process between checkpoint slices, so a missing lock is the
# normal state, not a fault. Codex may use stop_hook_active as a one-shot,
# because its continuation model does not have Claude's asyncRewake blind spot.
#
# UNVERIFIED: codex is not installed on the machine this was written on. The
# blocking shape here - `{"decision":"block","reason":...}` on stdout with exit
# 0 - follows the documented Codex hooks contract quoted in td
# supervision.md ("Stop can synchronously return decision: block for an
# immediate continuation"). The Claude path is exercised end to end; this one
# is written from the documentation only.
#
# ---------------------------------------------------------------------------
# FAIL OPEN ON PURPOSE
# ---------------------------------------------------------------------------
#
# The budget is 3 blocked attempts, then the guard lets the turn end with a
# loud warning. A guard that can wedge a session forever is worse than no
# guard: automatic supervision being broken is a thing `user` can see and fix,
# a session that will not end is not.
#
set -euo pipefail

if [ -z "${YAN_HOME:-}" ] || [ ! -f "${YAN_HOME}/bin/yan" ]; then
	YAN_HOME=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
fi
export YAN_HOME

# Dual dispatch, exactly as bin/yan does it. `node` is checked too: a guard that
# dies on a missing interpreter blocks the turn it exists to protect, which is
# the opposite of failing open.
if [ -f "$YAN_HOME/dist/hooks/turnend-guard.js" ] && command -v node >/dev/null 2>&1; then
	exec node "$YAN_HOME/dist/hooks/turnend-guard.js" "$@"
fi

# shellcheck source=bin/lib-watch.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-watch.sh"

# How long to let autoarm claim the lock before deciding it never will.
: "${YAN_GUARD_SETTLE:=0.8}"

usage() {
	cat <<'EOF'
usage: hook-turnend-guard.sh --claude | --codex [<task-id>]

Registered as a blocking Stop hook. Called by the harness, never by a person
and never by the model.
EOF
}

harness=
task=${YAN_TASK:-}

while [ $# -gt 0 ]; do
	case $1 in
	--claude | --codex)
		harness=${1#--}
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		usage >&2
		printf 'guard: unknown option: %s\n' "$1" >&2
		exit 2
		;;
	*)
		task=$1
		shift
		;;
	esac
done

if [ -z "$harness" ]; then
	usage >&2
	printf 'guard: say which harness this is - --claude or --codex\n' >&2
	exit 2
fi

# --- how each harness is told "no" ------------------------------------------

block() { # block <reason>
	case $harness in
	claude)
		# Exit 2 is Claude's blocking Stop: stderr is what the model reads.
		printf 'yan guard: %s\n' "$1" >&2
		exit 2
		;;
	*)
		jq -nc --arg r "yan guard: $1" '{decision: "block", reason: $r}' | tr -d '\r'
		exit 0
		;;
	esac
}

allow() {
	exit 0
}

fail_open() { # fail_open <count>
	printf 'yan guard: AUTOMATIC SUPERVISION IS BROKEN - %s attempts to arm a watcher for task %s have failed, so this turn is being let through.\n' "$1" "$task" >&2
	printf "yan guard: nothing is watching the live shifts. Check them by hand with 'yan ls %s', or restart yan.\n" "$task" >&2
	exit 0
}

# A guard that cannot tell whose turn this is must not hold the turn hostage.
if [ -z "$task" ]; then
	allow
fi
if ! watch_use "$task" 2>/dev/null || ! task_exists "$task"; then
	allow
fi

# --- the shared predicate: is there anything left to supervise? -------------

if [ "$(watch_live_count)" -eq 0 ]; then
	watch_guard_reset
	allow
fi

# --- Claude: responsibility remains, so somebody has to be on duty ----------

if [ "$harness" = claude ]; then
	if watch_healthy; then
		watch_guard_reset
		allow
	fi
	# Kept now, because every later predicate overwrites it. This sentence is
	# the only thing the model will see about WHY nobody was on duty.
	why=$(watch_why)
	why=${why:-no watcher on duty}

	# Whether anybody held the lock BEFORE the wait, because that is what makes
	# the wait meaningful: a lock that appears during it was autoarm claiming
	# it, and a lock that was already there while the watcher is unhealthy is
	# not going to become healthy by being looked at again.
	taken_before=0
	if watch_lock_taken; then
		taken_before=1
	fi

	# Polled in tenths rather than slept through in one go, so a turn that ends
	# with a healthy watcher pays a few milliseconds instead of the whole
	# budget. The window is what td supervision.md fixes at 800 ms; how often
	# we look inside it is ours.
	steps=$(awk -v s="$YAN_GUARD_SETTLE" 'BEGIN { printf "%d", s * 10 }')
	i=0
	while [ "$i" -lt "$steps" ]; do
		sleep 0.1 2>/dev/null || sleep 1
		if watch_healthy; then
			watch_guard_reset
			allow
		fi
		if [ "$taken_before" -eq 0 ] && watch_lock_taken; then
			# Autoarm claimed the lock while we waited and has not written its
			# first beacon yet. That is a watcher starting, not one missing.
			allow
		fi
		i=$((i + 1))
	done

	n=$(watch_guard_bump)
	if [ "$n" -gt "$YAN_GUARD_BUDGET" ]; then
		fail_open "$n"
	fi
	block "task $task still has live shifts and no healthy watcher ($why). Attempt $n of $YAN_GUARD_BUDGET: run 'yan wait' or let the Stop autoarm hook arm one, then end the turn."
fi

# --- Codex: responsibility remains and the model is trying to clock out -----

# Codex's own one-shot. Read only here: the Claude branch above has already
# exited, and it never touches stdin.
#
# BOUNDED, never a plain `cat`. A Stop hook that blocks on a pipe nobody ever
# closes is a session that cannot end, which is the failure this whole file is
# built to avoid. A harness that hands over a payload and closes hits EOF
# immediately; anything else costs one second and is treated as no payload.
#
# `|| [ -n "$line" ]` because a payload that ends without a newline - which a
# harness writing one JSON object is entitled to do - leaves the last chunk in
# $line while read itself reports failure.
payload=
line=
if [ ! -t 0 ]; then
	while IFS= read -r -t "${YAN_GUARD_STDIN_TIMEOUT:-1}" line || [ -n "$line" ]; do
		payload="$payload$line"
		line=
	done
fi
if [ -n "$payload" ]; then
	# jq directly, so conventions §2.3 applies: jq.exe on Git Bash can hand back
	# a trailing CR, and "true\r" is not "true".
	active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // false' 2>/dev/null | tr -d '\r') || active=false
	if [ "$active" = true ]; then
		allow
	fi
fi

n=$(watch_guard_bump)
if [ "$n" -gt "$YAN_GUARD_BUDGET" ]; then
	fail_open "$n"
fi
block "task $task still has live shifts. Attempt $n of $YAN_GUARD_BUDGET: run 'yan wait --seconds \${YAN_CODEX_CHECKPOINT:-180}' for another checkpoint slice, then 'yan drain', before ending the turn."
