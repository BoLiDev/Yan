# shellcheck shell=bash
#
# lib-task.sh - reading and writing tasks/<id>/task.json (architecture.md §4.2).
#
# Thin on purpose. Like lib-log.sh it is not hiding complexity; it exists so
# that a handful of invariants have exactly one enforcement point instead of
# being re-implemented at twenty call sites.
#
# The invariants:
#
#   1. `history[]` is APPEND-ONLY. Once an entry is written it is never
#      modified and never removed. The API is the enforcement: the only
#      history writer builds `old + [entry]`, and there is no function
#      anywhere in this file that takes a history index.
#
#   2. The four current scalars - branch / target / mode / mr - are stored as
#      fields of the unit, SEPARATE from the history. "Current is the last
#      element of history[]" is explicitly rejected by td branching.md §6.4:
#      the current state is read constantly, and append-only is a much cleaner
#      rule when nothing else is mixed into it.
#
#   3. A history entry has at most five fields - branch, target, at, end and
#      an optional mr - and `end` is only ever `delivered` or `abandoned`
#      (td branching.md §6.4). Anything else is refused.
#
#   4. One completion flag per task, because "user has declared this task
#      finished" is a decision and therefore the single thing about a task
#      that cannot be derived (td agents.md §5.1). Everything else - whether a
#      shift is running, whether an MR merged - is looked up, never mirrored.
#
#   5. Every write goes through lib-json.sh, so it lands tmp -> mv and carries
#      a version field. This file never redirects into a .json.
#
# The shape of a unit is td branching.md §6.4:
#
#   { name, repo, scope: [], needs: [],
#     branch, target, mode, mr,
#     history: [ { branch, target, at, end, mr? } ] }
#
# What this file does NOT do: `yan unit add` and `yan unit set` are
# subcommands and belong to Phase 6. What lives here is only the storage they
# will call.

if [ -n "${_YAN_LIB_TASK_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_TASK_SOURCED=1

# shellcheck source=bin/lib-json.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-json.sh"
# shellcheck source=bin/lib-log.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-log.sh"

# The one lateral edge in this file: task_init creates the whole minimal task
# directory, and log.md's heading format belongs to lib-log.sh. Duplicating
# the heading here would give that format two owners. lib-log never calls back
# into lib-task, so the dependency stays acyclic and both remain below the
# subcommand layer (architecture.md §2 forbids edges between SEAMS; these two
# are storage, not seams).

TASK_MODES='scout branch mr'
TASK_ENDS='delivered abandoned'

_task_err() {
	printf 'lib-task: %s\n' "$1" >&2
}

_task_home() {
	if [ -z "${YAN_HOME:-}" ]; then
		_task_err "YAN_HOME is not set - run this through bin/yan"
		return 2
	fi
	printf '%s' "$YAN_HOME"
}

_task_id_ok() { # <id>
	case ${1:-} in
	'' | *[!A-Za-z0-9._-]*)
		_task_err "invalid task id: '${1:-}' - use letters, digits, dot, dash or underscore"
		return 2
		;;
	esac
}

