# shellcheck shell=bash
#
# lib-term.sh - the terminal seam (td agents.md §5.7, architecture.md §4.3).
#
# One terminal container per task. Under tmux the concepts line up like this:
#
#     the task container   ->  a tmux session   ($0)
#     one agent            ->  a tmux window    (@3)
#     a terminal           ->  a tmux pane      (%7)
#
# Seven functions, and every tmux command in yan lives behind one of them.
# Herdr would be a second implementation of the same seven; the MVP implements
# tmux only and fails closed on `"backend": "herdr"`.
#
# Four rules this file exists to hold:
#
#   1. A LABEL IS NOT A SOURCE OF TRUTH; RECORD THE ID. tmux does not promise
#      that window names are unique - two shifts can quite legally both be
#      called `s3-auth` - so a name lookup can hit the wrong agent. Every
#      per-agent function therefore refuses anything that is not a tmux id
#      (`@3` / `%7`), and term_agent_start returns the ids for the caller to
#      record in run/meta.json. There is exactly one name lookup in this file,
#      in term_container_create, and the comment there says why it is safe.
#
#   2. CLOSE EXACTLY ONE THING. term_agent_close closes the recorded window or
#      pane and nothing else. There is no code path in this file that can
#      destroy a container or the tmux server - the two tmux verbs that would
#      do it are simply not spelled anywhere here, and a unit test greps for
#      them. Because tmux destroys a session together with its last window,
#      term_agent_close also refuses to close an agent that is the last window
#      in its container.
#
#   3. DO NOT STEAL FOCUS. Both create and start pass `-d`, so spawning an
#      agent never yanks user's terminal away from what they were doing.
#
#   4. REPORT FACTS, DECIDE NOTHING. term_agent_alive answers with one of three
#      words defined by yan - alive, dead, unknown - never with tmux's own
#      vocabulary, and never with a guess dressed up as a fact.
#
# Windows: a native console program (claude.exe, codex.exe, gh.exe) started in
# an MSYS2 tmux pane is handed a pipe, not a console. It sees no TTY, decides it
# is non-interactive, and exits immediately. term_agent_start therefore wraps
# the command in `winpty` on Windows and never on Linux, where winpty does not
# exist and is not needed (conventions §2.1).

if [ -n "${_YAN_LIB_TERM_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_TERM_SOURCED=1

# shellcheck source=bin/lib-boot.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-boot.sh"

# The pane geometry a detached container gets. tmux would otherwise default to
# 80x24, which is small enough to make an agent TUI reflow into soup and makes
# term_read much harder to read.
: "${YAN_TERM_COLS:=200}"
: "${YAN_TERM_ROWS:=50}"

# Windows started by term_agent_start carry this tmux user option, so term_list
# can tell an agent from the plain shell window that keeps a container alive.
# It is stored in tmux, not under $YAN_HOME: a seam only touches its own outside
# authority (architecture.md §4.3 rule 3).
_YAN_TERM_MARK='@yan_agent'

_term_err() {
	printf 'lib-term: %s\n' "$1" >&2
}

# --- the backend gate ------------------------------------------------------

# _term_backend - zero when this machine is configured for tmux.
#
# `herdr` is design-complete and deliberately not implemented, so it fails
# closed here rather than half-working somewhere further down.
_term_backend() {
	local backend
	if [ -z "${YAN_HOME:-}" ]; then
		_term_err "YAN_HOME is not set - the terminal backend is read from \$YAN_HOME/conf/config.json"
		return 2
	fi
	backend=$(boot_config_get '.backend' 'tmux')
	# boot_config_get calls jq directly rather than going through lib-json, so
	# conventions §2.3 applies here: jq.exe on Git Bash can hand back CRLF, and
	# a stray CR would leave "tmux" matching nothing while reading identically
	# in every error message it appeared in. Strip it before comparing.
	backend=${backend//$'\r'/}
	case $backend in
	tmux) return 0 ;;
	herdr)
		_term_err "backend 'herdr' is not implemented in the MVP - set \"backend\": \"tmux\" in $(boot_config_path)"
		return 1
		;;
	*)
		_term_err "unknown backend '$backend' - the MVP supports tmux only; set \"backend\": \"tmux\" in $(boot_config_path)"
		return 1
		;;
	esac
}

