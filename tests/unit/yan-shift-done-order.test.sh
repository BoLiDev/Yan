#!/usr/bin/env bash
#
# Phase 7 Trace bullet 2, the order of the teardown:
#
#   the MR is merged -> outcome.md -> rm -rf run/ -> RETURN THE TREE
#     -> THEN delete the remote shift branch
#
# architecture.md §7 lists this among the four ordering regressions, and it is
# the kind that never fails loudly: get it backwards and everything still looks
# like it worked, right up until a squash-merged shift strands a pool slot.
#
# Three stand-ins share one `calls` file, so the forge, pool and terminal calls
# arrive in the order they happened. git is not a seam and has no stand-in, so
# a recording `git` is put at the front of PATH - which also makes it possible
# to assert the thing this command must NOT do: ask git about ancestry.
#
# The step no seam can see - run/ being deleted - is read off the pool stub's
# witness field: the pool records whether run/ still existed at the moment the
# tree was handed back.
#
# The squash-merge case itself, where the ordering actually breaks, is in
# tests/integration/yan-shift-done-squash.test.sh against real git.
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
mkdir -p "$calls"
export YAN_STUB_POOL_DIR=$calls
export YAN_STUB_TERM_DIR=$calls
export YAN_STUB_FORGE_DIR=$calls

# A recording git. Deleting the remote branch is the only git this command is
# allowed to run, and this is what proves it.
mkdir -p "$tmp/bin"
cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >>"${YAN_STUB_POOL_DIR:?}/calls"
exit "${FAKE_GIT_RC:-0}"
EOF
chmod +x "$tmp/bin/git"
PATH=$tmp/bin:$PATH
export PATH

clone=$home/repos/monorepo-x
mkdir -p "$clone"

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth

MR=https://forge.invalid/acme/widget/-/merge_requests/31

# --- a dispatched shift, as `yan shift new` leaves one ----------------------

# shellcheck source=tests/stub/lib-pool.sh
. "$YAN_REPO_ROOT/tests/stub/lib-pool.sh"

lease=$(pool_get "$clone" 8 feat/auth yan/t042-auth-s1 t042/auth/s1)
tree=$(printf '%s' "$lease" | jq -r .path)
lease_id=$(printf '%s' "$lease" | jq -r .lease_id)

run=$home/tasks/t042/shifts/s1/run
mkdir -p "$run"
MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 jq -nc \
	--arg tree "$tree" --arg clone "$clone" --arg lease "$lease_id" --arg mr "$MR" \
	'{version: 1, task: "t042", sid: "s1", unit: "auth", repo: "monorepo-x",
	  branch: "yan/t042-auth-s1", base: "feat/auth", tree: $tree, clone: $clone,
	  holder: "t042/auth/s1", lease_id: $lease, agent: "claude",
	  container: "$0", window: "@3", pane: "%7", mr: $mr}' >"$run/meta.json"
printf '2026-08-09T09:00:00Z\tstarted\tread the brief\n' >"$run/status"

# The witness: whether run/ still existed when the tree was handed back.
export YAN_STUB_POOL_WITNESS=$run
rm -f "$calls/calls"

# --- an unmerged merge request stops everything -----------------------------

export YAN_STUB_FORGE_MR_STATES=open
capture bash "$yan" shift "done" s1
assert_eq 4 "$rc" 'a shift clocks out when its MR has merged, and nothing sooner'
assert_contains "$out" "is 'open', not merged"
assert_file_exists "$run/meta.json" 'nothing is torn down before the forge says merged'
log=$(cat "$calls/calls")
assert_not_contains "$log" 'pool_return'
assert_not_contains "$log" 'git '

# --- merged: the whole teardown, in order -----------------------------------

rm -f "$calls/calls"
export YAN_STUB_FORGE_MR_STATES=merged

capture bash "$yan" shift "done" s1
assert_eq 0 "$rc" "$out"

log=$(cat "$calls/calls")
order=$(printf '%s\n' "$log" | sed -n 's/^\([a-z_]*\).*/\1/p' | tr '\n' ' ')
assert_eq 'mr_state pool_return git agent_close ' "$order" \
	'merged? -> return the tree -> THEN delete the branch'

# The two arrows that carry the weight.
return_line=$(printf '%s\n' "$log" | grep '^pool_return ')
git_line=$(printf '%s\n' "$log" | grep '^git ')

assert_contains "$return_line" 'witness=absent' \
	'run/ is deleted before the tree is returned'
assert_contains "$return_line" "lease_id=$lease_id" \
	'the tree goes back under the lease id it was taken with, which is what makes a retry safe'
assert_contains "$return_line" 'holder=t042/auth/s1'
assert_contains "$git_line" 'push origin --delete yan/t042-auth-s1'

# --- "merged" was asked of the forge, never of git ancestry -----------------
#
# The one git command in the whole run is the deletion. No merge-base, no
# rev-list, no `branch --contains`: a squash-merged branch is not an ancestor
# of the branch it landed on, so ancestry would answer `not merged` about work
# that landed an hour ago (td §5.3).

assert_eq 1 "$(printf '%s\n' "$log" | grep -c '^git ')" 'exactly one git command'
assert_not_contains "$log" 'merge-base'
assert_not_contains "$log" 'rev-list'
assert_not_contains "$log" 'contains'
assert_contains "$log" "mr_state mr=$MR" 'the forge is the source of truth'

# --- what is left behind ----------------------------------------------------

assert_file_missing "$run" 'run/ is deleted whole - one directory, not a list of files'
assert_file_exists "$home/tasks/t042/shifts/s1/outcome.md" 'outcome.md is long-lived and survives'
assert_contains "$(cat "$home/tasks/t042/shifts/s1/outcome.md")" "$MR"
assert_contains "$(cat "$home/tasks/t042/log.md")" 'merged into the integration branch'
assert_eq '' "$(pool_stub_leases)" 'the pool slot is free again'

# The shift is now clocked out, and `yan state` says so from the same fact.
capture bash "$yan" state s1 --verdict
assert_eq 0 "$rc" "$out"
assert_eq clocked-out "$out"

# --- clocking out twice is refused, not repeated ----------------------------

capture bash "$yan" shift "done" s1
assert_eq 2 "$rc"
assert_contains "$out" 'already clocked out'

# --- a failed return stops before the branch is deleted ---------------------
#
# The refusal is the last line of defence: the moment the pool will not take a
# tree back is the moment the work may exist nowhere else, and deleting the
# remote branch next would make that permanent.

lease2=$(pool_get "$clone" 8 feat/auth yan/t042-auth-s2 t042/auth/s2)
tree2=$(printf '%s' "$lease2" | jq -r .path)
run2=$home/tasks/t042/shifts/s2/run
mkdir -p "$run2"
MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 jq -nc \
	--arg tree "$tree2" --arg clone "$clone" --arg mr "$MR" \
	'{version: 1, task: "t042", sid: "s2", unit: "auth",
	  branch: "yan/t042-auth-s2", tree: $tree, clone: $clone,
	  holder: "t042/auth/s2", lease_id: "not-the-one", agent: "claude", mr: $mr}' >"$run2/meta.json"

rm -f "$calls/calls"
export YAN_STUB_FORGE_MR_STATES=merged
capture bash "$yan" shift "done" s2
assert_eq 3 "$rc" 'a lease identity that does not match is refused with the pool own code'
assert_contains "$out" 'has NOT been deleted'
assert_not_contains "$(cat "$calls/calls")" 'git ' 'the branch survives a refused return'

printf 'ok\n'
