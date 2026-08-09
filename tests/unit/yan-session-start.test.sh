#!/usr/bin/env bash
#
# Phase 7 Trace bullet 5:
#
#   session-start rebuilds from disk + terminal + pool + forge with NO durable
#   yan state files
#
# The second half is the one worth a test. td agents.md §5.1 says yan holds no
# persistent running state, and that is the whole reason a restart is a
# non-event; the moment this command writes a cache, a session file or a "last
# seen" timestamp, that stops being true and something exists that can disagree
# with the world. So the assertion is blunt: $YAN_HOME is byte-for-byte
# identical before and after, twice over.
#
# The first half is checked by taking every source away one at a time. A fresh
# machine has no tmux server, the pool root may be on a disk that is not
# mounted, and the forge is unreachable on a train - all three have to come
# back as `unknown`, and none of them may end the command.
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
cp "$YAN_REPO_ROOT/tests/stub/lib-pool.sh" "$home/bin/lib-pool.sh"
cp "$YAN_REPO_ROOT/tests/stub/lib-term.sh" "$home/bin/lib-term.sh"
cp "$YAN_REPO_ROOT/tests/stub/lib-forge.sh" "$home/bin/lib-forge.sh"

export YAN_HOME=$home
yan=$home/bin/yan

calls=$tmp/calls
export YAN_STUB_POOL_DIR=$calls
export YAN_STUB_TERM_DIR=$calls
export YAN_STUB_FORGE_DIR=$calls

clone=$home/repos/monorepo-x
mkdir -p "$clone"

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth
task_init t099 'a task nobody has started'
task_unit_add t099 api monorepo-x master --branch feat/api

MR=https://forge.invalid/acme/widget/-/merge_requests/31

# --- a live shift and a clocked-out one -------------------------------------

# shellcheck source=tests/stub/lib-pool.sh
. "$YAN_REPO_ROOT/tests/stub/lib-pool.sh"
lease=$(pool_get "$clone" 8 feat/auth yan/t042-auth-s2 t042/auth/s2)
tree=$(printf '%s' "$lease" | jq -r .path)
lease_id=$(printf '%s' "$lease" | jq -r .lease_id)

run=$home/tasks/t042/shifts/s2/run
mkdir -p "$run"
MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 jq -nc \
	--arg tree "$tree" --arg clone "$clone" --arg lease "$lease_id" --arg mr "$MR" \
	'{version: 1, task: "t042", sid: "s2", unit: "auth", repo: "monorepo-x",
	  branch: "yan/t042-auth-s2", base: "feat/auth", tree: $tree, clone: $clone,
	  holder: "t042/auth/s2", lease_id: $lease, agent: "claude",
	  container: "$0", window: "@3", pane: "%7", mr: $mr}' >"$run/meta.json"
printf '2026-08-09T09:00:00Z\tstarted\tread the brief\n' >"$run/status"

# s1 has already clocked out: its run/ is gone and only the long-lived files
# remain. Nothing live should be asked about it.
mkdir -p "$home/tasks/t042/shifts/s1"
printf '# s1\n' >"$home/tasks/t042/shifts/s1/outcome.md"

# --- the rebuild ------------------------------------------------------------

snapshot() { # every file under $YAN_HOME, with its size
	find "$home" -type f -printf '%P %s\n' 2>/dev/null | LC_ALL=C sort
}

before=$(snapshot)

export YAN_STUB_TERM_ALIVE=alive
export YAN_STUB_FORGE_MR_STATES=open

capture bash "$yan" session-start --task t042
assert_eq 0 "$rc" "$out"
assert_contains "$out" 't042  unify the auth header'
assert_contains "$out" 'unit auth'
assert_contains "$out" 'branch feat/auth'
assert_contains "$out" 'shift s2'
assert_contains "$out" 'terminal=alive' 'the terminal was asked'
assert_contains "$out" 'pool=leased' 'the pool was asked'
assert_contains "$out" 'mr=open' 'the forge was asked'
assert_contains "$out" 'clocked out' 's1 is reported, and reported as finished'

