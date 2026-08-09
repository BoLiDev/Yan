#!/usr/bin/env bash
#
# hook-autoarm.sh - Claude's Stop autoarm (td supervision.md, architecture.md
# §6). Registered in .claude/settings.json with `asyncRewake: true` and a long
# timeout. NOT registered for Codex, which parses `async` but does not run
# asynchronous command hooks and therefore cannot hold a multi-hour watcher.
#
#   is there anything to supervise?   no  -> exit 0, quiet
#   take the single-flight lock and run long `yan wait` IN THIS FOREGROUND
#     something happened   -> exit 2, the reason on stderr, Claude rewakes yan
#     nothing left to do   -> exit 0, quiet
#
# ---------------------------------------------------------------------------
# NEVER `&`. NEVER BACKGROUND. NEVER nohup / setsid / disown.
# ---------------------------------------------------------------------------
#
# The watcher runs in this hook's foreground so that THE HARNESS OWNS THE
# PROCESS GROUP (td supervision.md, architecture.md §6). A backgrounded watcher
# outlives the session that armed it, survives the harness being killed, and is
# then a second watcher nobody can see - which is the failure the single-flight
# lock exists to prevent, made permanent. tests/unit/hook-autoarm.test.sh reads
# this file and fails if a background operator appears in it.
#
# This hook is why "the model forgot to start supervision" is not a possible
# failure on the Claude path: the model never calls `yan wait` here. What can
# still fail is autoarm never running at all - broken settings, a skipped
# hook - and only a second hook can notice that, which is what
# hook-turnend-guard.sh is for.
#
# It does not read stdin. Nothing it decides depends on the harness's payload.
#
set -euo pipefail

# The harness starts hooks with whatever environment the yan process had, and
# `yan continue` exports YAN_HOME and YAN_TASK into the pane it starts yan in.
# When YAN_HOME is missing or points somewhere else, this file's own location
# is the answer: hooks ship inside $YAN_HOME/bin.
if [ -z "${YAN_HOME:-}" ] || [ ! -f "${YAN_HOME}/bin/yan" ]; then
	YAN_HOME=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
fi
export YAN_HOME

# shellcheck source=bin/lib-watch.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-watch.sh"

note() {
	printf 'yan autoarm: %s\n' "$1" >&2
}

task=${YAN_TASK:-}
if [ -n "${1:-}" ]; then
	task=$1
fi

# A hook that cannot tell whose supervision this is has nothing to arm. It says
# so once and gets out of the way - a Stop hook that fails is a Stop hook that
# blocks a turn.
if [ -z "$task" ]; then
	exit 0
fi
if ! watch_use "$task" 2>/dev/null; then
	exit 0
fi
if ! task_exists "$task"; then
	exit 0
fi

# Nothing to supervise: no shift is live, so there is nothing for a watcher to
# see and no reason to hold a lock for hours.
if [ "$(watch_live_count)" -eq 0 ]; then
	exit 0
fi

# Somebody is already on duty. Every Stop can fire autoarm, so this is the
# normal case whenever a turn ends while a watcher is running.
if watch_lock_taken; then
	exit 0
fi

# --- the watcher, in this foreground ---------------------------------------
#
# No --seconds: this is the long shape. Its stderr flows through to ours; its
# stdout is the reason, which becomes the banner Claude shows the model.

rc=0
reason=$("$YAN_HOME/bin/yan" wait --task "$task") || rc=$?

case $rc in
0)
	note "$reason"
	note "run 'yan drain' first, then handle it."
	exit 2
	;;
3)
	# Every shift clocked out while we watched. Nothing to wake anybody for.
	exit 0
	;;
4)
	# Another watcher took the lock between our check and the start. Fine.
	exit 0
	;;
*)
	# Supervision did not start. Do not block the turn over it - the turn-end
	# guard is the thing that notices an unhealthy watcher, and it has a budget
	# so a broken watcher cannot wedge the session.
	note "'yan wait' exited $rc without arming supervision - see the message above; 'yan ls $task' shows what is live"
	exit 0
	;;
esac
