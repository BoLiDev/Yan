#!/usr/bin/env bash
#
# Phase 8 Trace bullet 1 against a REAL tmux server: the two sources that go
# through the terminal seam.
#
#   the pane's content hash stops changing   -> stuck
#   the agent is gone                        -> died
#
# The stub proves the logic; this proves the seam. An idle agent pane really
# does hash the same way twice in a row, and a closed agent really does make
# term_agent_alive say `dead` - neither is obvious from a stand-in that was
# programmed to say so.
#
# The session this creates is named for the run and killed in a trap, so a
# failure half way through leaves nothing behind.
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
container="yan-wait-test-$$-${RANDOM}"

cleanup() {
	tmux kill-session -t "=$container" >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT

home=$tmp/home
mk_yan_home "$home"
YAN_HOME=$home
export YAN_HOME
export YAN_TASK=t1
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
# shellcheck source=bin/lib-term.sh
. "$YAN_REPO_ROOT/bin/lib-term.sh"

task_init t1 'supervision on real tmux'

sid=$(term_container_create "$container")
ids=$(term_agent_start "$sid" 's1' bash --norc -i)
window=${ids%% *}
pane=${ids##* }

run=$home/tasks/t1/shifts/s1/run
mkdir -p "$run"
jq -nc --arg w "$window" --arg p "$pane" --arg c "$sid" \
	'{version: 1, sid: "s1", unit: "u", branch: "yan/t1/s1", agent: "bash",
	  container: $c, window: $w, pane: $p, mr: ""}' >"$run/meta.json"

wake=$home/tasks/t1/run/wake

# Not `term_read | grep -q`: under pipefail the producer takes SIGPIPE when
# grep stops early and the pipeline reports failure despite the match.
pane_has() {
	case "$(term_read "$1")" in
	*"$2"*) return 0 ;;
	*) return 1 ;;
	esac
}
wait_until() {
	local budget=$1 waited=0
	shift
	while [ "$waited" -lt "$budget" ]; do
		if "$@" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1 2>/dev/null || sleep 1
		waited=$((waited + 1))
	done
	return 1
}

# The agent has booted and its pane has settled.
assert_ok wait_until 300 pane_has "$pane" 'bash-'

# --- source 3: a real pane that has stopped changing ------------------------

capture "$yan" wait --seconds 20 --interval 0.3 --stuck 2
assert_eq 0 "$rc" 'an idle agent pane is the stuck source'
assert_contains "$out" 'stuck: s1'
assert_contains "$(cat "$wake")" 'stuck: s1'

# The watcher left nothing of its own behind: the lock is released and the
# beacon is only a timestamp.
assert_file_missing "$home/tasks/t1/run/wait.lock"
capture "$yan" drain t1
assert_eq 0 "$rc"
assert_contains "$out" 'stuck: s1'

# --- source 2: the agent is really gone -------------------------------------

agent_dead() { [ "$(term_agent_alive "$1")" = dead ]; }
term_agent_close "$pane"
assert_ok wait_until 300 agent_dead "$pane"

capture "$yan" wait --seconds 20 --interval 0.3 --stuck 3600
assert_eq 0 "$rc" 'a closed agent is the died source'
assert_contains "$out" 'died: s1'

printf 'ok\n'