# THE ASSERTION. Nothing was written, anywhere.
assert_eq "$before" "$(snapshot)" 'session-start must not create or change a single file'

# All four sources really were consulted, in yan vocabulary.
log=$(cat "$calls/calls")
assert_contains "$log" 'agent_alive id=%7' 'the terminal is asked by id, never by label'
assert_contains "$log" "pool_status clone=$clone"
assert_contains "$log" "mr_state mr=$MR"

# --- machine readable, and still nothing written ----------------------------

before=$(snapshot)
capture bash "$yan" session-start --task t042 --json
assert_eq 0 "$rc" "$out"
assert_eq t042 "$(printf '%s' "$out" | jq -r '.tasks[0].id')"
assert_eq 2 "$(printf '%s' "$out" | jq -r '.tasks[0].shifts | length')"
assert_eq alive "$(printf '%s' "$out" | jq -r '.tasks[0].shifts[] | select(.sid == "s2") | .terminal')"
assert_eq leased "$(printf '%s' "$out" | jq -r '.tasks[0].shifts[] | select(.sid == "s2") | .pool')"
assert_eq open "$(printf '%s' "$out" | jq -r '.tasks[0].shifts[] | select(.sid == "s2") | .mr_state')"
assert_eq false "$(printf '%s' "$out" | jq -r '.tasks[0].shifts[] | select(.sid == "s1") | .live')"
assert_eq "$before" "$(snapshot)" 'nor on the --json path'

# --- every task, when no id is given ----------------------------------------

capture bash "$yan" session-start --all
assert_eq 0 "$rc" "$out"
assert_contains "$out" 't042'
assert_contains "$out" 't099'
assert_contains "$out" 'no shift has ever been dispatched' \
	'"no shift has ever been dispatched" is shifts/ being empty, not a stored flag'

# --- a source that will not answer costs one fact, never the command --------

before=$(snapshot)

# The terminal cannot be asked at all - a fresh machine with no tmux server.
capture env YAN_STUB_TERM_BACKEND_RC=1 bash "$yan" session-start --task t042
assert_eq 0 "$rc" "an unreachable terminal must not end the rebuild: $out"
assert_contains "$out" 'terminal=unknown'

# The pool cannot be asked - the trees are on a disk that is not mounted.
capture env YAN_STUB_POOL_STATUS_RC=1 bash "$yan" session-start --task t042
assert_eq 0 "$rc" "an unreachable pool must not end the rebuild: $out"
assert_contains "$out" 'pool=unknown'

# The forge cannot be reached.
capture env YAN_STUB_FORGE_MR_STATES=unknown bash "$yan" session-start --task t042
assert_eq 0 "$rc" "an unreachable forge must not end the rebuild: $out"
assert_contains "$out" 'mr=unknown'

# All three at once, which is what being offline actually looks like.
capture env YAN_STUB_TERM_BACKEND_RC=1 YAN_STUB_POOL_STATUS_RC=1 \
	YAN_STUB_FORGE_MR_STATES=unknown bash "$yan" session-start --task t042
assert_eq 0 "$rc" "$out"
assert_contains "$out" 'terminal=unknown'
assert_contains "$out" 'pool=unknown'
assert_contains "$out" 'mr=unknown'

assert_eq "$before" "$(snapshot)" 'not even the failure paths write anything'

# --- a half-written meta.json is one lost fact, never a crash ---------------

printf 'not json at all\n' >"$run/meta.json"
capture bash "$yan" session-start --task t042
assert_eq 0 "$rc" "an unreadable meta.json must not crash the rebuild: $out"
assert_contains "$out" 'shift s2'

rm -f "$run/meta.json"
capture bash "$yan" session-start --task t042
assert_eq 0 "$rc" "a missing meta.json must not crash the rebuild: $out"

# --- usage ------------------------------------------------------------------

capture bash "$yan" session-start --task nosuchtask
assert_eq 2 "$rc"
assert_contains "$out" 'no such task'

printf 'ok\n'