_term_tmux() {
	if ! command -v tmux >/dev/null 2>&1; then
		_term_err "tmux is not on PATH - install tmux, then run 'yan doctor'"
		return 1
	fi
	tmux "$@"
}

# --- ids, never labels -----------------------------------------------------

# _term_is_id <candidate> <allowed-first-characters>
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

_term_need_session_id() {
	if _term_is_id "${1:-}" '$'; then
		return 0
	fi
	_term_err "'${1:-}' is not a container id - pass the id term_container_create printed (\$0), never a name: tmux does not promise names are unique"
	return 2
}

_term_need_agent_id() {
	if _term_is_id "${1:-}" '@%'; then
		return 0
	fi
	_term_err "'${1:-}' is not an agent id - pass an id term_agent_start printed (@3 or %7), never a label: tmux does not promise labels are unique"
	return 2
}

# --- asking tmux about one agent -------------------------------------------

# The single query behind alive / close / list-one. Matching happens on the id
# column, so `@3` and `%7` both find the same row and nothing is ever resolved
# through a name.
_TERM_ROW=
_TERM_QUERY_ERR=
_TERM_FMT='#{session_id} #{window_id} #{pane_id} #{pane_dead} #{pane_pid} #{session_windows} #{window_panes} #{pane_current_command}'

# _term_query <agent-id>
#   0  found; the row is in $_TERM_ROW
#   1  tmux is running and has no such window or pane (or no server at all)
#   2  tmux could not be asked; the reason is in $_TERM_QUERY_ERR
_term_query() {
	local id=${1:-} out rc=0
	_TERM_ROW=
	_TERM_QUERY_ERR=

	if ! command -v tmux >/dev/null 2>&1; then
		_TERM_QUERY_ERR="tmux is not on PATH"
		return 2
	fi

	out=$(tmux list-panes -a -F "$_TERM_FMT" 2>&1) || rc=$?
	if [ "$rc" -ne 0 ]; then
		case $out in
		# No server means no container and no agent: the thing being asked
		# about is definitively gone, which is an answer, not a failure.
		*'no server running'* | *'no current session'* | *'error connecting'*) return 1 ;;
		*)
			_TERM_QUERY_ERR=$out
			return 2
			;;
		esac
	fi

	_TERM_ROW=$(printf '%s\n' "$out" | awk -v id="$id" '$2 == id || $3 == id { print; exit }')
	[ -n "$_TERM_ROW" ] || return 1
	return 0
}

# _term_field <n> - one column of $_TERM_ROW.
_term_field() {
	printf '%s\n' "$_TERM_ROW" | awk -v n="$1" '{ print $n }'
}

