# shellcheck shell=bash
#
# lib-ui.sh - the one door from the shell into the human soft path
# (td cli-ux.md §1-§2, architecture.md §2).
#
# ---------------------------------------------------------------------------
# WHAT THIS IS, AND WHAT IT IS NOT
# ---------------------------------------------------------------------------
#
# `ui/` is Node plus @clack/prompts, and it exists FOR PEOPLE ONLY. It collects
# answers and then runs `yan <cmd>` with full flags; it writes no task.json, it
# opens no container, it decides nothing (cli-ux.md §2). Agents never touch it:
# they already know the arguments, so they take the hard path, and nothing in
# `bin/` requires node except the two lines in this file.
#
# The soft/hard rule this file implements, from cli-ux.md §1:
#
#   soft   stdin is a TTY  AND  a required value is missing  -> prompt
#   hard   every required flag is present, OR there is no TTY -> no prompts.
#          Missing values with no TTY is a REFUSAL that names the flags.
#
# The refusal is the important half. A script, a hook or an agent that reaches
# a prompt would hang forever with nobody to answer it, so "there is no TTY" is
# checked before "a value is missing", and it always wins.
#
# ---------------------------------------------------------------------------
# FINDING NODE
# ---------------------------------------------------------------------------
#
# conventions.md §1: node is on PATH under Git Bash, but on Linux it usually
# comes from nvm, which only puts it on PATH from an interactive shell's
# profile. A `yan` started by a hook, by tmux, or by a test therefore sees no
# node at all even though the machine has one. ui_node looks in three places,
# in order: $YAN_NODE, PATH, then nvm's own installation directory.
#
# The third one READS nvm's directory rather than sourcing `nvm.sh`. Sourcing
# it would run several hundred lines of someone else's shell code inside a
# script with `set -euo pipefail`, to learn one path we can simply look at.
#
# Everything here fails soft: no node, or no @clack/prompts installed, must
# produce one clear sentence telling `user` what to run - never a stack trace
# and never a hang (node_modules/ is gitignored, so "not installed yet" is the
# ordinary state of a fresh clone).

if [ -n "${_YAN_LIB_UI_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_UI_SOURCED=1

_ui_err() {
	printf 'yan ui: %s\n' "$1" >&2
}

# ui_dir - where the soft path lives. Never under bin/ (architecture.md §3).
ui_dir() {
	printf '%s/ui\n' "${YAN_HOME:?lib-ui: YAN_HOME is not set}"
}

# ui_is_tty - can a person answer a prompt right now?
#
# stdin only. stdout is often a pipe even for a person (`yan ls | less`), and
# it is stdin that a prompt reads from.
ui_is_tty() {
	[ -t 0 ]
}

# ui_node - print the node binary to use, or fail quietly.
ui_node() {
	local n
	if [ -n "${YAN_NODE:-}" ] && [ -x "$YAN_NODE" ]; then
		printf '%s\n' "$YAN_NODE"
		return 0
	fi
	if n=$(command -v node 2>/dev/null) && [ -n "$n" ]; then
		printf '%s\n' "$n"
		return 0
	fi
	n=$(_ui_nvm_node) || n=
	if [ -n "$n" ]; then
		printf '%s\n' "$n"
		return 0
	fi
	return 1
}

# _ui_nvm_node - the newest node nvm has installed, if any.
#
# `sort -V` orders v9 before v10; a plain sort would not, and picking an old
# node for @clack/prompts (which wants >= 20.12) is the failure that would
# look like a broken prompt rather than a wrong path.
_ui_nvm_node() {
	local dir n
	dir=${NVM_DIR:-$HOME/.nvm}/versions/node
	[ -d "$dir" ] || return 1
	n=$(
		shopt -s nullglob
		list=("$dir"/*/bin/node)
		[ "${#list[@]}" -gt 0 ] || exit 1
		printf '%s\n' "${list[@]}" | LC_ALL=C sort -V | tail -n 1
	) || return 1
	[ -n "$n" ] && [ -x "$n" ] || return 1
	printf '%s\n' "$n"
}

# ui_clack_dir - the pinned @clack/prompts install, when it is there.
ui_clack_dir() {
	local d
	d=$(ui_dir)/node_modules/@clack/prompts
	[ -d "$d" ] || return 1
	printf '%s\n' "$d"
}

# ui_install_hint - the one sentence that gets a person unstuck.
ui_install_hint() {
	printf "run: (cd %s && npm install)\n" "$(ui_dir)"
}

# ui_why_unavailable - why the soft path cannot run, or nothing when it can.
ui_why_unavailable() {
	local d
	d=$(ui_dir)
	if [ ! -f "$d/soft-path.mjs" ]; then
		printf 'the soft path is not installed: %s/soft-path.mjs is missing\n' "$d"
		return 0
	fi
	if ! ui_node >/dev/null 2>&1; then
		printf 'node was not found, and the interactive prompts need it - install Node 20.12 or newer, or point YAN_NODE at one (PATH and $NVM_DIR were both looked in)\n'
		return 0
	fi
	if ! ui_clack_dir >/dev/null 2>&1; then
		printf '@clack/prompts is not installed - %s' "$(ui_install_hint)"
		return 0
	fi
}

# ui_available - can we prompt at all? Silent; ui_why_unavailable explains.
ui_available() {
	[ -z "$(ui_why_unavailable)" ]
}

# ui_run <command> [args...] - hand over to the soft path.
#
# It REPLACES this process (exec), because the soft path's last act is to run
# `yan <cmd>` with the full set of flags and that command's exit status is the
# one `user` should see. YAN_UI=1 marks the descendant so that a soft path can
# never re-enter itself: the child has every flag it needs and must take the
# hard path even on a TTY.
ui_run() {
	local node d
	d=$(ui_dir)
	if ! node=$(ui_node); then
		_ui_err "$(ui_why_unavailable)"
		return 1
	fi
	exec env \
		YAN_HOME="$YAN_HOME" \
		YAN_UI=1 \
		YAN_BIN="${YAN_BIN:-$YAN_HOME/bin/yan}" \
		YAN_UI_SHELL="${BASH:-bash}" \
		"$node" "$d/soft-path.mjs" "$@"
}

# ui_soft_path_wanted - true when this invocation should prompt.
#
# The whole rule in one place so that no subcommand has to re-derive it:
# a person is at the keyboard, a required value is missing, we are not already
# inside a soft path, and the prompts can actually run.
ui_soft_path_wanted() {
	[ -z "${YAN_UI:-}" ] || return 1
	ui_is_tty || return 1
	ui_available
}
