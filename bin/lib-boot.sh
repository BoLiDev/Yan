# shellcheck shell=bash
#
# lib-boot.sh - hard dependency checks.
#
# `bin/yan` itself only checks the two universal dependencies (git, jq) inline,
# because that runs on every single invocation and has to stay free. Everything
# that costs a subprocess - the forge CLI, its auth state, the terminal backend,
# node - lives here and runs only when `yan doctor` asks for it.
#
# One rule from delivery.md §8.4: only the CLI selected by forge.kind is
# checked. Never both.

if [ -n "${_YAN_LIB_BOOT_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_BOOT_SOURCED=1

_boot_ok=0
_boot_warn=0
_boot_fail=0

boot_have() { command -v "$1" >/dev/null 2>&1; }

# boot_platform - `windows` on Git Bash / MSYS2 / Cygwin, `linux` elsewhere.
#
# The distinction is not cosmetic: on Windows a native console program started
# inside an MSYS2 tmux pane gets no TTY and has to be wrapped in winpty.
boot_platform() {
	case "$(uname -s 2>/dev/null)" in
	MINGW* | MSYS* | CYGWIN*) printf 'windows\n' ;;
	*) printf 'linux\n' ;;
	esac
}

boot_config_path() { printf '%s/conf/config.json\n' "${YAN_HOME:?lib-boot: YAN_HOME is not set}"; }

# boot_report <ok|warn|fail> <label> <detail>
boot_report() {
	case $1 in
	ok)
		_boot_ok=$((_boot_ok + 1))
		printf '  ok    %-20s %s\n' "$2" "$3"
		;;
	warn)
		_boot_warn=$((_boot_warn + 1))
		printf '  warn  %-20s %s\n' "$2" "$3"
		;;
	*)
		_boot_fail=$((_boot_fail + 1))
		printf '  FAIL  %-20s %s\n' "$2" "$3"
		;;
	esac
}

# boot_config_get <jq-filter> <default>
boot_config_get() {
	local cfg v
	cfg=$(boot_config_path)
	if [ -f "$cfg" ] && v=$(jq -r "$1 // empty" "$cfg" 2>/dev/null) && [ -n "$v" ]; then
		printf '%s\n' "$v"
	else
		printf '%s\n' "$2"
	fi
}

# boot_check_core - git and jq. Also used inline (open-coded) by bin/yan.
boot_check_core() {
	local c
	for c in git jq; do
		if boot_have "$c"; then
			boot_report ok "$c" "$(command -v "$c")"
		else
			boot_report fail "$c" "not on PATH - install $c and retry"
		fi
	done
}

boot_check_config() {
	local cfg
	cfg=$(boot_config_path)
	if [ ! -f "$cfg" ]; then
		boot_report fail "conf/config.json" "missing - copy conf/config.sample.json to $cfg"
		return 0
	fi
	if jq empty "$cfg" >/dev/null 2>&1; then
		boot_report ok "conf/config.json" "$cfg"
	else
		boot_report fail "conf/config.json" "not valid JSON: $cfg"
	fi
}

# boot_check_forge - checks exactly one CLI, the one forge.kind names.
boot_check_forge() {
	local kind host
	kind=$(boot_config_get '.forge.kind' '')
	host=$(boot_config_get '.forge.host' '')

	case $kind in
	github)
		if boot_have gh; then
			boot_report ok "forge (github)" "$(command -v gh)"
		else
			boot_report fail "forge (github)" "gh not on PATH - install the GitHub CLI (https://cli.github.com)"
		fi
		;;
	gitlab)
		if ! boot_have glab; then
			boot_report fail "forge (gitlab)" "glab not on PATH - install the GitLab CLI (https://gitlab.com/gitlab-org/cli)"
			return 0
		fi
		boot_report ok "forge (gitlab)" "$(command -v glab)"
		if [ -z "$host" ]; then
			boot_report fail "forge.host" "required when forge.kind is gitlab (hostname, no scheme)"
			return 0
		fi
		if glab auth status --hostname "$host" >/dev/null 2>&1; then
			boot_report ok "forge auth" "glab is authenticated for $host"
		else
			boot_report fail "forge auth" "run: glab auth login --hostname $host"
		fi
		;;
	'')
		boot_report fail "forge.kind" "not set in $(boot_config_path) - use github or gitlab"
		;;
	*)
		boot_report fail "forge.kind" "unknown value '$kind' - use github or gitlab"
		;;
	esac
}