# _task_json_array <items...> - a compact JSON array of strings.
_task_json_array() {
	if [ $# -eq 0 ]; then
		printf '[]\n'
		return 0
	fi
	printf '%s\n' "$@" | jq -Rnc '[inputs]'
}

_task_in_set() { # <value> <space separated set>
	local v=${1-} w
	for w in $2; do
		if [ "$v" = "$w" ]; then
			return 0
		fi
	done
	return 1
}

# _task_emit <jq args...> - run jq and hand back LF-only output.
#
# Portability, and not a cosmetic one: jq.exe on Git Bash opens stdout in text
# mode and terminates every line with CRLF. A single value survives, because
# $(...) strips the trailing CRLF, but a multi-line reader like
# task_unit_names would hand its caller "auth\r\nproto" and every later
# comparison against "auth" would quietly fail. Every jq read in this file
# goes through here so that lib-task's output is identical on both runtimes.
_task_emit() {
	local out
	out=$(jq "$@") || return $?
	[ -n "$out" ] || return 0
	printf '%s\n' "${out//$'\r'/}"
}

# --- paths -----------------------------------------------------------------

# task_dir <id> - absolute path of the task directory.
task_dir() {
	local home
	_task_id_ok "${1:-}" || return $?
	home=$(_task_home) || return $?
	printf '%s/tasks/%s\n' "$home" "$1"
}

# task_file <id> - absolute path of task.json.
task_file() {
	local d
	d=$(task_dir "${1:-}") || return $?
	printf '%s/task.json\n' "$d"
}

# task_exists <id>
task_exists() {
	local f
	f=$(task_file "${1:-}" 2>/dev/null) || return 1
	[ -f "$f" ]
}

_task_need() { # <id> - resolve task.json or fail loudly
	local f
	f=$(task_file "${1:-}") || return $?
	if [ ! -f "$f" ]; then
		_task_err "no such task: ${1:-} - expected $f"
		return 1
	fi
	printf '%s\n' "$f"
}

# --- creation ---------------------------------------------------------------

# task_init <id> <title>
#
# The minimal task directory: task.json + brief.md + an empty log.md. This is
# the internal helper `yan task new` (Phase 9) will call after it has finished
# asking its questions; it deliberately makes no units and starts no terminal.
# Re-running it on an existing task changes nothing.
task_init() {
	local id=${1:-} title=${2-} dir file
	_task_id_ok "$id" || return $?
	if [ -z "$title" ]; then
		_task_err "usage: task_init <id> <title>"
		return 2
	fi

	dir=$(task_dir "$id") || return $?
	file=$dir/task.json
	if ! mkdir -p -- "$dir"; then
		_task_err "cannot create $dir"
		return 1
	fi

	json_init "$file" "$(jq -nc --arg id "$id" --arg t "$title" \
		'{version: 1, id: $id, title: $t, complete: false, units: []}')" || return $?

	if [ ! -e "$dir/brief.md" ]; then
		printf '# %s %s\n\n' "$id" "$title" >"$dir/brief.md"
	fi

	log_init "$id" "$title"
}

# task_list - every task id on disk, one per line.
#
# Derived by scanning, never read from a list: there is no backlog file
# (td INDEX.md §3).
task_list() {
	local home f id
	home=$(_task_home) || return $?
	(
		shopt -s nullglob
		for f in "$home"/tasks/*/task.json; do
			id=${f%/task.json}
			printf '%s\n' "${id##*/}"
		done
	) | LC_ALL=C sort
}

# --- task level readers and writers ----------------------------------------

# task_json <id> - the whole file, compact.
task_json() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_emit -c . "$f"
}

# task_title <id>
task_title() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_emit -r '.title // ""' "$f"
}

# task_is_complete <id> - exit 0 when user has declared the task finished.
task_is_complete() {
	local f v
	f=$(_task_need "${1:-}") || return $?
	v=$(_task_emit -r '.complete == true' "$f") || return $?
	[ "$v" = true ]
}

# task_set_complete <id> <true|false>
task_set_complete() {
	local f v=${2:-}
	f=$(_task_need "${1:-}") || return $?
	case $v in
	true | false) ;;
	*)
		_task_err "usage: task_set_complete <id> <true|false>"
		return 2
		;;
	esac
	json_edit "$f" '.complete = $c' --argjson c "$v"
}

# --- units ------------------------------------------------------------------

# task_unit_names <id> - one per line, in declaration order.
task_unit_names() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_emit -r '.units[]?.name' "$f"
}

# task_units_json <id> - the units array, compact.
task_units_json() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_emit -c '.units // []' "$f"
}

_task_unit_check() { # <file> <unit-name>
	local n
	n=$(jq --arg u "$2" '[.units[]? | select(.name == $u)] | length' "$1") || return 1
	if [ "$n" -eq 0 ]; then
		_task_err "no such unit: $2"
		return 1
	fi
}

# task_unit_json <id> <unit> - one unit object, compact.
task_unit_json() {
	local f u=${2:-}
	f=$(_task_need "${1:-}") || return $?
	if [ -z "$u" ]; then
		_task_err "usage: task_unit_json <id> <unit>"
		return 2
	fi
	_task_unit_check "$f" "$u" || return $?
	_task_emit -c --arg u "$u" '.units[] | select(.name == $u)' "$f"
}

