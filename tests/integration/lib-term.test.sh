#!/usr/bin/env bash
#
# lib-term against a real tmux server.
#
# Every session this file creates carries a name unique to the run and is torn
# down by the trap, so a failure half way through never leaves a stray session
# behind on the developer's machine. The trap uses tmux directly on purpose:
# lib-term has no way to close a container, and that is exactly the point.
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

tmp=$(mktemp -d)
run_id="yan-term-test-$$-${RANDOM}"
container="$run_id container"
lone="$run_id lone"

cleanup() {
	local s
	for s in "$container" "$lone"; do
		tmux kill-session -t "=$s" >/dev/null 2>&1 || true
	done
	rm -rf "$tmp"
}
trap cleanup EXIT

home=$tmp/home
mk_yan_home "$home"
export YAN_HOME=$home

# shellcheck source=bin/lib-term.sh
. "$YAN_REPO_ROOT/bin/lib-term.sh"

# --- helpers ---------------------------------------------------------------

# wait_until <seconds> <command...> - poll until the command succeeds.
wait_until() {
	local budget=$1 waited=0
	shift
	while [ "$waited" -lt "$((budget * 10))" ]; do
		if "$@" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1 2>/dev/null || sleep 1
		waited=$((waited + 1))
	done
	return 1
}

# Not `term_read x | grep -q needle`: under `set -o pipefail` grep -q exits on
# the first match, term_read dies of SIGPIPE, and the pipeline is then reported
# as failed even though the needle was there.
pane_has() {
	case "$(term_read "$1")" in
	*"$2"*) return 0 ;;
	*) return 1 ;;
	esac
}
verdict_is() { [ "$(term_agent_alive "$1")" = "$2" ]; }
agent_windows() { term_list "$1" | awk -F'\t' '{ print $1 }'; }
agent_panes() { term_list "$1" | awk -F'\t' '{ print $2 }'; }
agent_labels() { term_list "$1" | awk -F'\t' '{ print $3 }'; }
count_lines() { grep -c . || true; }

# --- Trace 1: create / start / list / close round-trip ---------------------

sid=$(term_container_create "$container")
assert_ne "" "$sid" "term_container_create must print a container id"
case $sid in
'$'[0-9]*) ;;
*)
	printf 'expected a tmux session id, got: %s\n' "$sid" >&2
	exit 1
	;;
esac

# Create or attach: `yan continue` calls this again for a task that is already
# open, and it has to reach the same container.
assert_eq "$sid" "$(term_container_create "$container")" "create must be idempotent"

# The container's own shell window is not an agent, so nothing is listed yet.
assert_eq "" "$(term_list "$sid")" "a fresh container has no agents"

base_window=$(tmux list-windows -t "$sid" -F '#{window_id}')
assert_ne "" "$base_window"

started=$(term_agent_start -e 'YAN_PROBE=from-tmux-env' "$sid" 's3-auth' bash --norc -i)
win=${started%% *}
pane=${started##* }
assert_ne "$win" "$pane" "term_agent_start prints a window id and a pane id"
case $win in
@[0-9]*) ;;
*)
	printf 'not a window id: %s\n' "$win" >&2
	exit 1
	;;
esac
case $pane in
%[0-9]*) ;;
*)
	printf 'not a pane id: %s\n' "$pane" >&2
	exit 1
	;;
esac

assert_eq "$win" "$(agent_windows "$sid")" "term_list reports the agent by id"
assert_eq "$pane" "$(agent_panes "$sid")"
assert_eq "s3-auth" "$(agent_labels "$sid")"
assert_ne "$base_window" "$(agent_windows "$sid")" \
	"the container's own shell window is not an agent"

# --- Trace 5: detached, so spawning never steals focus ---------------------

assert_eq "$base_window" "$(tmux display-message -p -t "$sid" '#{window_id}')" \
	"starting an agent must not make its window the active one"
assert_eq 0 "$(tmux display-message -p -t "$sid" '#{session_attached}')" \
	"neither create nor start may grab a client"

# --- Trace 3: term_send sends the text and Enter as separate steps ---------
#
# Proven by doing only the first step: the line is typed into the pane and
# nothing has run. Then the Enter on its own finishes it - which is exactly the
# retry shape td §5.4 asks for ("type the text once, and retry only the Enter").

assert_ok wait_until 30 pane_has "$pane" 'bash-'
term_send "$pane" --no-enter 'echo "probe=$YAN_PROBE"'
assert_ok wait_until 30 pane_has "$pane" 'probe=$YAN_PROBE'

typed=$(term_read "$pane")
assert_contains "$typed" 'echo "probe=$YAN_PROBE"' "the text is typed"
assert_not_contains "$typed" "probe=from-tmux-env" "and nothing has run yet"

term_send "$pane" --enter
assert_ok wait_until 30 pane_has "$pane" 'probe=from-tmux-env'

