#!/usr/bin/env bash
#
# Phase 5 Trace bullets 2 and 3 against a real tmux server:
#
#   `yan send` types the text once and can retry the Enter alone;
#   `yan state` reports what the terminal says, not what run/status said last.
#
# Every session created here carries a name unique to the run and is killed by
# the trap, so a failure half way through never leaves a stray session behind
# on the developer's machine.
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
container="yan-send-state-$$-${RANDOM}"

cleanup() {
	tmux kill-session -t "=$container" >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT

home=$tmp/home
mk_yan_home "$home"
YAN_HOME=$home
export YAN_HOME
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
# shellcheck source=bin/lib-term.sh
. "$YAN_REPO_ROOT/bin/lib-term.sh"

# Not `term_read x | grep -q needle`: under `set -o pipefail` grep -q exits on
# the first match, term_read dies of SIGPIPE, and the pipeline is reported as
# failed even though the needle was there (conventions; Phase 3 paid for this).
pane_has() {
	case "$(term_read "$1")" in
	*"$2"*) return 0 ;;
	*) return 1 ;;
	esac
}

verdict_is() { [ "$(term_agent_alive "$1")" = "$2" ]; }

wait_until() { # <seconds> <command...>
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

# --- a live agent in a real container --------------------------------------

sid=$(term_container_create "$container")
started=$(term_agent_start -e 'YAN_SEND_PROBE=through-yan-send' "$sid" 'shift-s1' bash --norc -i)
pane=${started##* }
wait_until 10 pane_has "$pane" '$' || printf 'note: the shell prompt never appeared\n' >&2

# --- the shift's bookkeeping, with a misleading run/status -----------------

task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth

run=$home/tasks/t042/shifts/s1/run
mkdir -p "$run"
cat >"$run/meta.json" <<JSON
{ "version": 1,
  "unit": "auth",
  "branch": "yan/t042/s1",
  "tree": "",
  "agent": "bash",
  "window": "${started%% *}",
  "pane": "$pane" }
JSON

# The newest event says the shift is finished. The agent is sitting right there.
printf '2026-08-09T11:00:00Z\tdone\tLAST-LINE-IS-NOT-THE-STATE\n' >"$run/status"

capture bash "$yan" state s1 --verdict
assert_eq 0 "$rc" "$out"
assert_eq running "$out" 'the live pane is the source of truth, not the last event'

capture bash "$yan" state s1
assert_not_contains "$out" 'LAST-LINE-IS-NOT-THE-STATE'

# --- send: type once, press Enter separately -------------------------------
#
# The typed line and the line the shell prints when it runs are deliberately
# different strings, so "it was typed" and "it was submitted" can be told
# apart: before Enter the pane holds the literal `$YAN_SEND_PROBE`, after Enter
# it holds what the shell expanded it to.

capture bash "$yan" send s1 --no-enter 'echo "yan=$YAN_SEND_PROBE"'
assert_eq 0 "$rc" "$out"
wait_until 10 pane_has "$pane" 'yan=$YAN_SEND_PROBE' || {
	printf 'the text was never typed into the pane\n' >&2
	exit 1
}
if pane_has "$pane" 'yan=through-yan-send'; then
	printf 'the line ran without an Enter being sent\n' >&2
	exit 1
fi

capture bash "$yan" send s1 --enter
assert_eq 0 "$rc" "$out"
wait_until 10 pane_has "$pane" 'yan=through-yan-send' || {
	printf 'the Enter alone did not submit the line that was already typed\n' >&2
	exit 1
}

# One line, typed once: the retry did not type it a second time.
typed=$(term_read "$pane" 200 | grep -c 'yan=\$YAN_SEND_PROBE' || true)
assert_eq 1 "$typed" 'the text was typed exactly once'

# --- a plain send is the same two steps in one call ------------------------

capture bash "$yan" send s1 'echo one-shot-probe'
assert_eq 0 "$rc" "$out"
wait_until 10 pane_has "$pane" 'one-shot-probe' || {
	printf 'a plain send did not reach the pane\n' >&2
	exit 1
}

# --- the agent goes away; the file has not changed at all ------------------

term_agent_close "$pane"
wait_until 10 verdict_is "$pane" dead || true

capture bash "$yan" state s1 --verdict
assert_eq dead "$out" 'the same run/status, a different answer, because the terminal changed'

capture bash "$yan" send s1 'anyone there?'
assert_ne 0 "$rc" 'sending to an agent that is gone fails loudly'

printf 'ok\n'
