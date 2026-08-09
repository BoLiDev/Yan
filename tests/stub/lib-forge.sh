# shellcheck shell=bash
#
# Stand-in for bin/lib-forge.sh, selected by pointing YAN_LIB at this directory.
#
# It REPLAYS A FIXED SEQUENCE OF MR STATES (architecture.md §7). That is the
# whole point: the interesting behaviour in Phases 6, 7 and 9 is what a caller
# does as an MR moves open -> open -> merged, and reproducing that against a
# real forge is neither fast nor repeatable.
#
# Programming it - either form, env var wins over file:
#
#   YAN_STUB_FORGE_MR_STATES="open open merged"     # space, comma or newline
#   YAN_STUB_FORGE_MR_STATES_FILE=/path/to/states   # one per line
#   YAN_STUB_FORGE_CI_STATES="pending red green"
#   YAN_STUB_FORGE_CI_STATES_FILE=/path/to/states
#
# Successive calls consume successive entries. Past the end of the sequence the
# LAST value repeats, because a poll loop that has seen `merged` keeps seeing
# `merged`. Set YAN_STUB_FORGE_EXHAUSTED=unknown to get `unknown` / `pending`
# instead, which is how you test the "forge stopped answering" path.
#
# The cursor lives in a file, not a shell variable, because yan subcommands are
# separate processes and the sequence has to survive across them:
#
#   YAN_STUB_FORGE_DIR   default ${TMPDIR:-/tmp}/yan-stub-forge
#
# Every call is appended to $YAN_STUB_FORGE_DIR/calls in yan vocabulary, so a
# test can assert what the subcommand asked for. Nothing here touches the
# network, and nothing here writes under $YAN_HOME.
#
# Other knobs:
#   YAN_STUB_FORGE_MR_URL     what forge_mr_create prints
#   YAN_STUB_FORGE_CREATE_RC  exit status of forge_mr_create   (default 0)
#   YAN_STUB_FORGE_MERGE_RC   exit status of forge_mr_merge    (default 0)
#
# Helpers for tests: forge_stub_reset, forge_stub_calls, forge_stub_call_count.
#
# The stub accepts exactly the flags the real library accepts and refuses
# everything else, so a subcommand cannot pass its tests while depending on a
# gh or glab flag.

if [ -n "${_YAN_LIB_FORGE_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_FORGE_SOURCED=1

_forge_err() {
	printf 'lib-forge: %s\n' "$1" >&2
}

_forge_stub_dir() {
	printf '%s\n' "${YAN_STUB_FORGE_DIR:-${TMPDIR:-/tmp}/yan-stub-forge}"
}

forge_stub_reset() {
	local dir
	dir=$(_forge_stub_dir)
	rm -rf -- "$dir"
	mkdir -p -- "$dir"
}

forge_stub_calls() {
	local dir
	dir=$(_forge_stub_dir)
	if [ -f "$dir/calls" ]; then
		cat -- "$dir/calls"
	fi
}

forge_stub_call_count() {
	local n
	n=$(forge_stub_calls | grep -c . || true)
	printf '%s\n' "${n:-0}"
}

_forge_stub_record() {
	local dir
	dir=$(_forge_stub_dir)
	mkdir -p -- "$dir"
	printf '%s\n' "$*" >>"$dir/calls"
}

# _forge_stub_sequence <MR|CI> - the programmed sequence, one entry per line.
_forge_stub_sequence() {
	local raw='' file=''
	case $1 in
	MR)
		raw=${YAN_STUB_FORGE_MR_STATES:-}
		file=${YAN_STUB_FORGE_MR_STATES_FILE:-}
		;;
	*)
		raw=${YAN_STUB_FORGE_CI_STATES:-}
		file=${YAN_STUB_FORGE_CI_STATES_FILE:-}
		;;
	esac

	# tr also drops carriage returns: a states file written on Windows, or an
	# env var pasted from one, must not turn `merged` into `merged\r` and then
	# fail a closed-set comparison for no visible reason.
	if [ -n "$raw" ]; then
		printf '%s\n' "$raw" | tr -d '\r' | tr ', \t' '\n\n\n\n' | grep -v '^$' || true
		return 0
	fi
	if [ -n "$file" ] && [ -f "$file" ]; then
		tr -d '\r' <"$file" | grep -v '^$' || true
		return 0
	fi
}

