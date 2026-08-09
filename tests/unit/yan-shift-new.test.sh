#!/usr/bin/env bash
#
# Phase 7 Trace bullet 1:
#
#   shift new: sync -> lease tree -> write brief -> start agent in container
#              -> assert cwd != main clone (refuse otherwise)
#
# The order is checked, not assumed. The three stand-ins are pointed at ONE
# directory, so lib-pool's, lib-term's and lib-forge's calls all land in the
# same `calls` file in the order they happened, and the replacement yan-sync.sh
# appends to it too. Two steps that no seam can see - "the brief did not exist
# yet when the tree was leased" and "it did by the time the agent started" -
# are read off the stubs' witness field.
#
# The last bullet is the one that matters most and it is checked twice, because
# it is one of architecture.md §7's four ordering regressions: the pool is
# programmed to hand out the MAIN CLONE, and `yan shift new` has to REFUSE -
# not warn, not log - and give the tree back on its way out.
#
# The seams are swapped by dropping the stand-ins into the throwaway home's own
# bin/. YAN_LIB would be directory-wide and this subcommand also sources
# lib-task, lib-shift, lib-json and lib-boot, which have no stand-ins.
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

# `yan sync` is a subcommand, not a seam, so it is replaced the same way: this
# one only records that it ran, into the shared call log.
cat >"$home/bin/yan-sync.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p -- "${YAN_STUB_POOL_DIR:?}"
printf 'sync %s\n' "$*" >>"${YAN_STUB_POOL_DIR}/calls"
exit "${FAKE_SYNC_RC:-0}"
EOF

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
task_unit_add t042 auth monorepo-x master --branch feat/auth \
	--scope apps/auth --scope apps/common

brief=$home/tasks/t042/shifts/s1/brief.md

# --- the happy path ---------------------------------------------------------
#
# The pool is told to hand out a prepared tree, so the scope directories exist
# and the harness mapping table has something to map.

tree=$tmp/tree1
mkdir -p "$tree/apps/auth" "$tree/apps/common"
export YAN_STUB_POOL_PATH=$tree
export YAN_STUB_POOL_LEASE_ID=lease-abc123
# What the pool must NOT have seen yet, and what the terminal must have.
export YAN_STUB_POOL_WITNESS=$brief
export YAN_STUB_TERM_WITNESS=$brief

capture bash "$yan" shift new --task t042 --unit auth --sid s1 --brief-text 'parse the header'
assert_eq 0 "$rc" "$out"

log=$(cat "$calls/calls")

# --- the order --------------------------------------------------------------

order=$(printf '%s\n' "$log" | sed -n 's/^\([a-z_]*\).*/\1/p' | tr '\n' ' ')
assert_eq 'sync pool_get container_create agent_start ' "$order" \
	"sync, then the lease, then the container, then the agent - in that order"

sync_line=$(printf '%s\n' "$log" | grep '^sync ')
assert_contains "$sync_line" '--task t042' 'sync is asked about this unit'
assert_contains "$sync_line" '--unit auth'

get_line=$(printf '%s\n' "$log" | grep '^pool_get ')
assert_contains "$get_line" "base=feat/auth" 'the tree is cut from the integration branch'
assert_contains "$get_line" "branch=yan/t042-auth-s1" 'the shift branch is always yan/<task>-<unit>-<sid>'
assert_contains "$get_line" "holder=t042/auth/s1" 'the holder is <task>/<unit>/<sid>'
assert_contains "$get_line" 'witness=absent' 'the brief is written AFTER the tree is leased'

start_line=$(printf '%s\n' "$log" | grep '^agent_start ')
assert_contains "$start_line" 'witness=present' 'the brief is written BEFORE the agent is started'

# The shift branch is never derived from the integration branch's name: git
# itself forbids feat/auth and feat/auth/s1 coexisting (branching.md §6.5).
assert_not_contains "$get_line" 'branch=feat/auth/' 'never derived from the integration branch'

# --- what the agent was started with ----------------------------------------