# _term_norm_cmd <name> - compare command names the same way on both platforms:
# no directory, no .exe, lower case.
_term_norm_cmd() {
	local c=${1:-}
	c=${c##*/}
	c=${c##*\\}
	c=${c%.exe}
	c=${c%.EXE}
	printf '%s\n' "$c" | tr '[:upper:]' '[:lower:]'
}

# _term_descendant_names <pid> - best-effort names of that pid's descendants.
#
# Non-zero when the platform's ps cannot answer, which is the normal case under
# MSYS2: its ps has no -o, and a winpty child is a native Windows process that
# an MSYS ps does not list at all. Callers must treat failure as "no idea",
# never as "nothing is running".
_term_descendant_names() {
	local root=${1:-} snapshot
	case $root in
	'' | *[!0-9]*) return 1 ;;
	esac
	snapshot=$(ps -o pid=,ppid=,comm= 2>/dev/null) || return 1
	[ -n "$snapshot" ] || return 1
	printf '%s\n' "$snapshot" | awk -v root="$root" '
		{ pid[NR] = $1; ppid[NR] = $2; name[NR] = $3; n = NR }
		END {
			want[root] = 1
			for (pass = 0; pass < 12; pass++)
				for (i = 1; i <= n; i++)
					if (ppid[i] in want) want[pid[i]] = 1
			for (i = 1; i <= n; i++)
				if ((pid[i] in want) && pid[i] != root) print name[i]
		}'
}

# _term_quote_cmd <word...> - one sh-safe command line out of separate words.
#
# tmux hands the pane command to `sh -c`, so the words have to survive one
# round of shell parsing with their spaces and quotes intact.
_term_quote_cmd() {
	local out='' a q
	for a in "$@"; do
		q=$(printf '%s' "$a" | sed "s/'/'\\\\''/g")
		if [ -z "$out" ]; then
			out="'$q'"
		else
			out="$out '$q'"
		fi
	done
	printf '%s' "$out"
}

# _term_is_shebang_script <command> - zero when the command resolves to a file
# whose first two bytes are `#!`.
#
# Only ever consulted on Windows, to decide whether winpty needs an interpreter
# in front of the command (see term_agent_start). A command that cannot be
# resolved, or cannot be read, is treated as NOT a script: that is the previous
# behaviour, so an unresolvable name fails the way it always did rather than
# acquiring a confusing `bash` in front of it.
_term_is_shebang_script() {
	local cmd=${1:-} path head
	[ -n "$cmd" ] || return 1
	path=$(command -v -- "$cmd" 2>/dev/null) || return 1
	[ -f "$path" ] || return 1
	head=$(head -c 2 -- "$path" 2>/dev/null) || return 1
	[ "$head" = '#!' ]
}

# --- the seven -------------------------------------------------------------

# term_container_create <name> - create (or find) the task container.
#
# Prints the container id. `-d` keeps it detached, so creating a container for
# a new task never pulls user out of the terminal they are in.
#
# It is idempotent on purpose: `yan continue` means "create or attach", and a
# second call for the same task must reach the same container. The lookup that
# makes that work is the only place in this file that touches a name, and it is
# safe because tmux refuses to create a second session with a name it already
# has - session names, unlike window names, ARE unique per server. Everything
# afterwards is done through the id this printed.
#
# The container keeps one plain shell window of its own. That window is not an
# agent (term_list does not report it); it is what keeps the container alive
# when the last agent is closed, because tmux destroys a session together with
# its last window.
term_container_create() {
	_term_backend || return $?

	local name=${1:-}
	if [ -z "$name" ]; then
		_term_err "usage: term_container_create <name>"
		return 2
	fi
	# tmux splits a target on ':' (window) and '.' (pane), and it does so even
	# for a target that can only be a session and even behind the exact-match
	# `=` prefix. A container called `fix v1.2` is created happily and then
	# cannot be reached by name at all - `tmux attach -t 'fix v1.2'` answers
	# "can't find pane: 2". yan itself is immune, because after this function
	# everything goes by id, but `tmux ls` is meant to be user's task list and a
	# session they cannot attach to by name is a trap. Refuse it here, where the
	# name is still theirs to change.
	case $name in
	*[:.]*)
		_term_err "a container name cannot contain ':' or '.' - tmux reads both as target separators and the container could not be attached to by name; got '$name'"
		return 2
		;;
	esac

	local out rc=0 sid
	out=$(_term_tmux new-session -d -s "$name" \
		-x "$YAN_TERM_COLS" -y "$YAN_TERM_ROWS" \
		-P -F '#{session_id}' 2>&1) || rc=$?
	if [ "$rc" -eq 0 ]; then
		printf '%s\n' "$out"
		return 0
	fi

	sid=$(_term_tmux list-sessions -F '#{session_id} #{session_name}' 2>/dev/null |
		awk -v want="$name" '{ id = $1; sub(/^[^ ]* /, ""); if ($0 == want) { print id; exit } }')
	if [ -n "$sid" ]; then
		printf '%s\n' "$sid"
		return 0
	fi

	_term_err "cannot create the task container '$name' - tmux said: $out"
	return 1
}