# _forge_stub_next <MR|CI> <default> - consume one entry.
_forge_stub_next() {
	local kind=$1 fallback=$2 dir cursor n value line
	local seq=()
	dir=$(_forge_stub_dir)
	mkdir -p -- "$dir"

	while IFS= read -r line; do
		if [ -n "$line" ]; then
			seq+=("$line")
		fi
	done < <(_forge_stub_sequence "$kind")

	if [ "${#seq[@]}" -eq 0 ]; then
		printf '%s\n' "$fallback"
		return 0
	fi

	cursor="$dir/$kind.cursor"
	n=0
	if [ -f "$cursor" ]; then
		n=$(cat -- "$cursor")
		n=${n//$'\r'/}
	fi
	case $n in
	'' | *[!0-9]*) n=0 ;;
	esac

	if [ "$n" -ge "${#seq[@]}" ]; then
		if [ "${YAN_STUB_FORGE_EXHAUSTED:-sticky}" = sticky ]; then
			value=${seq[$((${#seq[@]} - 1))]}
		else
			value=$3
		fi
	else
		value=${seq[$n]}
		printf '%s\n' "$((n + 1))" >"$cursor"
	fi
	printf '%s\n' "$value"
}

# The stub enforces the closed sets too - programming it with a fifth value is
# a bug in the test, and it says so instead of quietly answering something
# plausible.
_forge_stub_check_mr_state() {
	case $1 in
	merged | closed | open | unknown) ;;
	*)
		_forge_err "stub programmed with '$1', which is not merged|closed|open|unknown - fix YAN_STUB_FORGE_MR_STATES"
		return 2
		;;
	esac
}

_forge_stub_check_ci_state() {
	case $1 in
	green | red | pending | none) ;;
	*)
		_forge_err "stub programmed with '$1', which is not green|red|pending|none - fix YAN_STUB_FORGE_CI_STATES"
		return 2
		;;
	esac
}

# --- the same flag vocabulary as the real library --------------------------

_forge_repo=
_forge_dir=
_forge_mr=
_forge_source=
_forge_target=
_forge_title=
_forge_body=
_forge_body_file=
_forge_draft=0
_forge_strategy=merge
_forge_delete_source=0
_forge_allow=

_forge_allowed() {
	case " $_forge_allow " in
	*" $1 "*) return 0 ;;
	esac
	_forge_err "--$1 is not accepted here - see the verb's flag list in lib-forge.sh"
	return 2
}

_forge_begin() {
	_forge_repo=
	_forge_dir=
	_forge_mr=
	_forge_source=
	_forge_target=
	_forge_title=
	_forge_body=
	_forge_body_file=
	_forge_draft=0
	_forge_strategy=merge
	_forge_delete_source=0
	_forge_allow=$1
	shift

	while [ $# -gt 0 ]; do
		case $1 in
		--draft)
			_forge_allowed draft || return 2
			_forge_draft=1
			shift
			;;
		--delete-source)
			_forge_allowed delete-source || return 2
			_forge_delete_source=1
			shift
			;;
		--repo | --dir | --mr | --source | --target | --title | --body | --body-file | --strategy)
			_forge_allowed "${1#--}" || return 2
			if [ $# -lt 2 ]; then
				_forge_err "$1 needs a value"
				return 2
			fi
			case ${1#--} in
			repo) _forge_repo=${2//$'\r'/} ;;
			dir) _forge_dir=${2//$'\r'/} ;;
			mr) _forge_mr=${2//$'\r'/} ;;
			source) _forge_source=${2//$'\r'/} ;;
			target) _forge_target=${2//$'\r'/} ;;
			title) _forge_title=$2 ;;
			body) _forge_body=$2 ;;
			body-file) _forge_body_file=$2 ;;
			strategy) _forge_strategy=${2//$'\r'/} ;;
			esac
			shift 2
			;;
		*)
			_forge_err "unknown option: $1 - forge verbs take yan's own flags only, never gh's or glab's"
			return 2
			;;
		esac
	done
}

# --- the four verbs --------------------------------------------------------

forge_mr_create() {
	_forge_begin "repo dir source target title body body-file draft" "$@" || return $?
	if [ -z "$_forge_source" ] || [ -z "$_forge_target" ] || [ -z "$_forge_title" ]; then
		_forge_err "--source, --target and --title are required"
		return 2
	fi
	_forge_stub_record "mr_create source=$_forge_source target=$_forge_target draft=$_forge_draft"

	local rc=${YAN_STUB_FORGE_CREATE_RC:-0}
	if [ "$rc" -ne 0 ]; then
		_forge_err "stub: forge_mr_create was programmed to fail"
		return "$rc"
	fi
	printf '%s\n' "${YAN_STUB_FORGE_MR_URL:-https://forge.invalid/acme/widget/-/merge_requests/1}"
}

forge_mr_state() {
	_forge_begin "repo dir mr" "$@" || return $?
	if [ -z "$_forge_mr" ]; then
		_forge_err "--mr is required"
		return 2
	fi
	_forge_stub_record "mr_state mr=$_forge_mr"

	local v
	v=$(_forge_stub_next MR open unknown)
	_forge_stub_check_mr_state "$v" || return 2
	printf '%s\n' "$v"
}

forge_mr_merge() {
	_forge_begin "repo dir mr strategy delete-source" "$@" || return $?
	if [ -z "$_forge_mr" ]; then
		_forge_err "--mr is required"
		return 2
	fi
	case $_forge_strategy in
	merge | squash | rebase) ;;
	*)
		_forge_err "unknown merge strategy '$_forge_strategy' - use merge, squash or rebase"
		return 2
		;;
	esac
	_forge_stub_record "mr_merge mr=$_forge_mr strategy=$_forge_strategy delete_source=$_forge_delete_source"

	local rc=${YAN_STUB_FORGE_MERGE_RC:-0}
	if [ "$rc" -ne 0 ]; then
		_forge_err "stub: forge_mr_merge was programmed to fail"
		return "$rc"
	fi
}

forge_ci_state() {
	_forge_begin "repo dir mr" "$@" || return $?
	if [ -z "$_forge_mr" ]; then
		_forge_err "--mr is required"
		return 2
	fi
	_forge_stub_record "ci_state mr=$_forge_mr"

	local v
	v=$(_forge_stub_next CI green pending)
	_forge_stub_check_ci_state "$v" || return 2
	printf '%s\n' "$v"
}