# task_unit_add <id> <name> <repo> <target> [--branch b] [--mode m]
#                                           [--scope p]... [--needs n]...
#
# `target` is positional and required, because td branching.md §6.4 says there
# is no safe default for it. `mode` defaults to mr (td delivery.md §8.2); a
# caller that wants the repository's tuned mode_default passes it explicitly,
# since reading mem/repos.json is `yan repo-add`'s side of the fence.
task_unit_add() {
	local id=${1:-} name=${2:-} repo=${3:-} target=${4:-}
	if [ -z "$id" ] || [ -z "$name" ] || [ -z "$repo" ] || [ -z "$target" ]; then
		_task_err "usage: task_unit_add <id> <name> <repo> <target> [--branch b] [--mode m] [--scope p]... [--needs n]..."
		return 2
	fi
	shift 4

	local branch='' mode=mr
	local scope=() needs=()
	while [ $# -gt 0 ]; do
		case $1 in
		--branch)
			branch=${2:-}
			shift 2 || return 2
			;;
		--mode)
			mode=${2:-}
			shift 2 || return 2
			;;
		--scope)
			scope+=("${2:-}")
			shift 2 || return 2
			;;
		--needs)
			needs+=("${2:-}")
			shift 2 || return 2
			;;
		*)
			_task_err "unknown option: $1"
			return 2
			;;
		esac
	done

	if ! _task_in_set "$mode" "$TASK_MODES"; then
		_task_err "invalid mode '$mode' - one of: $TASK_MODES"
		return 2
	fi

	local f
	f=$(_task_need "$id") || return $?
	if jq -e --arg u "$name" 'any(.units[]?; .name == $u)' "$f" >/dev/null; then
		_task_err "unit already exists: $name"
		return 1
	fi

	local scope_json needs_json
	scope_json=$(_task_json_array "${scope[@]}") || return $?
	needs_json=$(_task_json_array "${needs[@]}") || return $?

	json_edit "$f" '.units += [{
			name:   $name,
			repo:   $repo,
			scope:  $scope,
			needs:  $needs,
			branch: $branch,
			target: $target,
			mode:   $mode,
			mr:     null,
			history: []
		}]' \
		--arg name "$name" --arg repo "$repo" --arg target "$target" \
		--arg mode "$mode" --arg branch "$branch" \
		--argjson scope "$scope_json" --argjson needs "$needs_json"
}

# task_unit_get <id> <unit> <field>
#
# Reads one of the four current scalars, or repo. Arrays have their own
# readers so that a caller never has to parse a printed list.
task_unit_get() {
	local f u=${2:-} field=${3:-}
	f=$(_task_need "${1:-}") || return $?
	case $field in
	branch | target | mode | mr | repo | name) ;;
	scope | needs)
		_task_err "use task_unit_${field} for the $field array"
		return 2
		;;
	*)
		_task_err "usage: task_unit_get <id> <unit> <branch|target|mode|mr|repo|name>"
		return 2
		;;
	esac
	_task_unit_check "$f" "$u" || return $?
	_task_emit -r --arg u "$u" --arg k "$field" \
		'.units[] | select(.name == $u) | .[$k] // "" | tostring' "$f"
}

# task_unit_set <id> <unit> <field> <value>
#
# The ONLY writer of the four current scalars, and it never touches history[].
task_unit_set() {
	local f u=${2:-} field=${3:-} value=${4-}
	f=$(_task_need "${1:-}") || return $?
	case $field in
	branch | target | mr) ;;
	mode)
		if ! _task_in_set "$value" "$TASK_MODES"; then
			_task_err "invalid mode '$value' - one of: $TASK_MODES"
			return 2
		fi
		;;
	*)
		_task_err "usage: task_unit_set <id> <unit> <branch|target|mode|mr> <value> - history[] is append-only and repo/name are fixed at creation"
		return 2
		;;
	esac
	_task_unit_check "$f" "$u" || return $?
	json_edit "$f" '(.units[] | select(.name == $u) | .[$k]) = $v' \
		--arg u "$u" --arg k "$field" --arg v "$value"
}

# task_unit_scope <id> <unit> - one path per line.
task_unit_scope() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_unit_check "$f" "${2:-}" || return $?
	_task_emit -r --arg u "${2:-}" '.units[] | select(.name == $u) | .scope[]?' "$f"
}

# task_unit_needs <id> <unit> - one unit name per line.
task_unit_needs() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_unit_check "$f" "${2:-}" || return $?
	_task_emit -r --arg u "${2:-}" '.units[] | select(.name == $u) | .needs[]?' "$f"
}

# task_unit_set_scope <id> <unit> [path...] - replaces the whole list.
task_unit_set_scope() {
	local f u=${2:-} arr
	f=$(_task_need "${1:-}") || return $?
	_task_unit_check "$f" "$u" || return $?
	shift 2 || true
	arr=$(_task_json_array "$@") || return $?
	json_edit "$f" '(.units[] | select(.name == $u) | .scope) = $v' \
		--arg u "$u" --argjson v "$arr"
}