# term_agent_start [-c <dir>] [-e VAR=VALUE]... <container-id> <label> <command> [arg...]
#
# Starts one agent in the container and prints its ids:
#
#     @3 %7        <window-id> <pane-id>
#
# Record both (run/meta.json); every later call takes one of them. The label is
# only what a human reads in the tmux status line - it is never how the agent is
# found again.
#
# `-e` matters more than it looks: a pane inherits the tmux SERVER's environment,
# not the environment of whoever called this, so exporting YAN_TASK_DIR before
# calling would not reach the agent.
#
# On Windows the command is wrapped in `winpty`. Without it a native console
# program in an MSYS2 pane gets a pipe instead of a console, decides it is
# non-interactive and exits before it has printed anything useful.
#
# The pane is set `remain-on-exit`, so an agent that dies leaves its pane behind
# with its scrollback readable. That is what lets term_agent_alive separate "the
# agent died" from "the agent was closed", and it lets term_read show why.
term_agent_start() {
	_term_backend || return $?

	local dir='' envs=()
	while [ $# -gt 0 ]; do
		case ${1:-} in
		-c)
			if [ $# -lt 2 ]; then
				_term_err "-c needs a directory"
				return 2
			fi
			dir=$2
			shift 2
			;;
		-e)
			if [ $# -lt 2 ]; then
				_term_err "-e needs VAR=VALUE"
				return 2
			fi
			envs+=("$2")
			shift 2
			;;
		--)
			shift
			break
			;;
		-*)
			_term_err "unknown option '$1' - usage: term_agent_start [-c <dir>] [-e VAR=VALUE]... <container-id> <label> <command> [arg...]"
			return 2
			;;
		*) break ;;
		esac
	done

	local sid=${1:-} label=${2:-}
	_term_need_session_id "$sid" || return $?
	if [ -z "$label" ] || [ $# -lt 3 ]; then
		_term_err "usage: term_agent_start [-c <dir>] [-e VAR=VALUE]... <container-id> <label> <command> [arg...]"
		return 2
	fi
	shift 2

	if [ -n "$dir" ] && [ ! -d "$dir" ]; then
		_term_err "cannot start '$label': no such directory: $dir"
		return 2
	fi

	local cmd
	cmd=$(_term_quote_cmd "$@")
	if [ "$(boot_platform)" = windows ]; then
		if ! command -v winpty >/dev/null 2>&1; then
			_term_err "winpty is not on PATH - on Windows an agent CLI started in a tmux pane gets no TTY and exits immediately, so it has to run as 'winpty <cmd>'; install it (pacman -S winpty) and run 'yan doctor'"
			return 1
		fi
		# winpty launches a NATIVE Windows process, so it cannot start a script
		# with a shebang: `winpty ./cli` fails with
		#   %1 is not a valid Win32 application. (error 0xc1)
		# and the pane dies instantly. This is not hypothetical for `yan`: the
		# MVP accepts any shift CLI that meets td §5.6, and an npm-installed one
		# resolves to a shell-script shim under Git Bash. `claude` here happens
		# to be a real .exe, which is why the e2e never caught it.
		#
		# Handing the script to an interpreter fixes it, and the interpreter IS
		# a native process, so winpty is happy. Native executables are left
		# exactly as they were.
		if _term_is_shebang_script "$1"; then
			cmd="winpty bash $cmd"
		else
			cmd="winpty $cmd"
		fi
	fi

	local args=(new-window -d -P -F '#{window_id} #{pane_id}' -t "$sid:" -n "$label")
	if [ -n "$dir" ]; then
		args+=(-c "$dir")
	fi
	local e
	for e in ${envs[@]+"${envs[@]}"}; do
		args+=(-e "$e")
	done

	local out rc=0
	out=$(_term_tmux "${args[@]}" -- "$cmd" 2>&1) || rc=$?
	if [ "$rc" -ne 0 ]; then
		_term_err "cannot start '$label' in container $sid - tmux said: $out"
		return 1
	fi

	local wid=${out%% *} pane=${out##* }
	# Both are niceties, not contracts: an older tmux may not know the pane-level
	# option, and losing either only makes the answers coarser.
	_term_tmux set-option -p -t "$pane" remain-on-exit on >/dev/null 2>&1 || true
	_term_tmux set-option -w -t "$wid" "$_YAN_TERM_MARK" 1 >/dev/null 2>&1 || true

	printf '%s %s\n' "$wid" "$pane"
}

# term_send <agent-id> <text>          type the text, then press Enter
# term_send <agent-id> --no-enter <text>   type the text and stop there
# term_send <agent-id> --enter         press Enter and nothing else
#
# The text and the Enter go as two separate tmux commands, deliberately
# (td §5.4). Agent CLIs routinely swallow or re-render the first Enter while
# they are still painting their input box, and the fix is to press Enter again -
# not to type the whole line a second time and end up sending it twice.
#
# The text is sent with `-l`, so it is typed literally: a line containing
# `C-c` or `Enter` is characters, never key names.
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

	local out rc=0
	if [ "$want_text" -eq 1 ]; then
		out=$(_term_tmux send-keys -t "$id" -l -- "$1" 2>&1) || rc=$?
		if [ "$rc" -ne 0 ]; then
			_term_err "cannot send text to $id - tmux said: $out"
			return 1
		fi
	fi
	if [ "$want_enter" -eq 1 ]; then
		out=$(_term_tmux send-keys -t "$id" Enter 2>&1) || rc=$?
		if [ "$rc" -ne 0 ]; then
			_term_err "cannot send Enter to $id - tmux said: $out"
			return 1
		fi
	fi
	return 0
}

