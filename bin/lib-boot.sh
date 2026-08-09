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

# The soft path's own checks (node, the pinned @clack/prompts) reuse the code
# that launches it, so "where is node?" has one answer rather than two that can
# drift apart.
#
# Sourced only when there is a home to find it in. Unlike a subcommand, this
# library is deliberately usable on its own - a test may source it with no
# $YAN_HOME at all, and `boot_config_path` is written to say so rather than to
# crash - while `yan doctor`, the only caller of boot_doctor, always has one.
if [ -n "${YAN_LIB:-}" ] || [ -n "${YAN_HOME:-}" ]; then
	# shellcheck source=bin/lib-ui.sh
	. "${YAN_LIB:-$YAN_HOME/bin}/lib-ui.sh"
fi

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
	boot_check_git_identity
}

# A commit identity every shift can see.
#
# Every shift commits, and it commits in a LEASED WORKTREE under
# ~/.yan-trees - not in this checkout and not in the main clone. A repository
# whose identity is only in its own .git/config therefore gives a shift
# nothing, and `git commit` fails with "Please tell me who you are" after the
# work is already done. Only a global (or system) identity reaches a worktree.
#
# This is not hypothetical: on the machine yan was built on, Git Bash had no
# global identity at all - the checkout had a local one, which read as fine
# from here and was invisible to every tree the pool handed out.
#
# yan does not fix this itself. Writing git config is `user`'s decision, and
# the only place yan could write it is the main clone, which Appendix B makes
# read-only apart from `git fetch`. So doctor reports it and says what to run.
boot_check_git_identity() {
	local name email
	boot_have git || return 0

	# --global, deliberately: reading it from inside this repository would find
	# the checkout's own local value and report a healthy identity that no
	# leased worktree can see.
	name=$(git config --global user.name 2>/dev/null) || name=
	email=$(git config --global user.email 2>/dev/null) || email=
	if [ -z "$name" ]; then
		name=$(git config --system user.name 2>/dev/null) || name=
	fi
	if [ -z "$email" ]; then
		email=$(git config --system user.email 2>/dev/null) || email=
	fi

	if [ -n "$name" ] && [ -n "$email" ]; then
		boot_report ok "git identity" "$name <$email>"
		return 0
	fi
	boot_report fail "git identity" \
		"no global user.name/user.email - every shift commits in a leased worktree, which sees only the global config, so its commit would fail after the work is done. Run: git config --global user.name '<you>' && git config --global user.email '<you@example.com>'"
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

# boot_check_soft_path - node and the pinned @clack/prompts install.
#
# Both are WARN, never FAIL, and the reason is the split in cli-ux.md §2: the
# soft path is for `user`, and everything an agent runs is shell. A machine
# with no node at all can still carry a task from `yan task new --title ...`
# to the outbound MR; it just cannot be asked questions. Failing here would
# make node a hard dependency of a tool that deliberately does not have one.
#
# The message has to name the fix, because node_modules/ is gitignored and so
# "not installed yet" is the ordinary state of a fresh clone - the soft path
# must say `run the install`, never hand `user` a module-resolution stack
# trace (cli-ux.md §2).
boot_check_soft_path() {
	local node ui version
	if ! command -v ui_node >/dev/null 2>&1; then
		boot_report warn "soft path" "not checked - lib-ui.sh was not loaded (no YAN_HOME when this library was sourced)"
		return 0
	fi
	ui=$(ui_dir)

	if node=$(ui_node); then
		version=$("$node" --version 2>/dev/null || printf 'present')
		if [ "$node" = "$(command -v node 2>/dev/null || printf '%s' "$node")" ]; then
			boot_report ok "node" "$version ($node)"
		else
			boot_report warn "node" "$version at $node, but NOT on PATH - export YAN_NODE, or source nvm before running yan"
		fi
	else
		boot_report warn "node" "not on PATH - only the ui/ soft path needs it. Without it, prompts are skipped and every command needs its flags"
	fi

	if [ ! -f "$ui/soft-path.mjs" ]; then
		boot_report warn "soft path" "$ui/soft-path.mjs is missing - the interactive prompts are not installed"
	elif ui_clack_dir >/dev/null 2>&1; then
		boot_report ok "@clack/prompts" "$(ui_clack_dir)"
	else
		boot_report warn "@clack/prompts" "not installed - $(ui_install_hint)"
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

	printf '\nsoft path (ui/, for `user` only)\n'
	boot_check_soft_path

	printf '\n%d ok, %d warn, %d failed\n' "$_boot_ok" "$_boot_warn" "$_boot_fail"
	if [ "$_boot_fail" -gt 0 ]; then
		return 1
	fi
}
