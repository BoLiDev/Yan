# shellcheck shell=bash
#
# lib-watch.sh - the four files supervision keeps under tasks/<id>/run/, and
# the two predicates that read them (td supervision.md).
#
# ---------------------------------------------------------------------------
# THIS IS NOT A LAYER OVER THE THREE WAIT SOURCES
# ---------------------------------------------------------------------------
#
# architecture.md §5.1 names `yan wait` as the command most likely to grow fat
# and says the three sources - run/signal, term_agent_alive, the pane hash -
# live INSIDE it and do not get a layer of their own. They do not appear in
# this file. Nothing here polls anything, and nothing here decides anything.
#
# What is here is the same kind of module as lib-shift.sh: one of yan's OWN
# formats, in this case the four files supervision writes, so that `yan wait`,
# hook-autoarm.sh and hook-turnend-guard.sh cannot drift about where they are
# or what "the watcher is healthy" means. Three private copies of that
# predicate is exactly how the guard and the watcher end up disagreeing about
# whether anybody is on duty.
#
#   tasks/<id>/run/wake            the reason, from "wait exited" to the
#                                  model's next turn. `yan wait` writes it,
#                                  `yan drain` reads and clears it
#   tasks/<id>/run/wait.lock       the single-flight lock (lib-lock; mkdir is
#                                  the only atomic primitive on both runtimes)
#   tasks/<id>/run/beacon          attendance for the WATCHER. `yan wait`
#                                  rewrites it every loop; everyone else reads
#                                  it. It is NOT how a shift's death is
#                                  detected - that is term_agent_alive
#   tasks/<id>/run/guard-failures  the turn-end guard's own count, because
#                                  Claude's stop_hook_active cannot be trusted
#                                  as a one-shot (td supervision.md)
#
# Supervision is per-yan and a yan is per-task (td agents.md §5.2), so all four
# belong to the task, which is also where Phase 5's `yan drain` already looks.
#
# WHY THE BEACON CARRIES ITS OWN TIMESTAMP rather than being an empty file
# whose mtime is read: reading an mtime portably means `stat` (whose flags
# differ per platform) or `find -newermt`, and both are a second dialect to get
# wrong on MSYS2. One line of text - epoch, owner pid, task - is the same on
# both runtimes, and it lets a test forge a stale beacon without sleeping.
#
# The pid in the beacon is also half of the identity check: a beacon left
# behind by a watcher that is gone must not vouch for a lock somebody else
# holds, and a lock whose owner never started looping must not be vouched for
# by an old beacon. Both directions matter (td supervision.md).

