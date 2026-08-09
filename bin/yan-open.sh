#!/usr/bin/env bash
#
# yan open <id> [--artifacts] - open a task directory, or its artifacts/.
#
# artifacts/ is where a shift writes the things a PERSON looks at - prototype
# pages, screenshots, research data - because they belong to the project but
# not to the work repository, and the leased worktree gets wiped
# (td memory.md §4.3). There is no index: the directory listing and the file
# names are enough, so opening the directory is the whole feature.
#
# The absolute path is ALWAYS printed, and on a machine with no graphical
# opener that is the entire result and a perfectly good one. Printing the path
# is never treated as a failure: this command exits 0 whenever the directory
# it was asked for exists.
#
# The opener can be overridden with $YAN_OPENER (a command that takes one
# path). That is how the tests exercise both branches without a desktop.
#
set -euo pipefail

: "${YAN_HOME:?yan-open: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"

die() {
	printf 'open: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan open <task-id> [--artifacts]

  <id>          open tasks/<id>/
  --artifacts   open tasks/<id>/artifacts/ instead

The absolute path is always printed. When no opener is available on this
machine, printing it is the result - that is success, not a failure.
EOF
}

id=
artifacts=0

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--artifacts)
		artifacts=1
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

[ -n "$id" ] || {
	usage >&2
	die "a task id is required" 2
}

task_exists "$id" || die "no such task: $id"

dir=$(task_dir "$id")
if [ "$artifacts" -eq 1 ]; then
	dir=$dir/artifacts
	# yan may tidy artifacts/ but never changes what is in it (td Appendix B).
	# Creating the directory so there is something to open is tidying.
	mkdir -p -- "$dir" || die "cannot create $dir"
fi

[ -d "$dir" ] || die "not a directory: $dir"

printf '%s\n' "$dir"

# open_with <command...> - run an opener, and never let its exit code decide
# this command's. explorer.exe in particular returns 1 even when it succeeded.
open_with() {
	"$@" >/dev/null 2>&1 || true
	exit 0
}

if [ -n "${YAN_OPENER:-}" ]; then
	open_with "$YAN_OPENER" "$dir"
fi

case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS* | CYGWIN*)
	# Git Bash: hand explorer.exe the Windows spelling of the path.
	win=$dir
	if command -v cygpath >/dev/null 2>&1; then
		win=$(cygpath -w -- "$dir")
	fi
	if command -v explorer.exe >/dev/null 2>&1; then
		open_with explorer.exe "$win"
	fi
	if command -v start >/dev/null 2>&1; then
		open_with start "$win"
	fi
	;;
*)
	# WSL has xdg-open only sometimes; wslview and explorer.exe are the usual
	# stand-ins, and a plain container has none of them.
	for opener in xdg-open wslview explorer.exe; do
		if command -v "$opener" >/dev/null 2>&1; then
			open_with "$opener" "$dir"
		fi
	done
	;;
esac

# Nothing to open with. The path above is the answer.
exit 0
