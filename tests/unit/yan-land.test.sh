#!/usr/bin/env bash
#
# Phase 9 Trace bullet 5, second half:
#
#   `yan land` MERGES ONLY WHEN `user` ASKS
#
# boundaries.md §9.2 is the whole reason `yan mr` and `yan land` are two files:
#
#   open the outbound MR    yan, on its own - opening one is reversible
#   merge it into target    `user` HAS TO ASK FOR IT
#
# After this command runs, `target` contains the work and colleagues are
# looking at it. So the authority is checked before anything is read, and it is
# not softened by being on a terminal: `user` saying so is the input, and no
# prompt can supply it on their behalf.
#
# The second thing this file guards is order. `needs` records the landing order
# (branching.md §6.4), so the units are topologically sorted and the run stops
# at the first one that will not land - carrying on past a failure would land a
# unit before the one it needs, which is exactly what `needs` exists to stop.
#
# The forge is the stand-in and replays a fixed sequence of MR states
# (architecture.md §7). Nothing here touches the network.
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
export YAN_STUB_FORGE_DIR=$tmp/forge
yan=$home/bin/yan
mkdir -p "$home/repos/monorepo-x"

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

# `web` is declared FIRST and needs `api`, so declaration order and landing
# order disagree. If the sort did nothing, this test would still pass by
# accident - which is why it is written the wrong way round.
task_init t042 'unify the auth header'
task_unit_add t042 web monorepo-x master --branch feat/web --needs api
task_unit_add t042 api monorepo-x master --branch feat/api
task_unit_set t042 web mr 'https://forge.invalid/x/-/merge_requests/2'
task_unit_set t042 api mr 'https://forge.invalid/x/-/merge_requests/1'

fcalls() { cat "$tmp/forge/calls" 2>/dev/null || true; }
reset_forge() { rm -rf "$tmp/forge"; }

# --- without `user` asking, nothing happens at all --------------------------

reset_forge
capture env bash "$yan" land --task t042
assert_eq 2 "$rc"
assert_contains "$out" "'user' has to ask"
assert_contains "$out" '--user-asked'
assert_eq '' "$(fcalls)" 'the forge is not even asked a question'

# A terminal makes no difference: this is not a value a prompt could collect.
capture env bash "$yan" land --task t042 <"/dev/null"
assert_eq 2 "$rc"
assert_eq '' "$(fcalls)"

# --- with `user` asking: topologically sorted by `needs` --------------------

reset_forge
capture env YAN_STUB_FORGE_MR_STATES=open bash "$yan" land --task t042 --user-asked
assert_eq 0 "$rc" "$out"

merges=$(fcalls | sed -n 's/^mr_merge mr=\([^ ]*\).*/\1/p' | tr '\n' ' ')
assert_eq 'https://forge.invalid/x/-/merge_requests/1 https://forge.invalid/x/-/merge_requests/2 ' \
	"$merges" 'api lands before web, because web needs api'

assert_contains "$(fcalls)" 'strategy=merge'
assert_contains "$(fcalls)" 'delete_source=0' \
	'landing never deletes a branch: that decision is not this command to make'

log=$(cat "$home/tasks/t042/log.md")
assert_contains "$log" "api  landed"
assert_contains "$log" "'user' asked"

# --- an MR that is already merged is skipped, not merged twice --------------

reset_forge
capture env YAN_STUB_FORGE_MR_STATES=merged bash "$yan" land --task t042 --user-asked
assert_eq 0 "$rc" "$out"
assert_contains "$out" 'already merged'
assert_not_contains "$(fcalls)" 'mr_merge' \
	'whether it merged is the forge answer, and it was already yes'

# --- a closed MR stops the run before anything lands out of order -----------

reset_forge
capture env YAN_STUB_FORGE_MR_STATES=closed bash "$yan" land --task t042 --user-asked
assert_ne 0 "$rc"
assert_contains "$out" 'is closed, not merged'
assert_not_contains "$(fcalls)" 'mr_merge'

# --- a forge that cannot answer also stops ----------------------------------

reset_forge
capture env YAN_STUB_FORGE_MR_STATES=unknown bash "$yan" land --task t042 --user-asked
assert_ne 0 "$rc"
assert_contains "$out" 'cannot tell what state'
assert_not_contains "$(fcalls)" 'mr_merge'

# --- a forge that refuses the merge stops too -------------------------------

reset_forge
capture env YAN_STUB_FORGE_MR_STATES=open YAN_STUB_FORGE_MERGE_RC=1 \
	bash "$yan" land --task t042 --user-asked
assert_ne 0 "$rc"
assert_contains "$out" 'did not merge'
assert_eq 1 "$(fcalls | grep -c '^mr_merge' || true)" \
	'it stops at the first refusal rather than trying the next unit'

# --- naming units explicitly ------------------------------------------------

reset_forge
capture env YAN_STUB_FORGE_MR_STATES=open bash "$yan" land --task t042 --unit api --user-asked --json
assert_eq 0 "$rc" "$out"
assert_eq 1 "$(printf '%s' "$out" | jq '.landed | length')"
assert_eq api "$(printf '%s' "$out" | jq -r '.landed[0].unit')"
assert_eq merged "$(printf '%s' "$out" | jq -r '.landed[0].result')"

# --- a cycle in `needs` is refused, and nothing is merged -------------------
#
# It is not a merge order yan may pick a way out of; it is a mistake only
# `user` can resolve.

task_init t099 'circular'
task_unit_add t099 a monorepo-x master --branch feat/a --needs b
task_unit_add t099 b monorepo-x master --branch feat/b --needs a
task_unit_set t099 a mr 'https://forge.invalid/x/-/merge_requests/9'
task_unit_set t099 b mr 'https://forge.invalid/x/-/merge_requests/10'

reset_forge
capture env YAN_STUB_FORGE_MR_STATES=open bash "$yan" land --task t099 --user-asked
assert_eq 2 "$rc"
assert_contains "$out" 'cycle'
assert_eq '' "$(fcalls)"

# --- nothing to land --------------------------------------------------------

task_init t100 'no mr yet'
task_unit_add t100 solo monorepo-x master --branch feat/solo
reset_forge
capture env bash "$yan" land --task t100 --user-asked
assert_eq 2 "$rc"
assert_contains "$out" 'nothing to land'

capture env bash "$yan" land --task t100 --unit solo --user-asked
assert_eq 2 "$rc"
assert_contains "$out" 'yan mr --task t100 --unit solo'

# --- usage errors -----------------------------------------------------------

capture env bash "$yan" land --user-asked
assert_eq 2 "$rc"
assert_contains "$out" '--task is required'

capture env bash "$yan" land --task t042 --user-asked --strategy nonsense
assert_eq 2 "$rc"
assert_contains "$out" '--strategy'

printf 'ok\n'
