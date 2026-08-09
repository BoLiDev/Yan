#!/usr/bin/env bash
#
# Phase 7 Trace bullets 3 and 4:
#
#   hard `yan continue --task <id>` creates/attaches the task container and
#   starts agents.yan
#   a second yan on the same task is refused
#
# The second one is td agents.md §5.2's rule, and its exact shape matters: the
# lock is per TASK, not per home. Two yans on two different tasks is normal
# working practice and must not be refused, so that case is checked too.
#
# The terminal is the stand-in that records calls, so "no second agent was
# started" is an assertion about the call log rather than about a screenshot.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

home=$tmp/home
mk_yan_home "$home"
cp "$YAN_REPO_ROOT/tests/stub/lib-term.sh" "$home/bin/lib-term.sh"

export YAN_HOME=$home
yan=$home/bin/yan

calls=$tmp/calls
export YAN_STUB_TERM_DIR=$calls

# The recorded calls, and nothing on stderr when there are none yet: a run that
# records nothing at all is a perfectly good expectation here.
clog() { cat "$calls/calls" 2>/dev/null || true; }

mkdir -p "$home/repos/monorepo-x" "$home/repos/proto"

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth
task_unit_add t042 proto proto master --branch feat/proto
task_init t099 'something else entirely'
task_unit_add t099 api monorepo-x master --branch feat/api

# --- the hard path: create the container and start yan ----------------------

capture bash "$yan" continue --task t042
assert_eq 0 "$rc" "$out"
assert_contains "$out" 'started'

log=$(clog)
order=$(printf '%s\n' "$log" | sed -n 's/^\([a-z_]*\).*/\1/p' | tr '\n' ' ')
assert_eq 'container_create list agent_start ' "$order" \
	'create or attach the container, ask what is running, then start'

assert_contains "$log" 'container_create name=t042 unify the auth header' \
	'one container per task, and the name is the task'

start=$(printf '%s\n' "$log" | grep '^agent_start ')
assert_contains "$start" 'label=yan'
assert_contains "$start" "dir=$home" \
	'the working directory is $YAN_HOME, because yan runs bin/ and reads mem/'
assert_contains "$start" 'YAN_TASK=t042'
assert_contains "$start" "cmd=claude --add-dir $home/repos/monorepo-x --add-dir $home/repos/proto" \
	'each --add-dir is a clone this task touches; anything else is invisible to it'

# --- a second yan on the SAME task is refused -------------------------------
#
# The terminal now reports a live agent labelled yan in the container, which is
# exactly what it would report after the call above.

rm -f "$calls/calls"
YAN_STUB_TERM_LIST="@1$(printf '\t')%1$(printf '\t')yan
"
export YAN_STUB_TERM_LIST
export YAN_STUB_TERM_ALIVE=alive

capture bash "$yan" continue --task t042
assert_eq 0 "$rc" "$out"
assert_contains "$out" 'a second yan on the same task is refused'
assert_contains "$out" 'tmux attach'
assert_not_contains "$(clog)" 'agent_start' \
	'attaching is preferred over spawning a duplicate (cli-ux.md §4)'

capture bash "$yan" continue --task t042 --json
assert_eq 0 "$rc" "$out"
assert_eq false "$(printf '%s' "$out" | jq -r .started)"
assert_eq true "$(printf '%s' "$out" | jq -r .attached)"
assert_eq '%1' "$(printf '%s' "$out" | jq -r .pane)" 'the id comes from the terminal, never a label'

# --- two yans on two DIFFERENT tasks is not refused -------------------------
#
# The lock is per TASK, not per home. This is the half of td §5.2's rule that
# is easy to get wrong by locking $YAN_HOME instead, and getting it wrong would
# serialise every task on one machine.
#
# t042's lock is held by this very process, so it cannot be mistaken for a
# stale one. A zero timeout turns "wait for it" into "try once".

lock=$home/tasks/t042/.enter.lock
mkdir -p "$lock"
printf '%s\n' "$$" >"$lock/pid"

rm -f "$calls/calls"
capture env YAN_ENTER_LOCK_TIMEOUT=0 bash "$yan" continue --task t042
assert_ne 0 "$rc" 'a second enter on the same task waits for the first, it does not race it'
assert_not_contains "$(clog)" 'agent_start'

# The other task's container reports no agents of its own, which is the real
# situation for a task nobody has entered yet.
rm -f "$calls/calls"
capture env -u YAN_STUB_TERM_LIST YAN_ENTER_LOCK_TIMEOUT=0 bash "$yan" continue --task t099
assert_eq 0 "$rc" "a yan on another task is perfectly normal: $out"
assert_contains "$(clog)" 'agent_start'
assert_contains "$(clog)" 'container_create name=t099 something else entirely'

rm -rf "$lock"

# --- a dead agent is replaced, not left there -------------------------------

rm -f "$calls/calls"
export YAN_STUB_TERM_ALIVE=dead
capture bash "$yan" continue --task t042
assert_eq 0 "$rc" "$out"
log=$(clog)
assert_contains "$log" 'agent_close id=@1' 'exactly one recorded agent is closed'
assert_contains "$log" 'agent_start' 'and a fresh yan takes its place'

# --- the terminal cannot say: refuse rather than risk a duplicate -----------

rm -f "$calls/calls"
export YAN_STUB_TERM_ALIVE=unknown
capture bash "$yan" continue --task t042
assert_ne 0 "$rc" 'where we cannot tell, we do not start a second yan'
assert_contains "$out" 'refusing to start a second yan'
assert_not_contains "$(clog)" 'agent_start'

unset YAN_STUB_TERM_LIST
unset YAN_STUB_TERM_ALIVE

# --- the positional form ----------------------------------------------------

rm -f "$calls/calls"
capture bash "$yan" continue t042
assert_eq 0 "$rc" "$out"
assert_contains "$(clog)" 'agent_start'

# --- no id: refused, with the flag to pass ----------------------------------
#
# Selecting among the incomplete tasks is the soft path and belongs to Phase 9.
# Until then, and always without a TTY, this refuses and says what to pass
# (cli-ux.md §1).

capture bash "$yan" continue </dev/null
assert_eq 2 "$rc" 'no id and no TTY is a refusal, never a prompt'
assert_contains "$out" '--task'
assert_contains "$out" 'yan ls'

# --- the rest of the usage errors -------------------------------------------

capture bash "$yan" continue --task nosuchtask
assert_eq 2 "$rc"
assert_contains "$out" 'no such task'

capture bash "$yan" continue --task
assert_eq 2 "$rc"
capture bash "$yan" continue t042 t099
assert_eq 2 "$rc"
assert_contains "$out" 'only one task id'

# --- no agent configured ----------------------------------------------------

mk_config "$home" '{"version":1,"agents":{"shift":"claude"},"forge":{"kind":"github"},"backend":"tmux"}'
capture bash "$yan" continue --task t042
assert_eq 2 "$rc"
assert_contains "$out" 'agents.yan'

printf 'ok\n'
