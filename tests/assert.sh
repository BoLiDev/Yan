# shellcheck shell=bash
#
# tests/assert.sh - shared assertion helpers.
#
# A failing assertion prints the expectation, what it actually got, and the
# file and line of the CALLER, then exits 1. Tests are therefore fail-fast:
# the first broken expectation ends the file, and tests/run.sh reports it.

if [ -n "${_YAN_TEST_ASSERT_SOURCED:-}" ]; then
	return 0
fi
_YAN_TEST_ASSERT_SOURCED=1

YAN_TEST_DIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
YAN_REPO_ROOT=$(dirname "$YAN_TEST_DIR")
export YAN_TEST_DIR YAN_REPO_ROOT

# _assert_die <headline> [detail-lines...]
# Frame 2 is the test file, because this is always called from an assert_*.
_assert_die() {
	local src=${BASH_SOURCE[2]:-?} line=${BASH_LINENO[1]:-?} head=$1
	shift
	printf 'assertion failed at %s:%s\n  %s\n' "$src" "$line" "$head" >&2
	local l
	for l in "$@"; do
		printf '  %s\n' "$l" >&2
	done
	exit 1
}

assert_eq() { # <expected> <actual> [message]
	if [ "${1-}" != "${2-}" ]; then
		_assert_die "${3:-values differ}" "expected: ${1-}" "actual:   ${2-}"
	fi
}

assert_ne() { # <unexpected> <actual> [message]
	if [ "${1-}" = "${2-}" ]; then
		_assert_die "${3:-values should differ}" "both were: ${1-}"
	fi
}

assert_contains() { # <haystack> <needle> [message]
	case "${1-}" in
	*"${2-}"*) ;;
	*) _assert_die "${3:-substring not found}" "needle:   ${2-}" "haystack: ${1-}" ;;
	esac
}

assert_not_contains() { # <haystack> <needle> [message]
	case "${1-}" in
	*"${2-}"*) _assert_die "${3:-substring should be absent}" "needle:   ${2-}" "haystack: ${1-}" ;;
	*) ;;
	esac
}

assert_ok() { # <command...>
	local out rc=0
	out=$("$@" 2>&1) || rc=$?
	if [ "$rc" -ne 0 ]; then
		_assert_die "expected success from: $*" "exit code: $rc" "output:    $out"
	fi
}

assert_fail() { # <command...>
	local out rc=0
	out=$("$@" 2>&1) || rc=$?
	if [ "$rc" -eq 0 ]; then
		_assert_die "expected failure from: $*" "exit code: 0" "output:    $out"
	fi
}

assert_exit_code() { # <expected-code> <command...>
	local want=$1
	shift
	local out rc=0
	out=$("$@" 2>&1) || rc=$?
	if [ "$rc" -ne "$want" ]; then
		_assert_die "wrong exit code from: $*" "expected: $want" "actual:   $rc" "output:   $out"
	fi
}

assert_file_exists() { # <path> [message]
	if [ ! -e "${1-}" ]; then
		_assert_die "${2:-file should exist}" "path: ${1-}"
	fi
}

assert_file_missing() { # <path> [message]
	if [ -e "${1-}" ]; then
		_assert_die "${2:-file should not exist}" "path: ${1-}"
	fi
}

# Convenience: capture stdout+stderr and the exit code of a command without
# tripping `set -e`. Sets the globals `out` and `rc`.
out=
rc=0
capture() {
	rc=0
	out=$("$@" 2>&1) || rc=$?
	return 0
}

# native_path <path> - the spelling a NATIVE tool prints for this path.
#
# On Git Bash the shell says /tmp/x while git.exe says C:/Users/.../Temp/x.
# Both name the same file, so any test that compares a path it built against a
# path a native tool printed has to normalise first. On Linux this is the
# identity function. Later phases comparing worktree paths need the same care.
native_path() {
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m -- "${1-}"
	else
		printf '%s\n' "${1-}"
	fi
}