# term_read <agent-id> [history-lines] - print what is on the agent's terminal.
#
# With no second argument this is the visible pane. With one, that many lines of
# scrollback above it are included as well. The output is raw, trailing blank
# rows and all: supervision hashes it to notice a pane that has stopped moving,
# and trimming would quietly change the hash.
#
# A pane whose agent has died is still readable, which is usually exactly when
# someone wants to read it - but ask for history when you do: tmux scrolls what
# was on screen into the pane's history the moment the process exits and paints
# a notice of its own in its place, so the agent's last words are only in the
# scrollback.
term_read() {
	_term_backend || return $?

	local id=${1:-} lines=${2:-}
	_term_need_agent_id "$id" || return $?

	local out rc=0
	if [ -n "$lines" ]; then
		case $lines in
		'' | *[!0-9]*)
			_term_err "history-lines must be a whole number of lines, got '$lines'"
			return 2
			;;
		esac
		out=$(_term_tmux capture-pane -p -t "$id" -S "-$lines" 2>&1) || rc=$?
	else
		out=$(_term_tmux capture-pane -p -t "$id" 2>&1) || rc=$?
	fi

	if [ "$rc" -ne 0 ]; then
		_term_err "cannot read $id - tmux said: $out"
		return 1
	fi
	printf '%s\n' "$out"
}

# term_agent_alive <agent-id> [expected-command] - alive | dead | unknown.
#
# Three words defined by yan, never tmux's own (architecture.md §4.3 rule 1).
# This is the hardest function in the seam and td §5.7 says so: under tmux there
# is no agent registry to ask, so the honest answer is sometimes "I cannot tell".
# What each word means, exactly:
#
#   dead     tmux knows no such window or pane - it was closed, or its container
#            is gone, or there is no tmux server at all. Also: the pane is still
#            there and its process has exited (`pane_dead`), which is visible
#            because term_agent_start sets remain-on-exit.
#
#   alive    the pane exists and the process term_agent_start put in it is still
#            running. That is a fact, not a guess, and it is a claim about the
#            PANE'S OWN process - which is the agent, because this seam starts
#            the agent as the pane's command rather than typing it into a shell.
#            On Windows that process is `winpty`, and winpty exits exactly when
#            its child does, so a live winpty is a live agent.
#
#   unknown  tmux itself could not be asked (not on PATH, or a query failed for
#            some reason other than the target being gone), or an expected
#            command was named and could not be found among the pane's process
#            names. The second case is td §5.7's warning made concrete: an agent
#            inside a generic interpreter cannot be identified by process name,
#            and MSYS2's ps cannot see across winpty into native Windows
#            processes at all. Where we cannot tell, we say so - we never round
#            "probably" up to alive.
#
# The expected command is optional and only ever narrows the answer: it can turn
# an `alive` into an `unknown`, never into a `dead`. A live pane is never dead.
#
# Always exits 0 with one of the three words on stdout - the verdict is the
# return value, so a caller never has to tell "dead" apart from "the check
# failed". Exit 2 means the call itself was wrong.
term_agent_alive() {
	_term_backend || return $?

	local id=${1:-} expected=${2:-}
	_term_need_agent_id "$id" || return $?

	local rc=0
	_term_query "$id" || rc=$?
	case $rc in
	1)
		printf 'dead\n'
		return 0
		;;
	2)
		_term_err "cannot ask tmux about $id, reporting unknown - ${_TERM_QUERY_ERR:-no reason given}"
		printf 'unknown\n'
		return 0
		;;
	esac

	if [ "$(_term_field 4)" = 1 ]; then
		printf 'dead\n'
		return 0
	fi

	if [ -z "$expected" ]; then
		printf 'alive\n'
		return 0
	fi

	local current
	current=$(_term_norm_cmd "$(_term_field 8)")
	expected=$(_term_norm_cmd "$expected")

	# winpty is our own wrapper, not a foreign interpreter that could outlive
	# what it wraps: it exits when its child exits. On Windows it is what the
	# pane is always running, and looking past it is not possible anyway.
	if [ "$current" = winpty ] || [ "$current" = "$expected" ]; then
		printf 'alive\n'
		return 0
	fi

	local name
	while IFS= read -r name; do
		[ -n "$name" ] || continue
		if [ "$(_term_norm_cmd "$name")" = "$expected" ]; then
			printf 'alive\n'
			return 0
		fi
	done < <(_term_descendant_names "$(_term_field 5)" 2>/dev/null || true)

	printf 'unknown\n'
	return 0
}

