# shellcheck shell=bash
#
# lib-lock.sh - the one locking primitive in yan.
#
# Why mkdir and not flock: yan has to run on Git Bash (MSYS2) as well as on
# Linux, and Git Bash ships no flock(1). `noclobber` redirection is not a
# portable substitute either - it is not atomic over every filesystem MSYS2
# exposes. `mkdir` is: on both platforms it either creates the directory or
# fails because it already exists, in one syscall. So the lock IS a directory.
#
#   <lockdir>/          the lock itself, created atomically
#   <lockdir>/pid       the owning process id
#   <lockdir>/at        unix seconds when it was taken
#   <lockdir>/host      hostname, so a shared filesystem cannot be misread
#
# Stale locks: a holder that died leaves the directory behind. `kill -0 <pid>`
# is the liveness test on both platforms - under MSYS2 it answers about MSYS
# pids, which is what we wrote, because the writer was an MSYS process too.
# A lock whose pid is gone (and whose host matches ours) is reclaimable.
#
# Callers: the worktree pool (Phase 2) and supervision's single-flight
# (Phase 8). Nothing else should invent a second locking scheme.

if [ -n "${_YAN_LIB_LOCK_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_LOCK_SOURCED=1

_lock_err() {
	printf 'lib-lock: %s\n' "$1" >&2
}

_lock_host() {
	if [ -n "${HOSTNAME:-}" ]; then
		printf '%s\n' "$HOSTNAME"
	elif command -v hostname >/dev/null 2>&1; then
		hostname
	else
		printf 'unknown\n'
	fi
}

_lock_now() {
	date +%s
}

# _lock_pid_alive <pid> - zero when that process still exists.
#
# `kill -0` is the portable answer. It reports success for a live process we
# may not signal (EPERM), which is the conservative direction: we would rather
# leave a lock alone than steal one that is still held.
_lock_pid_alive() {
	local pid=${1:-}
	case $pid in
	'' | *[!0-9]*) return 1 ;;
	esac
	kill -0 "$pid" 2>/dev/null
}

# lock_owner_pid <lockdir> - print the recorded pid, empty when unreadable.
lock_owner_pid() {
	local lockdir=${1:-}
	[ -n "$lockdir" ] || return 1
	[ -f "$lockdir/pid" ] || return 1
	tr -d ' \t\r\n' <"$lockdir/pid"
}

# lock_is_held <lockdir>
#
# Zero when the lock exists AND its owner is still alive. A lock left behind by
# a dead process is reported as not held, because that is what a caller means
# by the question.
lock_is_held() {
	local lockdir=${1:-} pid
	if [ -z "$lockdir" ]; then
		_lock_err "usage: lock_is_held <lockdir>"
		return 2
	fi
	[ -d "$lockdir" ] || return 1
	pid=$(lock_owner_pid "$lockdir" 2>/dev/null) || return 0
	if [ -z "$pid" ]; then
		# Present but not yet stamped: a competitor is mid-acquire. Held.
		return 0
	fi
	_lock_pid_alive "$pid"
}

# lock_is_stale <lockdir> - zero when the directory exists but nobody owns it.
lock_is_stale() {
	local lockdir=${1:-} pid host
	if [ -z "$lockdir" ]; then
		_lock_err "usage: lock_is_stale <lockdir>"
		return 2
	fi
	[ -d "$lockdir" ] || return 1

	pid=$(lock_owner_pid "$lockdir" 2>/dev/null) || pid=
	# No pid stamp yet. Either a competitor is between its mkdir and its stamp
	# - microseconds, and stealing the lock there is exactly the race this
	# library exists to prevent - or the acquirer died in that window and the
	# directory is now old. Age decides, and the answer is "not stale" while
	# the age is unknown.
	if [ -z "$pid" ]; then
		find "$lockdir" -maxdepth 0 -mmin +1 2>/dev/null | grep -q . || return 1
		return 0
	fi

	# Only reclaim locks taken on this machine: a pid from another host means
	# nothing here.
	host=$(cat "$lockdir/host" 2>/dev/null) || host=
	if [ -n "$host" ] && [ "$host" != "$(_lock_host)" ]; then
		return 1
	fi

	! _lock_pid_alive "$pid"
}