assert_contains "$start_line" "container=\$0" 'the agent goes in the task container'
assert_contains "$start_line" 'label=s1-auth'
assert_contains "$start_line" "dir=$tree/apps/auth" 'the working directory is the main scope path in the tree'
assert_contains "$start_line" "YAN_TASK_DIR=$home/tasks/t042" \
	'artifacts land outside the worktree, which the tree return would wipe'
assert_contains "$start_line" "YAN_SHIFT_DIR=$home/tasks/t042/shifts/s1"
assert_contains "$start_line" 'YAN_SID=s1'
assert_contains "$start_line" "YAN_HOME=$home"
assert_contains "$start_line" "cmd=claude --add-dir $tree/apps/common" \
	'the rest of scope is added with the harness flag, from a small table'
assert_contains "$start_line" "$brief" 'the opening prompt points at the brief'
assert_not_contains "$start_line" "dir=$clone" 'never the main clone'

# A shift runs for hours with nobody watching (td §5.5), so the harness has to
# be told up front that it may act. Without this the agent stops on its FIRST
# tool call waiting for someone to answer "Do you want to proceed?" - observed
# against a real dispatch - and every shift would need a human to start it.
# The boundary is unchanged: the agent's world is still its workdir plus
# --add-dir, and the tree is a disposable lease (delivery.md §8.3).
assert_contains "$start_line" '--dangerously-skip-permissions' \
	'a shift must be able to run unattended'

# (a scout must NOT get that flag - asserted at the end of this file, because
# dispatching another shift here would change what the next derived sid is)

container_line=$(printf '%s\n' "$log" | grep '^container_create ')
assert_contains "$container_line" 'name=t042 unify the auth header'

# --- the brief --------------------------------------------------------------

assert_file_exists "$brief"
body=$(cat "$brief")
assert_contains "$body" 'parse the header'
assert_contains "$body" "$tree" 'the brief says which tree the shift works in'
assert_contains "$body" 'yan/t042-auth-s1'
assert_contains "$body" "$home/tasks/t042/artifacts" 'artifacts go outside the worktree'
assert_contains "$body" 'yan report'

# --- run/meta.json ----------------------------------------------------------

meta=$home/tasks/t042/shifts/s1/run/meta.json
assert_file_exists "$meta"
assert_eq auth "$(jq -r .unit "$meta")" 'yan ls reads .unit'
assert_eq yan/t042-auth-s1 "$(jq -r .branch "$meta")" 'yan ls reads .branch'
assert_eq "$tree" "$(jq -r .tree "$meta")" 'yan ls reads .tree'
assert_eq claude "$(jq -r .agent "$meta")" 'yan ls reads .agent'
assert_eq lease-abc123 "$(jq -r .lease_id "$meta")" 'the lease id is what makes the return safe on a retry'
assert_eq 't042/auth/s1' "$(jq -r .holder "$meta")"
assert_eq '$0' "$(jq -r .container "$meta")"
assert_eq '@1' "$(jq -r .window "$meta")" 'terminal ids, never labels'
assert_eq '%1' "$(jq -r .pane "$meta")"
assert_eq feat/auth "$(jq -r .base "$meta")"
assert_eq "$clone" "$(jq -r .clone "$meta")"
assert_eq 1 "$(jq -r .version "$meta")" 'every JSON file carries a version'

# There is no CR anywhere in it: a JSON file written on Windows must be
# byte-identical to one written on Linux (conventions §2.3).
assert_eq 0 "$(tr -cd '\r' <"$meta" | wc -c | tr -d ' ')" 'meta.json is LF only'

# Phase 1's view still works, unchanged.
capture bash "$yan" ls t042
assert_eq 0 "$rc" "$out"
assert_contains "$out" 'yan/t042-auth-s1'
assert_contains "$out" "$tree"

# --- sid is derived, and it increases ---------------------------------------

rm -f "$calls/calls"
capture bash "$yan" shift new --task t042 --unit auth --brief-text 'second one'
assert_eq 0 "$rc" "$out"
assert_file_exists "$home/tasks/t042/shifts/s2/brief.md" 'the next sid is derived by scanning shifts/'
assert_contains "$(cat "$calls/calls")" 'branch=yan/t042-auth-s2' 'and it carries no round number'