# -e really reaches the pane. A pane inherits the tmux SERVER's environment,
# not the caller's, so this is the only way YAN_TASK_DIR will ever get there.
assert_contains "$(term_read "$pane")" "probe=from-tmux-env"

# Scrollback is reachable, which is what supervision reads.
assert_ok term_read "$pane" 200

# --- Trace 2: ids, never labels --------------------------------------------
#
# tmux is perfectly happy to have two windows with the same name. Start a second
# agent with the SAME label, close one by id, and prove the other is untouched:
# a lookup by name could not have told them apart.

twin=$(term_agent_start "$sid" 's3-auth' sleep 600)
twin_win=${twin%% *}
assert_ne "$win" "$twin_win"
assert_eq 2 "$(agent_windows "$sid" | count_lines)" "two agents, one label"
assert_eq 2 "$(agent_labels "$sid" | grep -c '^s3-auth$')" "and tmux allows it"

term_agent_close "$twin_win"
assert_eq dead "$(term_agent_alive "$twin_win")"
assert_eq "$win" "$(agent_windows "$sid")" \
	"the agent that was not named must survive, id by id"

# --- Trace 4: close exactly one agent, never the container -----------------

assert_ok tmux has-session -t "=$container"
assert_eq "$base_window" "$(tmux list-windows -t "$sid" -F '#{window_id}' | grep -Fx "$base_window")" \
	"the container's own window survives an agent being closed"

# Closing something already closed is the state being asked for, not an error.
assert_ok term_agent_close "$twin_win"

# The refusal that keeps the promise honest: tmux destroys a session together
# with its last window, so closing the last window would close the container by
# the back door.
lone_sid=$(term_container_create "$lone")
lone_win=$(tmux list-windows -t "$lone_sid" -F '#{window_id}')
capture term_agent_close "$lone_win"
assert_ne 0 "$rc" "closing the last window in a container must be refused"
assert_contains "$out" "refusing to close"
assert_contains "$out" "destroy the container"
assert_ok tmux has-session -t "=$lone"
tmux kill-session -t "=$lone"

# --- Trace 6: alive | dead | unknown, and nothing else ---------------------

assert_eq alive "$(term_agent_alive "$win")" "a running agent is alive"
assert_eq alive "$(term_agent_alive "$pane")" "the pane id answers the same"

# A window that no longer exists, and ids that never existed.
assert_eq dead "$(term_agent_alive "$twin_win")"
assert_eq dead "$(term_agent_alive '@99999')"
assert_eq dead "$(term_agent_alive '%99999')"

# A window whose process exited. term_agent_start sets remain-on-exit, so the
# pane stays behind with its scrollback - which is how "the agent died" is told
# apart from "the agent was closed", and how anyone finds out why.
short=$(term_agent_start "$sid" 'shortlived' bash --norc -c 'echo LASTWORDS; sleep 1')
short_win=${short%% *}
short_pane=${short##* }
assert_ok wait_until 60 verdict_is "$short_win" dead
# When a pane dies tmux scrolls what was on screen into the pane's history and
# paints a notice in its place, so the agent's last words are one argument away.
assert_contains "$(term_read "$short_pane" 200)" "LASTWORDS" \
	"a dead agent's pane must still be readable"
term_agent_close "$short_win"

# The third verdict. tmux cannot be asked at all, so the honest answer is that
# we do not know - never `alive`.
bash_bin=$(command -v bash)
empty=$tmp/empty-path
mkdir -p "$empty"
capture env YAN_HOME="$home" PATH="$empty" "$bash_bin" -c \
	". \"$YAN_REPO_ROOT/bin/lib-term.sh\"; term_agent_alive '$win'"
assert_contains "$out" unknown
assert_not_contains "$out" alive

# Everything this seam can answer is one of the three words.
for v in \
	"$(term_agent_alive "$win")" \
	"$(term_agent_alive "$win" bash)" \
	"$(term_agent_alive "$win" definitely-not-running)" \
	"$(term_agent_alive "$twin_win")"; do
	case $v in
	alive | dead | unknown) ;;
	*)
		printf 'term_agent_alive answered outside the closed set: %s\n' "$v" >&2
		exit 1
		;;
	esac
done

# --- an agent starts where it was told to ----------------------------------

workdir=$tmp/workdir
mkdir -p "$workdir"
cwd_agent=$(term_agent_start -c "$workdir" "$sid" 'in-a-worktree' bash --norc -i)
cwd_pane=${cwd_agent##* }
assert_ok wait_until 30 pane_has "$cwd_pane" 'bash-'
term_send "$cwd_pane" 'pwd'
assert_ok wait_until 30 pane_has "$cwd_pane" 'workdir'
term_agent_close "${cwd_agent%% *}"

# --- the container outlives every agent ------------------------------------

term_agent_close "$win"
assert_eq "" "$(term_list "$sid")" "no agents left"
assert_ok tmux has-session -t "=$container"

printf 'ok\n'
