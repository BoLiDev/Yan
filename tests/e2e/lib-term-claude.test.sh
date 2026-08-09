#!/usr/bin/env bash
#
# lib-term driving the real `claude` CLI. Opt-in: tests/run.sh --e2e.
#
# This is the only test that can prove the winpty handling, and it is the reason
# term_agent_start branches on the platform at all. A native Windows console
# program started in an MSYS2 tmux pane is handed a pipe instead of a console:
# raw `claude` in such a pane dies immediately with "Input must be provided
# either through stdin or as a prompt argument when using --print", and no unit
# test can see that, because nothing about the command line is wrong. Only a
# real agent CLI in a real pane can tell the difference.
#
# One trivial prompt, and the reply has to come back through term_read.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

if ! command -v tmux >/dev/null 2>&1; then
	printf 'SKIP  tmux is not on PATH\n'
	exit 0
fi

# On Linux claude is installed through nvm, which a non-interactive shell has
# not sourced (conventions §1).
if ! command -v claude >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
	# shellcheck source=/dev/null
	. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
if ! command -v claude >/dev/null 2>&1; then
	printf 'SKIP  claude is not on PATH - install the Claude Code CLI to run this test\n'
	exit 0
fi

tmp=$(mktemp -d)
run_id="yan-term-e2e-$$-${RANDOM}"
container="$run_id claude"

cleanup() {
	tmux kill-session -t "=$container" >/dev/null 2>&1 || true
	# The agent holds its working directory open, so give it a moment to go.
	sleep 1 2>/dev/null || true
	rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup EXIT

home=$tmp/home
mk_yan_home "$home"
export YAN_HOME=$home
workdir=$tmp/work
mkdir -p "$workdir"

# shellcheck source=bin/lib-term.sh
. "$YAN_REPO_ROOT/bin/lib-term.sh"

screen() { term_read "$1" 200; }

# No pipe into grep here, deliberately. `term_read x | grep -q needle` looks
# obvious and is a trap under `set -o pipefail`: grep -q exits the moment it
# matches, term_read dies of SIGPIPE, and pipefail then reports the pipeline as
# failed even though the needle was found. It only bites when the match is early
# and the output is long enough to still be in flight - which is to say, on
# Windows and not on Linux.
screen_has() {
	case "$(screen "$1")" in
	*"$2"*) return 0 ;;
	*) return 1 ;;
	esac
}

# wait_for <seconds> <pane> <text> - poll the pane until the text shows up.
# Answers the trust prompt on the way past, if claude puts one up.
wait_for() {
	local budget=$1 pane=$2 needle=$3 waited=0 trusted=0
	while [ "$waited" -lt "$budget" ]; do
		if screen_has "$pane" "$needle"; then
			return 0
		fi
		if [ "$trusted" -eq 0 ] && screen_has "$pane" 'I trust this folder'; then
			term_send "$pane" --enter
			trusted=1
		fi
		sleep 2
		waited=$((waited + 2))
	done
	return 1
}

sid=$(term_container_create "$container")

# The seam adds the winpty wrapper on Windows and leaves the command alone on
# Linux; the caller only says what it wants started.
if [ "$(boot_platform)" = windows ]; then
	started=$(term_agent_start -c "$workdir" "$sid" 'claude' claude)
else
	started=$(term_agent_start -c "$workdir" "$sid" 'claude' \
		bash -lc '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; exec claude')
fi
win=${started%% *}
pane=${started##* }
printf 'started claude as %s in container %s\n' "$started" "$sid"

# The whole point: a TUI that only renders when it has a real terminal.
if ! wait_for 150 "$pane" 'for shortcuts'; then
	printf 'claude never came up. What the pane showed:\n' >&2
	screen "$pane" >&2
	exit 1
fi
printf 'the claude TUI rendered\n'

# The signature of the failure this test exists to catch. Seeing it means the
# process was handed a pipe instead of a console and gave up.
assert_not_contains "$(screen "$pane")" "Input must be provided" \
	"the agent must not fall back to non-interactive mode - the pane has no TTY"

assert_eq alive "$(term_agent_alive "$win")" "a claude that is up must read as alive"

# Drive it. The answer is deliberately not a substring of the question, so
# finding it in the pane cannot be the echo of what was typed.
term_send "$pane" 'what is 111 plus 222? reply with the number only'
if ! wait_for 240 "$pane" '333'; then
	printf 'no reply from claude. What the pane showed:\n' >&2
	screen "$pane" >&2
	exit 1
fi
printf 'claude answered through term_read\n'

assert_contains "$(screen "$pane")" "what is 111 plus 222" "the prompt was typed"
assert_eq alive "$(term_agent_alive "$win")"

# And it closes like any other agent: one window, not the container.
term_agent_close "$win"
assert_eq dead "$(term_agent_alive "$win")"
assert_eq "" "$(term_list "$sid")"
assert_ok tmux has-session -t "=$container"

printf 'ok\n'
