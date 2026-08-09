# shellcheck shell=bash
#
# lib-hook.sh - the calling protocol for conf/hooks/ (td boundaries.md §10,
# architecture.md §4.3).
#
# THIS IS THE ONLY PLACE ALLOWED TO EXECUTE ANYTHING UNDER conf/. Nothing else
# in bin/ may run a file from there. That is the whole reason the seam exists:
# conf/ holds `user`'s local choices, it is gitignored, it is not part of yan,
# and there has to be exactly one door through which yan asks it a question.
#
# The protocol is deliberately asymmetric (boundaries.md §10):
#
#   input   JSON on stdin   so fields can be added later without breaking an
#                           existing hook
#   output  ONE LINE on stdout
#
# A hook is an outside authority, so the three seam rules apply. It reports a
# fact - a name - and decides nothing about what yan then does with it. It
# never writes yan's bookkeeping. And it never calls another seam.
#
# THE THREE OUTCOMES, and why they are three and not two:
#
#   no such hook       NOT an error. It means "no outside authority is
#                      configured here"; the caller falls back to its own
#                      default. hook_call returns HOOK_RC_MISSING (3).
#   hook exits 0       its answer is the last non-empty line of stdout.
#   hook exits non-0   an ERROR. The caller must stop and report. It must
#                      NEVER fall back to the built-in default: after the
#                      team's own tooling has refused, quietly inventing a
#                      branch name that breaks their rules - and may not be
#                      mergeable at all - is much worse than failing outright.
#
# A hook that exits 3 itself is reported as a plain failure (1), because the
# caller must not be able to confuse "you refused" with "you are not there".
#
# The answer is the LAST non-empty line, not the first: boundaries.md §10 lets
# a hook create or register the branch itself "as long as it prints the branch
# name on stdout at the end", so anything the creation step chattered about
# comes before the answer.

if [ -n "${_YAN_LIB_HOOK_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_HOOK_SOURCED=1

# There is no hook of that name. Not an error; the caller decides.
HOOK_RC_MISSING=3

_hook_err() {
	printf 'lib-hook: %s\n' "$1" >&2
}

# hook_dir - the directory hooks live in.
hook_dir() {
	if [ -z "${YAN_HOME:-}" ]; then
		_hook_err "YAN_HOME is not set - run this through bin/yan"
		return 2
	fi
	printf '%s/conf/hooks\n' "$YAN_HOME"
}

# _hook_name_ok <name> - a bare file name, and nothing that can leave conf/.
#
# The seam is the only door into conf/, so it is also the only place that can
# stop a caller from walking out of it. `../../bin/rm-everything` is refused
# here rather than trusted anywhere downstream.
_hook_name_ok() {
	case ${1:-} in
	'' | *[!A-Za-z0-9._-]*)
		_hook_err "invalid hook name: '${1:-}' - use letters, digits, dot, dash or underscore"
		return 2
		;;
	.*)
		_hook_err "invalid hook name: '${1:-}' - a hook name may not start with a dot"
		return 2
		;;
	esac
}

# hook_path <name> - where that hook would be. Prints the path whether or not
# the file exists; hook_exists answers the other question.
hook_path() {
	local dir
	_hook_name_ok "${1:-}" || return $?
	dir=$(hook_dir) || return $?
	printf '%s/%s\n' "$dir" "$1"
}

# hook_exists <name> - zero when a hook of that name is installed.
hook_exists() {
	local p
	p=$(hook_path "${1:-}" 2>/dev/null) || return 1
	[ -f "$p" ]
}

# hook_call <name> <json>
#
# Runs the hook with <json> on stdin and prints its one-line answer.
#
#   0                  answered; the line is on stdout
#   HOOK_RC_MISSING(3) no such hook - not an error, the caller decides
#   1                  the hook failed, or answered with nothing
#   2                  called wrongly
#
# The hook's stderr is deliberately NOT captured: whatever it wants to say
# about a refusal should reach `user` unedited.
hook_call() {
	local name=${1:-} json=${2-} path out rc=0 line answer=''

	if [ $# -lt 2 ]; then
		_hook_err "usage: hook_call <name> <json>"
		return 2
	fi
	path=$(hook_path "$name") || return $?

	if [ ! -f "$path" ]; then
		return "$HOOK_RC_MISSING"
	fi

	# Executable bit: on this checkout core.filemode is false and conf/ is
	# gitignored, so a hook copied in by hand on Windows routinely has no
	# executable bit at all. Running it through bash then is not a fallback
	# for a broken hook, it is the normal Windows case - and a hook that IS
	# executable is still run directly, so a Python or Node hook works.
	# A here-string, never `printf ... | hook`. Under `set -o pipefail` a hook
	# that does not bother to read its stdin kills the producer with SIGPIPE,
	# and the pipeline then reports 141 even though the hook itself succeeded.
	if [ -x "$path" ]; then
		out=$("$path" <<<"$json") || rc=$?
	else
		out=$(bash "$path" <<<"$json") || rc=$?
	fi

	if [ "$rc" -ne 0 ]; then
		_hook_err "the '$name' hook refused (exit $rc) - stop and fix the hook, or the input it was given; yan will not guess a value it was told not to choose"
		return 1
	fi

	# The last non-empty line, with the CR a hook written on Windows leaves
	# behind and any surrounding blanks removed.
	while IFS= read -r line; do
		line=${line%$'\r'}
		line=${line#"${line%%[![:space:]]*}"}
		line=${line%"${line##*[![:space:]]}"}
		if [ -n "$line" ]; then
			answer=$line
		fi
	done <<<"$out"

	if [ -z "$answer" ]; then
		_hook_err "the '$name' hook exited 0 but printed nothing - it must print its answer as one line on stdout"
		return 1
	fi

	printf '%s\n' "$answer"
}
