# shellcheck shell=bash
#
# lib-log.sh - append one line to tasks/<id>/log.md (architecture.md §4.2).
#
# This module is deliberately tiny, and that is the point. It is not hiding
# complexity; it exists so that ONE invariant has exactly one enforcement
# point:
#
#   log.md is APPEND-ONLY. An existing line is never rewritten and never
#   removed.
#
# The API is the enforcement. There is no log_set, no log_replace, no
# log_delete, no line index anywhere in this file - the only write operation
# is `>>`. A caller cannot rewrite a line through this library because no such
# function exists to call.
#
# Because it only ever appends, log.md never produces a merge conflict
# (td memory.md §4.2): two writers add different last lines and git takes
# both, whereas a rewritten line is exactly what a conflict is made of. That
# property is the reason the narrative layer is a log and not a document.
#
# Shape of one entry, td memory.md §4.2:
#
#   # t042 unify the auth header
#
#   - 08-04  s1 auth       parse the header   → !31 merged into the integration branch
#
# One line per event. The date is MM-DD; the year is not carried because the
# task directory's own lifetime already bounds it and the line has to stay
# short enough that nobody skips writing it.

if [ -n "${_YAN_LIB_LOG_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_LOG_SOURCED=1

_log_err() {
	printf 'lib-log: %s\n' "$1" >&2
}

_log_home() {
	if [ -z "${YAN_HOME:-}" ]; then
		_log_err "YAN_HOME is not set - run this through bin/yan"
		return 2
	fi
	printf '%s' "$YAN_HOME"
}

# log_file <id> - absolute path of a task's log.md.
log_file() {
	local id=${1:-} home
	if [ -z "$id" ]; then
		_log_err "usage: log_file <task-id>"
		return 2
	fi
	home=$(_log_home) || return $?
	printf '%s/tasks/%s/log.md\n' "$home" "$id"
}

# log_init <id> [title]
#
# Creates log.md with its `# <id> <title>` heading when it is absent. An
# existing file is never touched - not even its heading - because rewriting
# the first line is still rewriting a line.
log_init() {
	local id=${1:-} title=${2-} file
	if [ -z "$id" ]; then
		_log_err "usage: log_init <task-id> [title]"
		return 2
	fi
	file=$(log_file "$id") || return $?
	if [ -e "$file" ]; then
		return 0
	fi
	if ! mkdir -p -- "$(dirname -- "$file")"; then
		_log_err "cannot create the task directory for $id"
		return 1
	fi
	if [ -n "$title" ]; then
		printf '# %s %s\n\n' "$id" "$title" >"$file"
	else
		printf '# %s\n\n' "$id" >"$file"
	fi
}

# log_append <id> <text> [date]
#
# The only write in this library. `date` defaults to today as MM-DD and is
# accepted only so tests and back-fills are deterministic; it can never point
# at an existing line.
log_append() {
	local id=${1:-} text=${2-} when=${3-} file
	if [ -z "$id" ] || [ -z "$text" ]; then
		_log_err "usage: log_append <task-id> <text> [MM-DD]"
		return 2
	fi
	case $text in
	*$'\n'*)
		_log_err "a log entry is one line - write several entries instead"
		return 2
		;;
	esac

	file=$(log_file "$id") || return $?
	log_init "$id" || return $?

	if [ -z "$when" ]; then
		when=$(date +%m-%d)
	fi

	printf -- '- %s  %s\n' "$when" "$text" >>"$file"
}