# lock_acquire <lockdir> [timeout_seconds]
#
# mkdir is the atomic step: exactly one of N concurrent callers can create the
# directory, and every other one loops. Default timeout 0 = try once.
lock_acquire() {
	local lockdir=${1:-} timeout=${2:-0}
	if [ -z "$lockdir" ]; then
		_lock_err "usage: lock_acquire <lockdir> [timeout_seconds]"
		return 2
	fi
	case $timeout in
	'' | *[!0-9]*)
		_lock_err "timeout must be a whole number of seconds, got: $timeout"
		return 2
		;;
	esac

	local parent deadline now
	parent=$(dirname -- "$lockdir")
	if ! mkdir -p -- "$parent"; then
		_lock_err "cannot create the directory holding the lock: $parent"
		return 1
	fi

	deadline=$(($(_lock_now) + timeout))
	while :; do
		if mkdir -- "$lockdir" 2>/dev/null; then
			printf '%s\n' "$$" >"$lockdir/pid"
			_lock_now >"$lockdir/at"
			_lock_host >"$lockdir/host"
			return 0
		fi

		# Someone holds it - unless they are dead, in which case take it over.
		if lock_is_stale "$lockdir"; then
			_lock_force_release "$lockdir"
			continue
		fi

		now=$(_lock_now)
		if [ "$now" -ge "$deadline" ]; then
			local pid
			pid=$(lock_owner_pid "$lockdir" 2>/dev/null) || pid='?'
			_lock_err "timed out after ${timeout}s waiting for $lockdir (held by pid ${pid:-?})"
			return 1
		fi
		sleep 0.2 2>/dev/null || sleep 1
	done
}

# _lock_force_release <lockdir> - remove without an ownership check. Internal;
# only the stale path may call it.
_lock_force_release() {
	rm -rf -- "${1:?}"
}

# lock_release <lockdir>
#
# Releases only a lock this process owns. Releasing someone else's lock is the
# classic way a lock silently stops working, so it is refused.
lock_release() {
	local lockdir=${1:-} pid
	if [ -z "$lockdir" ]; then
		_lock_err "usage: lock_release <lockdir>"
		return 2
	fi
	if [ ! -d "$lockdir" ]; then
		return 0
	fi

	pid=$(lock_owner_pid "$lockdir" 2>/dev/null) || pid=
	if [ -n "$pid" ] && [ "$pid" != "$$" ]; then
		if _lock_pid_alive "$pid"; then
			_lock_err "refusing to release $lockdir: it is held by pid $pid, not $$"
			return 1
		fi
		_lock_err "reclaiming $lockdir from dead pid $pid"
	fi
	_lock_force_release "$lockdir"
}

# with_lock <lockdir> <timeout> <command...>
#
# Runs the command under the lock and always releases it, including when the
# command fails or is interrupted. The command's exit code is passed through.
with_lock() {
	local lockdir=${1:-} timeout=${2:-}
	if [ $# -lt 3 ] || [ -z "$lockdir" ]; then
		_lock_err "usage: with_lock <lockdir> <timeout_seconds> <command...>"
		return 2
	fi
	shift 2

	lock_acquire "$lockdir" "$timeout" || return $?

	# The trap covers INT/TERM as well as the normal path: a lock that outlives
	# a Ctrl-C would block the pool until the stale check notices.
	local rc=0
	trap 'lock_release "$lockdir" >/dev/null 2>&1; trap - INT TERM; kill -INT $$' INT TERM
	"$@" || rc=$?
	trap - INT TERM
	lock_release "$lockdir" || true
	return "$rc"
}