if [ -n "${_YAN_LIB_WATCH_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_WATCH_SOURCED=1

# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"
# shellcheck source=bin/lib-lock.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-lock.sh"

# How old the beacon may be before the watcher stops counting as healthy.
: "${YAN_WATCH_BEACON_MAX:=300}"

# What the guard is allowed to block before it fails open (td supervision.md:
# "The budget is 3 ... After that, fail open with a loud warning").
: "${YAN_GUARD_BUDGET:=3}"

WATCH_TASK=
WATCH_RUN=
WATCH_WAKE=
WATCH_LOCK=
WATCH_BEACON=
WATCH_GUARD=
# Why the last watch_healthy said no. For messages only; never a decision.
WATCH_WHY=

_watch_err() {
	printf 'lib-watch: %s\n' "$1" >&2
}

# watch_why - why the last health question was answered no.
#
# Read it straight after asking, because every later predicate overwrites it.
# It is a sentence for a human or for the model; nothing branches on it.
watch_why() {
	printf '%s\n' "$WATCH_WHY"
}

_watch_now() {
	date +%s
}

# --- where the four files are ----------------------------------------------

# watch_use <task-id> - point at one task's supervision files.
#
# $YAN_WAKE_FILE overrides the wake path exactly as it does in `yan drain`, so
# the two commands can never be pointed at different files by a test.
watch_use() {
	local id=${1:-} dir
	if [ -z "$id" ]; then
		_watch_err "usage: watch_use <task-id>"
		return 2
	fi
	dir=$(task_dir "$id") || return $?
	WATCH_TASK=$id
	WATCH_RUN=${YAN_WATCH_DIR:-$dir/run}
	WATCH_WAKE=${YAN_WAKE_FILE:-$WATCH_RUN/wake}
	WATCH_LOCK=$WATCH_RUN/wait.lock
	WATCH_BEACON=$WATCH_RUN/beacon
	WATCH_GUARD=$WATCH_RUN/guard-failures
}

_watch_selected() {
	if [ -z "$WATCH_RUN" ]; then
		_watch_err "no task selected - call watch_use first"
		return 2
	fi
}

_watch_mkrun() {
	_watch_selected || return $?
	mkdir -p -- "$WATCH_RUN" 2>/dev/null || {
		_watch_err "cannot create $WATCH_RUN"
		return 1
	}
}

# watch_identity - what the single-flight lock must say to count as a watcher.
#
# The lock directory is lib-lock's, and lib-lock records the pid, the time and
# the host. It cannot know what the lock is FOR, and `tasks/<id>/.enter.lock`
# proves the point: a live lock in the same tree that has nothing to do with
# supervision. One stamped line closes that off.
watch_identity() {
	printf 'yan-wait %s\n' "$WATCH_TASK"
}

# watch_lock_stamp - record the identity in a lock this process just took.
watch_lock_stamp() {
	_watch_selected || return $?
	watch_identity >"$WATCH_LOCK/identity"
}

# --- the beacon -------------------------------------------------------------

# watch_beacon_touch - one loop of the watcher happened, just now.
#
# $$ is the yan process, not a transient subshell: bash reports the shell's own
# pid inside a command substitution, and the owner supervision cares about IS
# the yan process (the same reason lib-lock records $$).
watch_beacon_touch() {
	_watch_mkrun || return $?
	printf '%s %s %s\n' "$(_watch_now)" "$$" "${WATCH_TASK}" >"$WATCH_BEACON"
}

watch_beacon_pid() {
	local line
	_watch_selected || return $?
	[ -f "$WATCH_BEACON" ] || return 1
	line=$(tr -d '\r' <"$WATCH_BEACON" | head -1) || return 1
	line=${line#* }
	line=${line%% *}
	case $line in
	'' | *[!0-9]*) return 1 ;;
	esac
	printf '%s\n' "$line"
}

# watch_beacon_age - seconds since the last loop. Non-zero when unreadable.
watch_beacon_age() {
	local line stamp now
	_watch_selected || return $?
	[ -f "$WATCH_BEACON" ] || return 1
	line=$(tr -d '\r' <"$WATCH_BEACON" | head -1) || return 1
	stamp=${line%% *}
	case $stamp in
	'' | *[!0-9]*) return 1 ;;
	esac
	now=$(_watch_now)
	if [ "$now" -lt "$stamp" ]; then
		# A clock that went backwards is not evidence of staleness.
		printf '0\n'
		return 0
	fi
	printf '%s\n' "$((now - stamp))"
}

# --- is anybody on duty? ----------------------------------------------------

# watch_lock_taken - the single-flight lock exists, its owner is alive, and it
# is a WATCHER's lock.
#
# Deliberately says nothing about the beacon. It is the guard's 800 ms
# question - "was the lock taken while I waited?" - and a watcher that has just
# claimed the lock has not necessarily finished its first loop yet.
watch_lock_taken() {
	local want got
	_watch_selected || return $?
	WATCH_WHY=

	if [ ! -d "$WATCH_LOCK" ]; then
		WATCH_WHY="no single-flight lock at $WATCH_LOCK"
		return 1
	fi
	if ! lock_is_held "$WATCH_LOCK"; then
		WATCH_WHY="the lock at $WATCH_LOCK is there but its owner is gone"
		return 1
	fi
	want=$(watch_identity)
	got=$(tr -d '\r' <"$WATCH_LOCK/identity" 2>/dev/null | head -1) || got=
	if [ "$got" != "$want" ]; then
		WATCH_WHY="the lock at $WATCH_LOCK belongs to '${got:-something unstamped}', not to '$want'"
		return 1
	fi
	return 0
}

# watch_healthy [max-beacon-age] - "the watcher is healthy" (td supervision.md).
#
# ALL of: the lock exists and its pid is alive; the identity matches; the
# beacon is fresh. And the beacon has to belong to the process holding the
# lock, so that neither half can vouch for the other on its own:
#
#   live watcher pid + stale beacon  -> not healthy (it stopped looping)
#   fresh beacon + no/dead/foreign lock -> not healthy (leftover file)
#
watch_healthy() {
	local max=${1:-$YAN_WATCH_BEACON_MAX} age owner bpid
	_watch_selected || return $?

	watch_lock_taken || return 1

	if ! age=$(watch_beacon_age); then
		WATCH_WHY="the watcher holds the lock but has written no beacon at $WATCH_BEACON"
		return 1
	fi
	if [ "$age" -gt "$max" ]; then
		WATCH_WHY="the beacon is ${age}s old (more than ${max}s): a live pid is not proof that it is still looping"
		return 1
	fi

	owner=$(lock_owner_pid "$WATCH_LOCK" 2>/dev/null) || owner=
	bpid=$(watch_beacon_pid) || bpid=
	if [ -n "$owner" ] && [ -n "$bpid" ] && [ "$owner" != "$bpid" ]; then
		WATCH_WHY="the beacon was written by pid $bpid but the lock is held by pid $owner"
		return 1
	fi
	WATCH_WHY=
	return 0
}