capture bash "$yan" shift new --task t042 --unit auth --sid s1
assert_eq 2 "$rc" 'a sid that already exists is a caller error'
assert_contains "$out" 'already exists'

# --- THE ASSERTION: the working directory is never the main clone ------------
#
# Case one: the pool hands out the main clone itself.

rm -f "$calls/calls"
export YAN_STUB_POOL_PATH=$clone
export YAN_STUB_POOL_LEASE_ID=lease-danger
capture bash "$yan" shift new --task t042 --unit auth --sid s9 --brief-text 'must not run'
assert_eq 4 "$rc" 'starting a shift in the main clone is refused, not warned about'
assert_contains "$out" 'main clone'
assert_contains "$out" 'refusing to start'

log=$(cat "$calls/calls")
assert_not_contains "$log" 'agent_start' 'no agent may be started after the refusal'
assert_contains "$log" 'pool_return' 'and the tree goes straight back'
assert_contains "$log" 'lease_id=lease-danger' 'returned under the identity it was leased with'
assert_file_missing "$home/tasks/t042/shifts/s9" 'a refused dispatch leaves nothing behind'

# Case two: the working directory would be a path INSIDE the main clone,
# because the scope path resolves there. The tree path itself is not equal to
# the clone, so only the prefix comparison catches this one.

mkdir -p "$clone/apps/auth"
rm -f "$calls/calls"
capture bash "$yan" shift new --task t042 --unit auth --sid s9 --brief-text 'must not run'
assert_eq 4 "$rc" "a working directory inside the main clone is refused too: $out"
assert_contains "$out" "$clone/apps/auth"
assert_not_contains "$(cat "$calls/calls")" 'agent_start'

# --- the pool being full is said as what it is ------------------------------

rm -f "$calls/calls"
unset YAN_STUB_POOL_PATH
export YAN_STUB_POOL_FULL=1
capture bash "$yan" shift new --task t042 --unit auth --sid s9
assert_eq 3 "$rc" 'a full pool has its own exit code'
assert_contains "$out" 'pool is full'
assert_contains "$out" 'cannot start a new shift'
unset YAN_STUB_POOL_FULL

# --- sync failing stops the dispatch before anything is leased --------------

rm -f "$calls/calls"
export FAKE_SYNC_RC=5
capture bash "$yan" shift new --task t042 --unit auth --sid s9
assert_eq 5 "$rc" 'a conflict during sync is handed on as a conflict'
assert_contains "$out" 'conflicts with'
assert_not_contains "$(cat "$calls/calls")" 'pool_get' 'nothing is leased when the sync did not finish'
unset FAKE_SYNC_RC

# --- usage ------------------------------------------------------------------

capture bash "$yan" shift new --unit auth
assert_eq 2 "$rc" '--task is required'
capture bash "$yan" shift new --task t042
assert_eq 2 "$rc" '--unit is required'
capture bash "$yan" shift new --task t042 --unit nosuch
assert_eq 2 "$rc"
assert_contains "$out" 'no such unit'

printf 'ok\n'

# --- a scout is the exception -----------------------------------------------
#
# `--dangerously-skip-permissions` and the read-only mode must never both
# apply. A scout's whole contract is that it does not change code
# (delivery.md §8.2), so it keeps plan mode and must not be handed a free hand.
#
# This runs last on purpose: dispatching another shift changes which sid the
# derivation test above would see next.

task_unit_add t042 probe monorepo-x master --branch feat/probe --scope apps/auth
task_unit_set t042 probe mode scout
rm -f "$calls/calls"
mkdir -p "$tmp/tree2/apps/auth"
export YAN_STUB_POOL_PATH=$tmp/tree2
export YAN_STUB_POOL_WITNESS=''
export YAN_STUB_TERM_WITNESS=''

capture bash "$yan" shift new --task t042 --unit probe --sid s90 --brief-text 'just look'
assert_eq 0 "$rc" "$out"

scout_line=$(grep '^agent_start ' "$calls/calls")
assert_contains "$scout_line" '--permission-mode plan' 'a scout is read-only'
assert_not_contains "$scout_line" '--dangerously-skip-permissions' \
	'a scout must never be given a free hand'