# term_agent_close <agent-id> - close exactly one recorded agent.
#
# Closes the window (or the single pane) that the id names, and nothing else.
# Nothing here can destroy a container or the tmux server: a container's
# lifetime belongs to user, who opened it and will close it (td §5.7).
#
# tmux destroys a session together with its last window, so closing the last
# window would close the container by the back door. That is refused rather than
# done quietly. In normal use it cannot come up: a container keeps a plain shell
# window of its own, so an agent is never the last window.
#
# Closing an agent that is already gone succeeds and does nothing. Pane and
# window ids are never reused by a tmux server, so an id that is not there can
# only be one that has already been closed - which is the state being asked for.
term_agent_close() {
	_term_backend || return $?

	local id=${1:-}
	_term_need_agent_id "$id" || return $?

	local rc=0
	_term_query "$id" || rc=$?
	case $rc in
	1) return 0 ;;
	2)
		_term_err "cannot close $id: tmux could not be asked - ${_TERM_QUERY_ERR:-no reason given}"
		return 1
		;;
	esac

	local sid wid pane windows panes out kill_rc=0
	sid=$(_term_field 1)
	wid=$(_term_field 2)
	pane=$(_term_field 3)
	windows=$(_term_field 6)
	panes=$(_term_field 7)

	case $id in
	@*)
		if [ "$windows" -le 1 ]; then
			_term_err "refusing to close $wid: it is the only window left in container $sid, and tmux would destroy the container with it - a container is closed by user, never by this seam"
			return 1
		fi
		out=$(_term_tmux kill-window -t "$wid" 2>&1) || kill_rc=$?
		;;
	*)
		if [ "$windows" -le 1 ] && [ "$panes" -le 1 ]; then
			_term_err "refusing to close $pane: it is the only pane of the only window in container $sid, and tmux would destroy the container with it - a container is closed by user, never by this seam"
			return 1
		fi
		out=$(_term_tmux kill-pane -t "$pane" 2>&1) || kill_rc=$?
		;;
	esac

	if [ "$kill_rc" -ne 0 ]; then
		_term_err "cannot close $id - tmux said: $out"
		return 1
	fi
	return 0
}

# term_list <container-id> - the agents in one container, one per line:
#
#     <window-id>\t<pane-id>\t<label>
#
# Only agents that term_agent_start put there. The container's own shell window
# is not one, and neither is anything user opened by hand. The label is last
# because it is the only field that can contain a space - and the only field
# nothing should ever be looked up by.
term_list() {
	_term_backend || return $?

	local sid=${1:-}
	_term_need_session_id "$sid" || return $?

	local out rc=0
	out=$(_term_tmux list-windows -t "$sid" \
		-f "#{==:#{${_YAN_TERM_MARK}},1}" \
		-F "#{window_id}$(printf '\t')#{pane_id}$(printf '\t')#{window_name}" 2>&1) || rc=$?
	if [ "$rc" -ne 0 ]; then
		case $out in
		*"can't find session"* | *'no server running'*)
			_term_err "no such container: $sid"
			return 1
			;;
		esac
		_term_err "cannot list container $sid - tmux said: $out"
		return 1
	fi

	[ -z "$out" ] || printf '%s\n' "$out"
	return 0
}