# --- the wake file ----------------------------------------------------------

# watch_wake_write <reason> - one reason, appended.
#
# Appended rather than overwritten: two shifts can become interesting between
# one drain and the next, and the second must not erase the first. `yan drain`
# prints the file whole and then clears it.
watch_wake_write() {
	local reason=${1:-}
	if [ -z "$reason" ]; then
		_watch_err "usage: watch_wake_write <reason>"
		return 2
	fi
	_watch_mkrun || return $?
	printf '%s\n' "$reason" >>"$WATCH_WAKE"
}

# watch_wake_has <reason> - is this exact reason already waiting to be drained?
#
# The two level-triggered sources (the agent is gone, the pane has stopped
# moving) stay true until somebody acts on them, so without this a rearmed
# watcher would wake the model again the instant it started, forever. An
# undrained reason means the model has already been told.
#
# Not `grep -q`: under `set -o pipefail` the producer takes SIGPIPE when grep
# stops early and the whole pipeline reports failure despite the match
# (conventions §2).
watch_wake_has() {
	local reason=${1:-} body
	_watch_selected || return $?
	[ -n "$reason" ] || return 1
	[ -f "$WATCH_WAKE" ] || return 1
	body=$(cat -- "$WATCH_WAKE" 2>/dev/null) || return 1
	case $'\n'"$body"$'\n' in
	*$'\n'"$reason"$'\n'*) return 0 ;;
	esac
	return 1
}

# --- the guard's own count --------------------------------------------------

watch_guard_count() {
	local n
	_watch_selected || return $?
	if [ ! -f "$WATCH_GUARD" ]; then
		printf '0\n'
		return 0
	fi
	n=$(tr -dc '0-9' <"$WATCH_GUARD" 2>/dev/null) || n=
	printf '%s\n' "${n:-0}"
}

# watch_guard_bump - count one blocked attempt and print the new total.
watch_guard_bump() {
	local n
	n=$(watch_guard_count) || return $?
	n=$((n + 1))
	_watch_mkrun || return $?
	printf '%s\n' "$n" >"$WATCH_GUARD"
	printf '%s\n' "$n"
}

# watch_guard_reset - the watcher is healthy again, or there is nothing left to
# supervise. Either way the budget starts over.
watch_guard_reset() {
	_watch_selected || return $?
	rm -f -- "$WATCH_GUARD" 2>/dev/null || true
}

# --- what is still being supervised -----------------------------------------

# watch_live_shifts - one line per live shift of the selected task:
#
#     <sid>\t<agent-id>\t<shift-directory>
#
# "Live" is run/ still existing, which is lib-shift's rule and not a second
# copy of it: clocking out deletes run/ whole (td INDEX.md §3). The agent id
# comes from run/meta.json and may be empty - a shift dispatched by an older
# yan, or one whose ids were never recorded, still has a signal file.
#
# Derived by scanning every time it is called, so a shift dispatched while the
# watcher is already looping is picked up on the next loop, and one that clocks
# out drops off it. Note that it moves lib-shift's SHIFT_* globals.
watch_live_shifts() {
	local d dir aid
	_watch_selected || return $?
	dir=$(task_dir "$WATCH_TASK") || return $?
	[ -d "$dir/shifts" ] || return 0

	while IFS= read -r d; do
		[ -n "$d" ] || continue
		shift_resolve_dir "$d" >/dev/null 2>&1 || continue
		shift_is_live || continue
		aid=$(shift_meta_agent_id 2>/dev/null) || aid=
		printf '%s\t%s\t%s\n' "$SHIFT_SID" "$aid" "$SHIFT_DIR"
	done < <(
		shopt -s nullglob
		for d in "$dir"/shifts/*/; do
			if [ -d "$d" ]; then
				printf '%s\n' "${d%/}"
			fi
		done
	)
}

# watch_live_count - how many shifts are still being supervised.
#
# This IS "supervision responsibility": the guard's primary question on Codex,
# and half of it on Claude (td supervision.md).
watch_live_count() {
	local n
	n=$(watch_live_shifts | grep -c . || true)
	n=${n//[!0-9]/}
	printf '%s\n' "${n:-0}"
}
