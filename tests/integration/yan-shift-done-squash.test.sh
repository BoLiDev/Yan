#!/usr/bin/env bash
#
# Phase 7 Trace bullet 2, against real git and the real pool, in the one case
# that actually breaks: A SQUASH MERGE.
#
# When the internal merge request is squash-merged, the integration branch does
# not contain the shift branch's HEAD. Two things follow, and both are in
# td worktree.md §7:
#
#   1. An ancestry check would answer "not merged" about work that landed an
#      hour ago. This test asserts that ancestry really does say no here, and
#      that `yan shift done` clocks the shift out anyway, because it asked the
#      forge.
#
#   2. Deleting the remote shift branch removes its remote-tracking ref - which
#      a worktree shares with its main clone - so `git branch -r --contains
#      HEAD` goes empty and the pool's orphan-commit guard refuses to take the
#      tree back. There is no --force anywhere in the MVP, so the slot would be
#      stranded for good. The control at the end of this file does exactly
#      that, in the wrong order, and shows the refusal.
#
# Only the forge is a stand-in: whether an MR merged cannot be asked of a local
# bare repository, and nothing here may touch the network.
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
cp "$YAN_REPO_ROOT/tests/stub/lib-forge.sh" "$home/bin/lib-forge.sh"

export YAN_HOME=$home
export YAN_POOL_ROOT=$tmp/trees
export YAN_STUB_FORGE_DIR=$tmp/forge
yan=$home/bin/yan

bare=$tmp/remote.git
mk_bare_remote "$bare"
clone=$home/repos/widget
mk_clone "$bare" "$clone"

# The integration branch this round works on.
fx_git -C "$clone" checkout -b feat/auth >/dev/null 2>&1
fx_git -C "$clone" push -u origin feat/auth >/dev/null 2>&1
fx_git -C "$clone" checkout main >/dev/null 2>&1

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
# shellcheck source=bin/lib-pool.sh
. "$YAN_REPO_ROOT/bin/lib-pool.sh"

task_init t042 'unify the auth header'
task_unit_add t042 auth widget master --branch feat/auth --scope apps/auth

MR=https://forge.invalid/acme/widget/-/merge_requests/31

# dispatch <sid> - a shift as `yan shift new` leaves one: a leased tree on its
# own shift branch, pushed, with run/meta.json recording the lease.
dispatch() {
	# Two statements: bash expands every word of a `local` before any of its
	# assignments take effect, so `local a=$1 b=$a` reads an unset a.
	local sid=$1
	local branch=yan/t042-auth-$sid lease tree lease_id run

	lease=$(pool_get "$clone" 4 feat/auth "$branch" "t042/auth/$sid")
	tree=$(printf '%s' "$lease" | jq -r .path)
	lease_id=$(printf '%s' "$lease" | jq -r .lease_id)

	mk_commit "$tree" "apps/auth/$sid.txt" "work from $sid" "$sid: parse the header"
	fx_git -C "$tree" push -u origin "$branch" >/dev/null 2>&1

	run=$home/tasks/t042/shifts/$sid/run
	mkdir -p "$run"
	MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 jq -nc \
		--arg sid "$sid" --arg branch "$branch" --arg tree "$tree" \
		--arg clone "$clone" --arg lease "$lease_id" --arg mr "$MR" \
		'{version: 1, task: "t042", sid: $sid, unit: "auth", repo: "widget",
		  branch: $branch, base: "feat/auth", tree: $tree, clone: $clone,
		  holder: ("t042/auth/" + $sid), lease_id: $lease, agent: "claude",
		  container: "$0", window: "@3", pane: "%7", mr: $mr}' >"$run/meta.json"

	printf '%s\n' "$tree"
}

# squash_merge <branch> - land it on feat/auth the way a squash merge does:
# the change arrives as a NEW commit and the branch's own HEAD is nowhere in
# the integration branch's history.
squash_merge() {
	local branch=$1 scratch=$tmp/scratch-$RANDOM
	mk_clone "$bare" "$scratch"
	fx_git -C "$scratch" checkout feat/auth >/dev/null 2>&1
	fx_git -C "$scratch" merge --squash "origin/$branch" >/dev/null 2>&1
	fx_git -C "$scratch" commit -m "squash $branch" >/dev/null 2>&1
	fx_git -C "$scratch" push origin feat/auth >/dev/null 2>&1
	rm -rf "$scratch"
	fx_git -C "$clone" fetch --prune origin >/dev/null 2>&1
}

remote_has() { # remote_has <branch>
	local out
	out=$(fx_git -C "$clone" ls-remote --heads origin "refs/heads/$1" 2>/dev/null || true)
	[ -n "$out" ]
}

# --- s1: dispatched, squash-merged, clocked out -----------------------------

tree1=$(dispatch s1)
squash_merge yan/t042-auth-s1

assert_ok remote_has yan/t042-auth-s1
assert_ok remote_has feat/auth