# boot_check_backend - tmux only in the MVP; herdr fails closed.
boot_check_backend() {
	local backend
	backend=$(boot_config_get '.backend' 'tmux')
	case $backend in
	tmux)
		if boot_have tmux; then
			boot_report ok "backend (tmux)" "$(command -v tmux)"
		else
			boot_report fail "backend (tmux)" "tmux not on PATH - install tmux"
		fi
		;;
	herdr)
		boot_report fail "backend (herdr)" "herdr is not implemented in the MVP - set backend to tmux in $(boot_config_path)"
		;;
	*)
		boot_report fail "backend" "unknown value '$backend' - the MVP supports tmux only"
		;;
	esac
}

boot_check_agents() {
	local a which
	for which in yan shift; do
		a=$(boot_config_get ".agents.\"$which\"" '')
		if [ -z "$a" ]; then
			boot_report fail "agents.$which" "not set in $(boot_config_path)"
		elif boot_have "$a"; then
			boot_report ok "agents.$which" "$a ($(command -v "$a"))"
		else
			boot_report warn "agents.$which" "'$a' is not on PATH yet"
		fi
	done
}

# boot_check_platform - the Windows-only requirement.
#
# A native Windows CLI (claude.exe, codex.exe, gh.exe) launched inside an
# MSYS2 tmux pane is handed a pipe, not a console. It sees no TTY, silently
# decides it is non-interactive, and exits. `winpty <cmd>` allocates the
# pseudo console that makes it behave. Phase 3's spawn path depends on this.
boot_check_platform() {
	local platform
	platform=$(boot_platform)
	boot_report ok "platform" "$platform ($(uname -s 2>/dev/null || printf 'unknown'))"
	[ "$platform" = windows ] || return 0

	if boot_have winpty; then
		boot_report ok "winpty" "$(command -v winpty) - agent CLIs must be spawned as: winpty <cmd>"
	else
		boot_report fail "winpty" "not on PATH. On Windows an agent CLI started inside an MSYS2 tmux pane gets no TTY and exits immediately; it must run as 'winpty <cmd>'. Install it with the Git for Windows toolchain (pacman -S winpty)"
	fi
}

# boot_check_optional - node is listed but not required until Phase 9.
boot_check_optional() {
	if boot_have node; then
		boot_report ok "node" "$(node --version 2>/dev/null || printf 'present')"
	else
		boot_report warn "node" "not on PATH - only the ui/ soft path needs it (Phase 9)"
	fi
}

# boot_doctor - the whole checklist. Non-zero when any hard check failed.
boot_doctor() {
	_boot_ok=0
	_boot_warn=0
	_boot_fail=0

	printf 'yan doctor\n'
	printf '  YAN_HOME  %s\n' "${YAN_HOME:-<unset>}"

	printf '\nrequired\n'
	boot_check_core

	printf '\nconfiguration\n'
	boot_check_config
	boot_check_agents

	printf '\nforge\n'
	boot_check_forge

	printf '\nbackend\n'
	boot_check_backend
	boot_check_platform

	printf '\noptional\n'
	boot_check_optional

	printf '\n%d ok, %d warn, %d failed\n' "$_boot_ok" "$_boot_warn" "$_boot_fail"
	if [ "$_boot_fail" -gt 0 ]; then
		return 1
	fi
}
