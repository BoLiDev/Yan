# shellcheck shell=bash
#
# lib-shift.sh - storage for tasks/<id>/shifts/<sid>/ and its throwaway run/
# directory (td INDEX.md §3, Appendix A and B).
#
# Same layer as lib-task.sh and lib-log.sh: it hides one of yan's OWN file
# formats, not an outside authority, so it is thin and it decides nothing. It
# exists because the five Phase 5 subcommands all need the same three answers -
# "where does shift <sid> live", "what does its run/meta.json say", "how is one
# event written" - and five private copies of those defensive reads are how
# five files drift apart.
#
# Four invariants:
#
#   1. run/status IS APPENDED PLAIN TEXT, never JSON. td INDEX.md §2 is
#      explicit: it has to survive a crash without damaging what is already
#      there, and a JSON array cannot do that. The only write to it in the
#      whole code base is the single `>>` in shift_event_append.
#
#   2. EVERY LINE IN run/status IS AN EVENT, NOT THE CURRENT STATE
#      (td agents.md §5.4). There is deliberately NO function here that reads
#      the last line. A shift_status_last() would be read as "the state" within
#      a week, and `yan state` derives the state from the live sources instead.
#      Counting lines is offered; interpreting the newest one is not.
#
#   3. run/meta.json IS READ DEFENSIVELY. Phase 1's `yan ls` fixed the first
#      four keys (.unit, .branch, .tree, .agent); Phase 7 owns writing the file
#      and will add terminal ids and the lease id. A missing file, a missing
#      key, a half-written file or a key this phase has never heard of must
#      never crash a reader, so every read here answers with "I do not know"
#      rather than failing.
#
#   4. The event and the wake marker go together. A shift that reports has done
#      one thing, not two (td agents.md §5.4: do not count on an agent
#      remembering step two).
#
# The library points at one shift at a time. shift_resolve / shift_resolve_dir
# / shift_resolve_env set four globals, and everything else reads them:
#
#   SHIFT_TASK  the task id           SHIFT_DIR  tasks/<id>/shifts/<sid>
#   SHIFT_SID   the shift id          SHIFT_RUN  tasks/<id>/shifts/<sid>/run

if [ -n "${_YAN_LIB_SHIFT_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_SHIFT_SOURCED=1

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"

SHIFT_TASK=
SHIFT_SID=
SHIFT_DIR=
SHIFT_RUN=

_shift_err() {
	printf 'lib-shift: %s\n' "$1" >&2
}

_shift_home() {
	if [ -z "${YAN_HOME:-}" ]; then
		_shift_err "YAN_HOME is not set - run this through bin/yan"
		return 2
	fi
	printf '%s' "$YAN_HOME"
}

# shift_id_ok <sid>
shift_id_ok() {
	case ${1:-} in
	'' | *[!A-Za-z0-9._-]*)
		_shift_err "invalid shift id: '${1:-}' - use letters, digits, dot, dash or underscore"
		return 2
		;;
	esac
}

# --- pointing at one shift --------------------------------------------------

# shift_use <task-id> <sid> - point at a shift by name, existing or not.
shift_use() {
	local id=${1:-} sid=${2:-} tdir
	shift_id_ok "$sid" || return $?
	tdir=$(task_dir "$id") || return $?
	SHIFT_TASK=$id
	SHIFT_SID=$sid
	SHIFT_DIR=$tdir/shifts/$sid
	SHIFT_RUN=$SHIFT_DIR/run
}