# The precondition this whole test exists for: ancestry says "not merged".
capture fx_git -C "$tree1" merge-base --is-ancestor HEAD origin/feat/auth
assert_ne 0 "$rc" \
	'after a squash merge the integration branch does NOT contain the shift HEAD - which is why ancestry may never be the test'

# But the work did land: the file is on the integration branch.
assert_contains "$(fx_git -C "$clone" show origin/feat/auth:apps/auth/s1.txt)" 'work from s1'

export YAN_STUB_FORGE_MR_STATES=merged
capture bash "$yan" shift "done" s1
assert_eq 0 "$rc" "$out"

assert_file_missing "$home/tasks/t042/shifts/s1/run" 'run/ is gone'
assert_file_exists "$home/tasks/t042/shifts/s1/outcome.md"

# The tree really came back: no lease, and it is clean.
assert_eq '[]' "$(pool_status "$clone")" 'the slot is free again'
assert_eq '' "$(fx_git -C "$tree1" status --porcelain)" 'the tree was reset and cleaned'

# And only then was the branch deleted.
capture remote_has yan/t042-auth-s1
assert_ne 0 "$rc" 'the merged shift branch is deleted on origin - last'

# --- the control: the same situation in the WRONG order ---------------------
#
# Delete the remote branch first, as a teardown that deleted before returning
# would, and ask the pool for the tree back. The guard has to refuse, because
# from where it stands the commits now exist nowhere else - and there is no way
# to override it, so the slot would be stranded.

tree2=$(dispatch s2)
squash_merge yan/t042-auth-s2

# This is the step that must not come first.
fx_git -C "$clone" push origin --delete yan/t042-auth-s2 >/dev/null 2>&1
fx_git -C "$clone" fetch --prune origin >/dev/null 2>&1

assert_eq '' "$(fx_git -C "$tree2" branch -r --contains HEAD)" \
	'deleting the branch takes the remote-tracking ref with it, and a worktree shares refs with its clone'

capture pool_return "$clone" "$tree2" '' ''
assert_ne 0 "$rc" 'the orphan-commit guard refuses, exactly as worktree.md §7 says it would'
assert_contains "$out" 'no remote branch contains HEAD'
assert_eq 1 "$(pool_status "$clone" | jq 'length')" 'and the slot stays taken'

# Put it back the only way that is left, so the fixture tears down cleanly:
# the branch has to exist again before the tree may be returned.
fx_git -C "$tree2" push -u origin yan/t042-auth-s2 >/dev/null 2>&1
assert_ok pool_return "$clone" "$tree2" '' ''

printf 'ok\n'

# --- an interrupted teardown can be finished --------------------------------
#
# The documented order deletes run/ (step 4) BEFORE returning the tree (step 5).
# So a return that refuses - or a kill, or a sleeping laptop - leaves run/ gone,
# the tree still leased and the remote branch still there, with nothing left in
# $YAN_HOME to say which shift they belonged to.
#
# Observed for real, and it is not an exotic path: the tree came back dirty
# because the install step the brief mandates had generated an untracked file.
# The guard refused exactly as it should, and the shift then became impossible
# to finish through `yan shift done` at all.
#
# Nothing extra is stored to fix this. The pool already records the holder as
# <task>/<unit>/<sid> along with the branch, path and lease id, so the answer is
# derived (design principle 1): ask the pool.

sid=s5
tree5=$(dispatch "$sid")

# Land it the same way, so the forge would say merged.
git -C "$tree5" commit -q --allow-empty -m 'work for s5'
git -C "$tree5" push -q origin "yan/t042-auth-$sid"
squash_merge "yan/t042-auth-$sid"

# Make the tree dirty, exactly as a generated lockfile does, so step 5 refuses.
printf 'generated\n' >"$tree5/leftover.txt"

export YAN_STUB_FORGE_MR_STATES=merged
capture bash "$yan" shift "done" "$sid" --mr "$MR"
assert_ne 0 "$rc" 'a dirty tree must refuse, so the teardown stops at step 5'
assert_contains "$out" 'has NOT been deleted' 'and it must not delete the branch'

# The half-torn-down state: run/ gone, tree still leased, branch still there.
assert_file_missing "$home/tasks/t042/shifts/$sid/run" 'run/ was already deleted'
assert_ne '' "$(pool_status "$clone" | jq -r --arg h "t042/auth/$sid" \
	'(if type=="array" then . else [.] end)|map(select(.holder==$h))|.[0].path // ""')" \
	'the tree is still leased'

# Now resolve what made it refuse, as an operator would, and re-run.
rm -f "$tree5/leftover.txt"
capture bash "$yan" shift "done" "$sid"
assert_eq 0 "$rc" "the teardown must be finishable: $out"
assert_contains "$out" 'finishing the teardown' 'and it must say that is what it is doing'

assert_eq '' "$(pool_status "$clone" | jq -r --arg h "t042/auth/$sid" \
	'(if type=="array" then . else [.] end)|map(select(.holder==$h))|.[0].path // ""')" \
	'the tree is back in the pool'
assert_eq '' "$(git -C "$clone" ls-remote --heads origin "yan/t042-auth-$sid")" \
	'and only now is the remote branch gone'