# task_unit_set_needs <id> <unit> [unit-name...] - replaces the whole list.
task_unit_set_needs() {
	local f u=${2:-} arr
	f=$(_task_need "${1:-}") || return $?
	_task_unit_check "$f" "$u" || return $?
	shift 2 || true
	arr=$(_task_json_array "$@") || return $?
	json_edit "$f" '(.units[] | select(.name == $u) | .needs) = $v' \
		--arg u "$u" --argjson v "$arr"
}

# --- history: append, and nothing else -------------------------------------

# task_unit_history <id> <unit> - the array, compact.
task_unit_history() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_unit_check "$f" "${2:-}" || return $?
	_task_emit -c --arg u "${2:-}" '.units[] | select(.name == $u) | .history' "$f"
}

# task_unit_rounds <id> <unit> - how many rounds have been retired.
#
# td branching.md §6.5: the built-in integration branch name carries r<n>
# where n is length(history) + 1, so the round number needs no storage.
task_unit_rounds() {
	local f
	f=$(_task_need "${1:-}") || return $?
	_task_unit_check "$f" "${2:-}" || return $?
	_task_emit -r --arg u "${2:-}" '.units[] | select(.name == $u) | .history | length' "$f"
}

# _task_history_entry <branch> <target> <at> <end> [mr] - build and validate.
_task_history_entry() {
	local branch=${1:-} target=${2:-} at=${3:-} end=${4:-} mr=${5-}
	if [ -z "$branch" ] || [ -z "$target" ] || [ -z "$end" ]; then
		_task_err "a history entry needs at least branch, target and end"
		return 2
	fi
	if ! _task_in_set "$end" "$TASK_ENDS"; then
		_task_err "invalid end '$end' - one of: $TASK_ENDS"
		return 2
	fi
	if [ -z "$at" ]; then
		at=$(date +%F)
	fi
	# Exactly the five fields of td branching.md §6.4, and mr only when there
	# is one: an abandoned round may never have opened an MR at all.
	jq -nc --arg b "$branch" --arg t "$target" --arg a "$at" --arg e "$end" --arg m "$mr" \
		'{branch: $b, target: $t, at: $a, end: $e}
		 + (if $m == "" then {} else {mr: $m} end)'
}

# task_history_append <id> <unit> <branch> <target> <at> <end> [mr]
#
# The only history writer in the code base. It builds `history + [entry]`, so
# every existing entry is carried across untouched by construction. Pass an
# empty string for <at> to mean today.
task_history_append() {
	local f id=${1:-} u=${2:-} entry
	f=$(_task_need "$id") || return $?
	_task_unit_check "$f" "$u" || return $?
	shift 2
	entry=$(_task_history_entry "$@") || return $?
	json_edit "$f" '(.units[] | select(.name == $u) | .history) |= (. + [$e])' \
		--arg u "$u" --argjson e "$entry"
}

# task_unit_rotate <id> <unit> <end> <new-branch> [at]
#
# Starting a new round is ONE atomic operation (architecture.md §5.1): archive
# the current branch/target/mr into history[] with `at`, then overwrite the
# current branch and clear mr - in a single tmp -> mv. Phase 6's
# `yan unit set --branch` decides `end` by asking the forge and then calls
# this; deciding is not storage's business.
task_unit_rotate() {
	local f id=${1:-} u=${2:-} end=${3:-} newbranch=${4:-} at=${5-}
	local branch target mr entry
	f=$(_task_need "$id") || return $?
	_task_unit_check "$f" "$u" || return $?
	if [ -z "$newbranch" ]; then
		_task_err "usage: task_unit_rotate <id> <unit> <delivered|abandoned> <new-branch> [at]"
		return 2
	fi

	branch=$(task_unit_get "$id" "$u" branch) || return $?
	target=$(task_unit_get "$id" "$u" target) || return $?
	mr=$(task_unit_get "$id" "$u" mr) || return $?
	entry=$(_task_history_entry "$branch" "$target" "$at" "$end" "$mr") || return $?

	json_edit "$f" '
		(.units[] | select(.name == $u)) |= (
			.history = (.history + [$e])
			| .branch = $nb
			| .mr = null
		)' --arg u "$u" --argjson e "$entry" --arg nb "$newbranch"
}