# shift_resolve <sid> [task-id] - find an existing shift.
#
# Derived by scanning, never read from an index: tasks/*/shifts/<sid> IS the
# registry (design principle 1). $YAN_TASK narrows the search when it is set,
# which is the normal case - a yan is task-scoped (td agents.md §5.2).
#
# An id that exists under two tasks is refused rather than guessed at.
shift_resolve() {
	local sid=${1:-} want=${2:-} home d id
	local hits=()
	if [ -z "$want" ]; then
		want=${YAN_TASK:-}
	fi
	shift_id_ok "$sid" || return $?
	home=$(_shift_home) || return $?

	if [ -n "$want" ]; then
		shift_use "$want" "$sid" || return $?
		if [ ! -d "$SHIFT_DIR" ]; then
			_shift_err "no such shift: $sid in task $want - $SHIFT_DIR does not exist"
			return 1
		fi
		return 0
	fi

	while IFS= read -r d; do
		[ -n "$d" ] || continue
		hits+=("$d")
	done < <(
		shopt -s nullglob
		for d in "$home"/tasks/*/shifts/"$sid"; do
			if [ -d "$d" ]; then
				printf '%s\n' "$d"
			fi
		done
	)

	case ${#hits[@]} in
	0)
		_shift_err "no such shift: $sid - nothing matches $home/tasks/*/shifts/$sid"
		return 1
		;;
	1) ;;
	*)
		_shift_err "shift id '$sid' exists in more than one task - name the task, for example --task <id>"
		for d in "${hits[@]}"; do
			id=${d%/shifts/*}
			printf '  %s\n' "${id##*/}" >&2
		done
		return 2
		;;
	esac

	id=${hits[0]%/shifts/*}
	shift_use "${id##*/}" "$sid"
}

