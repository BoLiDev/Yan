#!/usr/bin/env bash
#
# yan drain - read the wake file and clear it (td supervision.md).
#
# The first thing the model does after being woken. `yan wait` exits when
# something actionable happened and writes the reason down; the wake file is
# what carries that reason across the gap between "wait exited" and "the
# model's next turn", because nothing else survives it.
#
# READ FIRST, CLEAR SECOND. The order is the whole design of this command: a
# crash between the two leaves the reason on disk and the next drain picks it
# up again, whereas clearing first and crashing loses it for good. Repeating a
# wake is free; losing one means a shift waits for a yan that is never coming.
#
# An empty drain is normal and silent, and exits 0. Codex's checkpoint loop
# drains after a quiet timeout too (td supervision.md), so "nothing to report"
# must not look like a failure.
#
# WHOSE WAKE FILE. Supervision is per-yan and a yan is per-task (td §5.2), so
# the file belongs to the task, not to any one shift: tasks/<id>/run/wake,
# beside the guard's own tasks/<id>/run/guard-failures (architecture.md §6).
# Phase 8 owns `yan wait`, which is the writer; if it settles on another path,
# this is the one place to change, and $YAN_WAKE_FILE overrides it meanwhile.
#
set -euo pipefail

: "${YAN_HOME:?yan-drain: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"

die() {
	printf 'drain: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan drain [<task-id>] [--peek]

  <task-id>  defaults to $YAN_TASK; $YAN_WAKE_FILE overrides the path entirely
  --peek     print the reason without clearing it

Prints nothing and exits 0 when there is nothing to drain.
EOF
}

id=
peek=0

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--peek)
		peek=1
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

wake=${YAN_WAKE_FILE:-}
if [ -z "$wake" ]; then
	if [ -z "$id" ]; then
		id=${YAN_TASK:-}
	fi
	if [ -z "$id" ]; then
		usage >&2
		die "cannot tell whose wake file to drain - pass a task id, or set \$YAN_TASK as the task container does" 2
	fi
	dir=$(task_dir "$id") || exit $?
	wake=$dir/run/wake
fi

[ -f "$wake" ] || exit 0

# Read into memory before anything is removed.
reason=$(cat -- "$wake") || die "cannot read the wake file: $wake" 1

if [ -n "$reason" ]; then
	printf '%s\n' "$reason"
fi

if [ "$peek" -eq 1 ]; then
	exit 0
fi

rm -f -- "$wake" || die "the reason was printed but the wake file could not be cleared: $wake" 1
