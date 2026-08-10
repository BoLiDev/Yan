#!/usr/bin/env bash
#
# Phase 6, Trace bullets 3 and 4.
#
#   3. `yan sync` leases a tree briefly, fetches, merges target, pushes, and
#      gives the tree back - AND EXITS IMMEDIATELY ON A CONFLICT. Conflicts are
#      never resolved inside the script (td branching.md §6.3); they are handed
#      to a shift. architecture.md §7 names this as one of the four ordering
#      regressions that do not fail loudly, so the conflict here is a genuine
#      one: two commits changing the same line of the same file.
#
#   4. When the pool is full, the error says "the pool is full, cannot start a
#      new shift" - NOT "sync failed" (td worktree.md §7 names this trap). sync
#      is the first step of `yan shift new`, so a vague message sends the
#      reader hunting for a synchronisation problem that does not exist.
#
# Real git, local bare remote, real pool. No network, no forge, no agent.
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
mk_yan_dist "$home"
YAN=$home/bin/yan

pool_root=$tmp/trees
bare=$tmp/remote.git
clone=$home/repos/demo
work=$tmp/work

mk_bare_remote "$bare"
mk_clone "$bare" "$clone"
mk_clone "$bare" "$work"

cat >"$home/mem/repos.json" <<JSON
{
  "version": 1,
  "demo": { "url": "$bare", "mode_default": "mr", "pool_size": 2 }
}
JSON

yan() { env YAN_HOME="$home" YAN_POOL_ROOT="$pool_root" bash "$YAN" "$@"; }

lib() { # lib <shell-code>
	env YAN_HOME="$home" bash -c '
		set -euo pipefail
		# shellcheck source=/dev/null
		. "$YAN_HOME/bin/lib-task.sh"
		eval "$1"
	' _ "$1"
}

leases() { yan tree status --repo demo --json | jq 'length'; }

lib 'task_init t1 "a demo task"'
yan unit add --task t1 --unit auth --repo demo --target main --branch feat/auth >/dev/null
yan unit add --task t1 --unit proto --repo demo --target main --branch feat/proto >/dev/null

# Both integration branches get a commit of their own and are published, so the
# sync below is a real three-way merge and not a fast-forward.
for b in feat/auth feat/proto; do
	fx_git -C "$work" checkout -b "$b" origin/main >/dev/null 2>&1
	mk_commit "$work" "${b#feat/}.txt" "work on $b"
	fx_git -C "$work" push -u origin "$b" >/dev/null 2>&1
	fx_git -C "$work" checkout main >/dev/null 2>&1
done

# --- target moves on --------------------------------------------------------

mk_commit "$work" shared.txt $'one\ntwo\nthree\n' 'add shared.txt'
fx_git -C "$work" push origin main >/dev/null 2>&1

# --- TRACE 3: lease -> fetch -> merge -> push -> return ---------------------

assert_eq 0 "$(leases)"

capture yan sync --task t1 --unit auth
assert_eq 0 "$rc" "$out"
assert_contains "$out" "caught up with origin/main"

# It merged: the integration branch on the REMOTE now has target's file as well
# as its own, so the push really happened.
fx_git -C "$work" fetch origin >/dev/null 2>&1
assert_ok fx_git -C "$work" cat-file -e origin/feat/auth:shared.txt
assert_ok fx_git -C "$work" cat-file -e origin/feat/auth:auth.txt

# And the lease was short: the tree is back in the pool.
assert_eq 0 "$(leases)" "sync leases a tree only for as long as it is working"

# Running it again is a no-op, and still returns the tree.
capture yan sync --task t1 --unit auth
assert_eq 0 "$rc" "$out"
assert_contains "$out" "already up to date"
assert_eq 0 "$(leases)"

# The --json shape is what `yan shift new` will read in Phase 7.
yan sync --task t1 --unit auth --json >"$tmp/sync.json"
assert_fail grep -q $'\r' "$tmp/sync.json" "sync printed a carriage return"
assert_eq feat/auth "$(jq -r '.branch' "$tmp/sync.json")"
assert_eq origin/main "$(jq -r '.target' "$tmp/sync.json")"
assert_eq merge "$(jq -r '.strategy' "$tmp/sync.json")"
assert_eq false "$(jq -r '.moved' "$tmp/sync.json")"

# --- TRACE 3: a genuine conflict, and the script leaves at once -------------
#
# feat/proto and main both rewrite the same line of shared.txt. There is no
# mechanical answer, so this is exactly the case that must be handed over.

fx_git -C "$work" checkout feat/proto >/dev/null 2>&1
fx_git -C "$work" merge origin/main --no-edit >/dev/null 2>&1 || true
mk_commit "$work" shared.txt $'one\nTWO FROM THE UNIT\nthree\n' 'the unit rewrites line two'
fx_git -C "$work" push origin feat/proto >/dev/null 2>&1

fx_git -C "$work" checkout main >/dev/null 2>&1
mk_commit "$work" shared.txt $'one\nTWO FROM TARGET\nthree\n' 'target rewrites line two'
fx_git -C "$work" push origin main >/dev/null 2>&1

before=$(fx_git -C "$bare" rev-parse feat/proto)

capture yan sync --task t1 --unit proto
assert_eq 5 "$rc" "a conflict has its own exit code, so a caller can tell it from a broken sync"
assert_contains "$out" "conflict"
assert_contains "$out" "shared.txt" "the conflicting paths are named, so the hand-off is useful"
assert_contains "$out" "dispatch a shift"
assert_not_contains "$out" "CONFLICT (content)" \
	"git's own merge output is not what the caller is told"

# Nothing was pushed, and the tree is back: a conflict must not wedge the pool.
assert_eq "$before" "$(fx_git -C "$bare" rev-parse feat/proto)" "nothing was pushed"
assert_eq 0 "$(leases)" "the tree is returned even on the conflict path"

# The pool is still usable afterwards - which is the point of returning it.
capture yan sync --task t1 --unit auth
assert_eq 0 "$rc" "$out"
assert_eq 0 "$(leases)"

# --- TRACE 4: the pool-full trap --------------------------------------------
#
# pool_size is 2 here, so two leases are enough to fill it. A full pool during
# sync is not a synchronisation problem, and the message has to say so.

yan tree get --repo demo --base main --branch yan/t1-x-s1 --holder t1/x/s1 >/dev/null
yan tree get --repo demo --base main --branch yan/t1-x-s2 --holder t1/x/s2 >/dev/null
assert_eq 2 "$(leases)"

capture yan sync --task t1 --unit auth
assert_eq 3 "$rc" "a full pool has its own exit code"
assert_contains "$out" "pool is full"
assert_contains "$out" "cannot start a new shift"
assert_not_contains "$out" "sync failed" \
	"THE trap: the reader must not go looking for a synchronisation problem"
assert_contains "$out" "yan tree status" "it says where to look instead"

yan tree return --repo demo --slot 1 >/dev/null
yan tree return --repo demo --slot 2 >/dev/null

# --- calling it on something that cannot be synced --------------------------

lib 'task_unit_add t1 nobranch demo main'
capture yan sync --task t1 --unit nobranch
assert_eq 2 "$rc"
assert_contains "$out" "no integration branch yet"

printf 'ok\n'