# shift_resolve_dir <dir> - point at a shift given its directory.
#
# The task id is recovered from the path only when the layout says so
# (.../<task>/shifts/<sid>); anywhere else it stays empty and callers that need
# a task say so themselves. Guessing would be worse than not knowing.
shift_resolve_dir() {
	local dir=${1:-} abs parent
	if [ -z "$dir" ]; then
		_shift_err "usage: shift_resolve_dir <shift-directory>"
		return 2
	fi
	if [ ! -d "$dir" ]; then
		_shift_err "no such directory: $dir"
		return 1
	fi
	if ! abs=$(cd -P -- "$dir" >/dev/null 2>&1 && pwd); then
		_shift_err "cannot resolve directory: $dir"
		return 1
	fi

	SHIFT_DIR=$abs
	SHIFT_RUN=$abs/run
	SHIFT_SID=${abs##*/}
	SHIFT_TASK=
	parent=${abs%/*}
	if [ "${parent##*/}" = shifts ]; then
		parent=${parent%/*}
		SHIFT_TASK=${parent##*/}
	fi
}

# shift_resolve_env - find the CALLING shift's own directory.
#
# `yan report` takes no <sid>: a shift reports about itself, and asking it to
# repeat its own id is one more thing to get wrong. So the identity comes from
# the environment its spawn script set.
#
# PHASE 7 OWNS THAT ENVIRONMENT. td agents.md §5.3 only says `yan shift new`
# "sets YAN_TASK_DIR", and does not say whether that points at the task or at
# the shift, so all three readings are accepted here and none of them is
# invented later:
#
#   YAN_SHIFT_DIR              the shift's own directory (preferred, unambiguous)
#   YAN_TASK_DIR               the shift's own directory, or the task directory
#                              when YAN_SID is also set
#   YAN_TASK + YAN_SID         ids only; resolved by scanning
#
# Non-zero without a message when none of them is usable; the caller is in a
# better position to say what to pass.
shift_resolve_env() {
	local parent
	if [ -n "${YAN_SHIFT_DIR:-}" ]; then
		shift_resolve_dir "$YAN_SHIFT_DIR"
		return $?
	fi
	if [ -n "${YAN_TASK_DIR:-}" ]; then
		parent=${YAN_TASK_DIR%/}
		parent=${parent%/*}
		if [ -d "$YAN_TASK_DIR/run" ] || [ "${parent##*/}" = shifts ]; then
			shift_resolve_dir "$YAN_TASK_DIR"
			return $?
		fi
		if [ -n "${YAN_SID:-}" ] && [ -d "$YAN_TASK_DIR/shifts/${YAN_SID}" ]; then
			shift_resolve_dir "$YAN_TASK_DIR/shifts/${YAN_SID}"
			return $?
		fi
	fi
	if [ -n "${YAN_SID:-}" ]; then
		shift_resolve "$YAN_SID" "${YAN_TASK:-}"
		return $?
	fi
	return 1
}

# --- paths ------------------------------------------------------------------

# shift_label - how the selected shift is named in a message.
shift_label() {
	if [ -n "$SHIFT_TASK" ]; then
		printf '%s (task %s)\n' "$SHIFT_SID" "$SHIFT_TASK"
	else
		printf '%s\n' "$SHIFT_SID"
	fi
}

shift_meta_file() { printf '%s/meta.json\n' "$SHIFT_RUN"; }
shift_status_file() { printf '%s/status\n' "$SHIFT_RUN"; }
shift_signal_file() { printf '%s/signal\n' "$SHIFT_RUN"; }

# shift_is_live - zero while run/ still exists.
#
# run/ is the only throwaway layer and clocking out deletes it whole
# (td INDEX.md §3), so its presence IS the fact. Nothing mirrors it.
shift_is_live() { [ -d "$SHIFT_RUN" ]; }

# --- reading run/meta.json --------------------------------------------------

# shift_meta_get <key> [key...] - the first key that has a usable value.
#
# Several keys because Phase 7 has not written this file yet and the spelling
# of the terminal id is its decision, not this phase's: a reader that accepts
# `pane` and `pane_id` costs one loop and cannot be wrong about it.
#
# Non-zero (and silent) when the file is missing, unreadable, not JSON, or has
# none of the keys. conventions §2.3: this calls jq directly rather than going
# through lib-json, because the key is dynamic, so it strips the CR itself.
shift_meta_get() {
	local file out k
	file=$SHIFT_RUN/meta.json
	[ -f "$file" ] || return 1
	for k in "$@"; do
		out=$(jq -r --arg k "$k" '
			(.[$k] // "") | if type == "string" then . else tostring end
		' "$file" 2>/dev/null) || return 1
		out=${out//$'\r'/}
		if [ -n "$out" ] && [ "$out" != null ]; then
			printf '%s\n' "$out"
			return 0
		fi
	done
	return 1
}

# The four keys Phase 1's `yan ls` already treats as the contract.
shift_meta_unit() { shift_meta_get unit; }
shift_meta_branch() { shift_meta_get branch; }
shift_meta_tree() { shift_meta_get tree; }
shift_meta_agent() { shift_meta_get agent; }

# shift_meta_agent_id - the terminal id term_agent_start printed.
#
# A pane id is preferred over a window id because it is the more precise of the
# two; lib-term accepts either. NEVER a label: tmux does not promise labels are
# unique (td agents.md §5.7 practice 1).
shift_meta_agent_id() { shift_meta_get pane pane_id window window_id agent_id term_id; }

# shift_meta_mr - the shift branch's merge request, when one has been recorded.
shift_meta_mr() { shift_meta_get mr mr_url; }

# shift_reported_mr - the merge request URL the shift reported, if any.
#
# delivery.md §8.2 gives `mr` mode the final state `done: mr <url>`, so the URL
# reaches yan through the note of a `done` event: the shift opens its own MR,
# and `yan report done "mr <url>"` is the only channel that carries the address
# back. Nothing else records it - `yan` does not open the shift's MR and cannot
# ask the forge "which MR came from this branch" without putting forge
# vocabulary in a subcommand.
#
# This does NOT break invariant 2 ("every line is an event, not the state").
# The verdict "has it merged?" still comes from the forge and only from the
# forge. What is read here is a FACT the shift recorded - an address - which is
# exactly what an event log is for. The last URL wins because a shift that
# reopened its MR reported the newer one later.
shift_reported_mr() {
	local f=$SHIFT_RUN/status url=''
	[ -f "$f" ] || return 1
	url=$(sed -n 's|.*\(https\{0,1\}://[^[:space:]]*\).*|\1|p' "$f" | tail -1)
	url=${url%$'\r'}
	[ -n "$url" ] || return 1
	printf '%s\n' "$url"
}

# --- run/status -------------------------------------------------------------

# shift_resume_from_pool <task> <sid>
#
# When run/ is gone, tell apart "this shift clocked out cleanly" from "a
# teardown deleted run/ and then stopped before the tree came back".
#
# From $YAN_HOME the two are identical, and the difference is expensive: the
# second leaves a tree leased and a remote branch undeleted, with nothing left
# to say which shift they belonged to.
#
# Nothing needs to be stored to tell them apart. The pool already records the
# holder as <task>/<unit>/<sid>, together with the branch, the path and the
# lease id - which is everything the rest of the teardown needs. So the answer
# is derived, exactly as design principle 1 asks: ask the pool.
#
# Prints one JSON object ({unit, repo, clone, path, branch, holder, lease_id})
# and returns 0 when such a lease exists; returns 1 when it does not, which is
# the honest "it really has clocked out".
#
# Only this task's own units are searched: a task-scoped `yan` may not read
# another task's directory (td §5.2), and the holder is namespaced by task
# anyway.
shift_resume_from_pool() {
	local task=${1:-} sid=${2:-} unit repo clone want found
	[ -n "$task" ] && [ -n "$sid" ] || return 1
	command -v pool_status >/dev/null 2>&1 || return 1
	command -v task_unit_names >/dev/null 2>&1 || return 1

	while IFS= read -r unit; do
		[ -n "$unit" ] || continue
		want="$task/$unit/$sid"
		repo=$(task_unit_get "$task" "$unit" repo 2>/dev/null) || continue
		[ -n "$repo" ] || continue
		clone=$(_shift_home)/repos/$repo
		[ -d "$clone" ] || continue
		found=$(pool_status "$clone" 2>/dev/null |
			jq -c --arg h "$want" --arg u "$unit" --arg r "$repo" --arg c "$clone" \
				'(if type=="array" then . else [.] end)
				 | map(select(.holder == $h))
				 | .[0] // empty
				 | . + {unit: $u, repo: $r, clone: $c}' 2>/dev/null) || continue
		if [ -n "$found" ]; then
			printf '%s\n' "$found"
			return 0
		fi
	done <<EOF
$(task_unit_names "$task" 2>/dev/null)
EOF
	return 1
}

# shift_event_count - how many events have been reported.
#
# A count, not a verdict. It tells you whether anything has happened; it says
# nothing about what the shift is doing now (invariant 2).
shift_event_count() {
	local f=$SHIFT_RUN/status n
	if [ ! -f "$f" ]; then
		printf '0\n'
		return 0
	fi
	n=$(wc -l <"$f" 2>/dev/null) || n=0
	n=${n//[!0-9]/}
	printf '%s\n' "${n:-0}"
}

# shift_event_append <state> <note>
#
# One event, then the wake marker, in that order and in one command.
#
# THE ORDER IS NOT ARBITRARY. Signal first would mean a crash in between leaves
# a marker pointing at nothing: yan wakes, finds no new event, clears the
# signal - and the event that lands afterwards is then never announced to
# anyone. Event first means a crash in between leaves a recorded event that
# nobody was woken for, and supervision's other two sources (the agent died,
# the pane stopped moving) are exactly the ones that catch a shift which
# crashed mid-report (td supervision.md).
#
# The line is written by ONE printf on purpose. A short single write to a file
# opened with O_APPEND is not interleaved with another writer's, whereas three
# printfs into the same file are three chances to end up with half a line.
shift_event_append() {
	local state=${1:-} note=${2-} ts f
	if [ -z "$state" ]; then
		_shift_err "usage: shift_event_append <state> <note>"
		return 2
	fi
	case $state$note in
	*$'\n'*)
		_shift_err "an event is one line - a newline would forge a second event"
		return 2
		;;
	esac
	if [ -z "$SHIFT_RUN" ]; then
		_shift_err "no shift selected - call shift_resolve first"
		return 2
	fi
	if ! mkdir -p -- "$SHIFT_RUN"; then
		_shift_err "cannot create the run directory of $(shift_label): $SHIFT_RUN"
		return 1
	fi

	ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	f=$SHIFT_RUN/status
	if ! printf '%s\t%s\t%s\n' "$ts" "$state" "$note" >>"$f"; then
		_shift_err "cannot append to $f"
		return 1
	fi
	if ! touch -- "$SHIFT_RUN/signal"; then
		_shift_err "the event was recorded in $f but the wake marker $SHIFT_RUN/signal could not be written"
		return 1
	fi
}
