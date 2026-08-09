# shellcheck shell=bash
#
# Stand-in for bin/lib-term.sh: it RECORDS CALLS AND STARTS NO TERMINAL
# (architecture.md §7).
#
# What it buys: the two things Phase 5 has to prove about the terminal - that
# `yan send` types the text once and can retry the Enter alone, and that
# `yan state` believes the live terminal rather than the last line of
# run/status - are both about the SEQUENCE OF CALLS, not about tmux. Asserting
# a sequence against a real server means a pane, a timing window and a session
# to clean up; asserting it here is exact and runs in any container. The tmux
# side of the same behaviour is covered in tests/integration.
#
# Programming it:
#
#   YAN_STUB_TERM_ALIVE=alive|dead|unknown   what term_agent_alive answers
#   YAN_STUB_TERM_READ="..."                 what term_read prints
#   YAN_STUB_TERM_SEND_RC=1                  make term_send fail
#   YAN_STUB_TERM_BACKEND_RC=1               make every function fail closed,
#                                            the way `backend: herdr` does
#   YAN_STUB_TERM_DIR                        where calls are recorded
#                                            (default ${TMPDIR:-/tmp}/yan-stub-term)
#
# Every call is appended to $YAN_STUB_TERM_DIR/calls, one per line, in lib-term
# vocabulary. Helpers for tests: term_stub_reset, term_stub_calls,
# term_stub_call_count.
#
# It enforces the same "a label is not a source of truth" rule as the real
# library, so a subcommand cannot pass its tests while looking an agent up by
# name.

if [ -n "${_YAN_LIB_TERM_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_TERM_SOURCED=1

_term_err() {
	printf 'lib-term: %s\n' "$1" >&2
}

_term_stub_dir() {
	printf '%s\n' "${YAN_STUB_TERM_DIR:-${TMPDIR:-/tmp}/yan-stub-term}"
}

term_stub_reset() {
	local dir
	dir=$(_term_stub_dir)
	rm -rf -- "$dir"
	mkdir -p -- "$dir"
}

term_stub_calls() {
	local dir
	dir=$(_term_stub_dir)
	if [ -f "$dir/calls" ]; then
		cat -- "$dir/calls"
	fi
}

term_stub_call_count() {
	local n
	n=$(term_stub_calls | grep -c . || true)
	printf '%s\n' "${n:-0}"
}

_term_stub_record() {
	local dir
	dir=$(_term_stub_dir)
	mkdir -p -- "$dir"
	printf '%s\n' "$*" >>"$dir/calls"
}

# The backend gate. `herdr` fails closed in the real library and so does this.
_term_backend() {
	local rc=${YAN_STUB_TERM_BACKEND_RC:-0}
	if [ "$rc" -ne 0 ]; then
		_term_err "backend 'herdr' is not implemented in the MVP - set \"backend\": \"tmux\""
		return "$rc"
	fi
	return 0
}

_term_is_id() {
	local id=${1:-} allowed=${2:-} first rest
	[ -n "$id" ] || return 1
	first=${id%"${id#?}"}
	rest=${id#?}
	case $first in
	["$allowed"]) ;;
	*) return 1 ;;
	esac
	[ -n "$rest" ] || return 1
	case $rest in
	*[!0-9]*) return 1 ;;
	esac
}

_term_need_agent_id() {
	if _term_is_id "${1:-}" '@%'; then
		return 0
	fi
	_term_err "'${1:-}' is not an agent id - pass an id term_agent_start printed (@3 or %7), never a label"
	return 2
}

_term_need_session_id() {
	if _term_is_id "${1:-}" '$'; then
		return 0
	fi
	_term_err "'${1:-}' is not a container id - pass the id term_container_create printed"
	return 2
}

# --- the seven --------------------------------------------------------------

term_container_create() {
	_term_backend || return $?
	if [ -z "${1:-}" ]; then
		_term_err "usage: term_container_create <name>"
		return 2
	fi
	_term_stub_record "container_create name=$1"
	printf '%s\n' "${YAN_STUB_TERM_SESSION:-\$0}"
}

term_agent_start() {
	_term_backend || return $?
	local dir='' envs=()
	while [ $# -gt 0 ]; do
		case ${1:-} in
		-c)
			dir=${2:-}
			shift 2
			;;
		-e)
			envs+=("${2:-}")
			shift 2
			;;
		--)
			shift
			break
			;;
		-*)
			_term_err "unknown option '$1'"
			return 2
			;;
		*) break ;;
		esac
	done
	_term_need_session_id "${1:-}" || return $?
	_term_stub_record "agent_start container=$1 label=${2:-} dir=$dir env=${envs[*]-} cmd=${*:3}"
	printf '%s %s\n' "${YAN_STUB_TERM_WINDOW:-@1}" "${YAN_STUB_TERM_PANE:-%1}"
}

# term_send records the text and the Enter as SEPARATE calls, because they are
# separate calls in the real library and that is exactly what is being tested.
term_send() {
	_term_backend || return $?
	local id=${1:-}
	_term_need_agent_id "$id" || return $?
	shift

	local want_text=1 want_enter=1
	case ${1:-} in
	--enter)
		want_text=0
		shift
		;;
	--no-enter)
		want_enter=0
		shift
		;;
	esac

	if [ "$want_text" -eq 1 ] && [ $# -lt 1 ]; then
		_term_err "usage: term_send <agent-id> [--no-enter] <text> | term_send <agent-id> --enter"
		return 2
	fi

	local rc=${YAN_STUB_TERM_SEND_RC:-0}
	if [ "$want_text" -eq 1 ]; then
		_term_stub_record "send_text id=$id text=$1"
		if [ "$rc" -ne 0 ]; then
			_term_err "stub: term_send was programmed to fail"
			return "$rc"
		fi
	fi
	if [ "$want_enter" -eq 1 ]; then
		_term_stub_record "send_enter id=$id"
		if [ "$rc" -ne 0 ]; then
			_term_err "stub: term_send was programmed to fail"
			return "$rc"
		fi
	fi
	return 0
}

term_read() {
	_term_backend || return $?
	_term_need_agent_id "${1:-}" || return $?
	_term_stub_record "read id=$1 lines=${2:-}"
	printf '%s\n' "${YAN_STUB_TERM_READ:-}"
}

term_agent_alive() {
	_term_backend || return $?
	_term_need_agent_id "${1:-}" || return $?
	_term_stub_record "agent_alive id=$1 expected=${2:-}"
	local v=${YAN_STUB_TERM_ALIVE:-alive}
	case $v in
	alive | dead | unknown) ;;
	*)
		_term_err "stub programmed with '$v', which is not alive|dead|unknown"
		return 2
		;;
	esac
	printf '%s\n' "$v"
}

term_agent_close() {
	_term_backend || return $?
	_term_need_agent_id "${1:-}" || return $?
	_term_stub_record "agent_close id=$1"
}

term_list() {
	_term_backend || return $?
	_term_need_session_id "${1:-}" || return $?
	_term_stub_record "list container=$1"
	printf '%s' "${YAN_STUB_TERM_LIST:-}"
}
