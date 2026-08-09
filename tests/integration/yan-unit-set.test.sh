#!/usr/bin/env bash
#
# Phase 6, Trace bullet 2: `unit set --branch` archives the old round into
# history[] with `at`, in ONE ATOMIC OPERATION (architecture.md §5.1,
# td branching.md §6.3-§6.4).
#
# Two things are being pinned here, and they pull in opposite directions.
#
#   All of it, or none of it. The rotation is decide `end` -> append the old
#   branch/target/mr to history[] with `at` -> overwrite the current fields ->
#   log. A file left with the old round archived but the new branch not yet
#   recorded would be a round that exists twice. So the refusal paths are
#   checked against a byte-for-byte copy of task.json: nothing moved.
#
#   `end` is looked up, not remembered. merged -> delivered; closed, or no mr
#   at all -> abandoned; still open or unreachable -> ASK `user`, and yan
#   refuses to decide. The forge answers through tests/stub/lib-forge.sh, which
#   replays a programmed sequence, so `open -> merged` is reproducible and no
#   network is involved.
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
YAN=$home/bin/yan

# Swap the forge seam. mk_yan_home copies bin/ into a throwaway home precisely
# so a test can put its own files there; dropping the stand-in over
# bin/lib-forge.sh swaps the seam for every subcommand in this home at once.
cp "$YAN_REPO_ROOT/tests/stub/lib-forge.sh" "$home/bin/lib-forge.sh"
export YAN_STUB_FORGE_DIR=$tmp/forge

bare=$tmp/remote.git
clone=$home/repos/demo
mk_bare_remote "$bare"
mk_clone "$bare" "$clone"

TASK=$home/tasks/t1/task.json
MR=https://forge.invalid/acme/demo/-/merge_requests/7

yan() { env YAN_HOME="$home" bash "$YAN" "$@"; }

lib() { # lib <shell-code> [args...] - run something against lib-task directly
	local code=$1
	shift
	env YAN_HOME="$home" bash -c '
		set -euo pipefail
		# shellcheck source=/dev/null
		. "$YAN_HOME/bin/lib-task.sh"
		eval "$1"
	' _ "$code" "$@"
}

unit_field() { # unit_field <unit> <field>
	jq -r --arg u "$1" --arg f "$2" '.units[] | select(.name == $u) | .[$f] // ""' "$TASK"
}

hist() { # hist <unit> <index> <field>
	jq -r --arg u "$1" --arg f "$3" \
		".units[] | select(.name == \$u) | .history[$2] | .[\$f] // \"\"" "$TASK"
}

snapshot() { cp "$TASK" "$tmp/before.json"; }
assert_untouched() {
	assert_eq "$(cat "$tmp/before.json")" "$(cat "$TASK")" \
		"${1:-a refusal must leave task.json exactly as it was}"
}

lib 'task_init t1 "a demo task"'
yan unit add --task t1 --unit auth --repo demo --target main >/dev/null
yan unit add --task t1 --unit proto --repo demo --target main >/dev/null
assert_eq yan/t1-auth-r1 "$(unit_field auth branch)"

# --- a round with no MR was never delivered, and it has to say why ----------

snapshot
capture yan unit set --task t1 --unit auth --branch feat/auth-r2
assert_eq 2 "$rc" "abandoning without a reason is refused"
assert_contains "$out" "--reason is required"
assert_untouched

capture yan unit set --task t1 --unit auth --branch feat/auth-r2 \
	--reason 'the approach was wrong, starting again from the interface' --at 2026-08-25
assert_eq 0 "$rc" "$out"

# TRACE 2: the old round is in history[], with `at`, and the current fields
# have already moved on. One write, both halves.
assert_eq 1 "$(jq '.units[] | select(.name == "auth") | .history | length' "$TASK")"
assert_eq yan/t1-auth-r1 "$(hist auth 0 branch)"
assert_eq main "$(hist auth 0 target)"
assert_eq abandoned "$(hist auth 0 end)"
assert_eq 2026-08-25 "$(hist auth 0 at)"
assert_eq '' "$(hist auth 0 mr)" "a round that never opened an MR stores no mr field"
assert_eq feat/auth-r2 "$(unit_field auth branch)"
assert_eq '' "$(unit_field auth mr)"

# An abandoned round's new branch is cut from the OLD BRANCH, so the dropped
# work is still reachable (branching.md §6.3).
assert_eq "$(fx_git -C "$clone" rev-parse yan/t1-auth-r1)" \
	"$(fx_git -C "$clone" rev-parse feat/auth-r2)"

# And the log line says why. This is the one reason nobody remembers later.
log=$(cat "$home/tasks/t1/log.md")
assert_contains "$log" "auth  abandoned yan/t1-auth-r1 → feat/auth-r2"
assert_contains "$log" "the approach was wrong, starting again from the interface"
assert_contains "$log" "based on yan/t1-auth-r1"

# The forge was never asked: there was no MR to ask about, so there was
# nothing that could have been delivered.
assert_file_missing "$tmp/forge/calls" "an empty mr field is conclusive on its own"

# --- an open MR is not an ending. yan refuses to decide ---------------------

lib 'task_unit_set t1 auth mr "$2"' "$MR"
snapshot

export YAN_STUB_FORGE_MR_STATES="open"
capture yan unit set --task t1 --unit auth --branch feat/auth-r3
assert_eq 4 "$rc" "still open means 'ask user', and that is its own exit code"
assert_contains "$out" "NOT OVER"
assert_contains "$out" "Ask 'user'"
assert_contains "$out" "Nothing was changed"
assert_untouched
assert_fail fx_git -C "$clone" show-ref --verify --quiet refs/heads/feat/auth-r3 \
	"a refusal creates no branch either"

# `user` has now answered. --end is the only way that answer reaches the
# history, and abandoning still has to say why.
capture yan unit set --task t1 --unit auth --branch feat/auth-r3 --end abandoned
assert_eq 2 "$rc"
assert_contains "$out" "--reason is required"
assert_untouched

capture yan unit set --task t1 --unit auth --branch feat/auth-r3 \
	--end abandoned --reason 'user asked to drop it; the ticket was descoped' --at 2026-08-26
assert_eq 0 "$rc" "$out"
assert_eq 2 "$(jq '.units[] | select(.name == "auth") | .history | length' "$TASK")"
assert_eq abandoned "$(hist auth 1 end)"
assert_eq "$MR" "$(hist auth 1 mr)" "the MR URL is stored: it is awkward to look up once the branch is gone"
assert_eq feat/auth-r3 "$(unit_field auth branch)"

# --- an unreachable forge is also a question, not a guess -------------------

lib 'task_unit_set t1 auth mr "$2"' "$MR"
snapshot
export YAN_STUB_FORGE_MR_STATES="unknown"
capture yan unit set --task t1 --unit auth --branch feat/auth-r4
assert_eq 4 "$rc"
assert_contains "$out" "cannot tell how this round ended"
assert_untouched

# --- merged means delivered, and the next round starts from target ----------

export YAN_STUB_FORGE_MR_STATES="merged"
capture yan unit set --task t1 --unit auth --branch feat/auth-r4 --at 2026-08-27
assert_eq 0 "$rc" "$out"
assert_eq delivered "$(hist auth 2 end)"
assert_eq 2026-08-27 "$(hist auth 2 at)"
assert_eq feat/auth-r4 "$(unit_field auth branch)"
assert_eq "$(fx_git -C "$clone" rev-parse origin/main)" "$(fx_git -C "$clone" rev-parse feat/auth-r4)" \
	"a delivered round is followed by a branch off target, which already contains it"
assert_contains "$(cat "$home/tasks/t1/log.md")" "auth  delivered feat/auth-r3 → feat/auth-r4"

# Once the conclusion is in the history, the forge is never asked about that
# round again: history[0..2] stay exactly as they were written.
assert_eq abandoned "$(hist auth 0 end)"
assert_eq abandoned "$(hist auth 1 end)"

# --- closed means abandoned -------------------------------------------------

lib 'task_unit_set t1 proto mr "$2"' "$MR"
export YAN_STUB_FORGE_MR_STATES="closed"
capture yan unit set --task t1 --unit proto --branch feat/proto-r2 \
	--reason 'the RFC was rejected upstream'
assert_eq 0 "$rc" "$out"
assert_eq abandoned "$(hist proto 0 end)"

# --- the built-in default carries the NEXT round's number -------------------
#
# `--branch` with no name means "start a new round, and let the configured
# authority name it". With no hook installed that is yan/<task>-<unit>-r<n>,
# n = len(history) + 1 - counted AFTER this rotation's entry is appended. Off
# by one and the default would hand back the name of the branch being
# replaced, which is precisely the collision the round number exists to stop:
# the same branch name cannot be created twice.

assert_eq 1 "$(jq '.units[] | select(.name == "proto") | .history | length' "$TASK")"
capture yan unit set --task t1 --unit proto --branch --reason 'starting the third round from scratch'
assert_eq 0 "$rc" "$out"
assert_eq yan/t1-proto-r3 "$(unit_field proto branch)" \
	"round 1 was yan/t1-proto-r1, round 2 was feat/proto-r2, so this is r3"
assert_eq 2 "$(jq '.units[] | select(.name == "proto") | .history | length' "$TASK")"
assert_eq feat/proto-r2 "$(hist proto 1 branch)"

# --- the three plain scalars, each of them a decision -----------------------

capture yan unit set --task t1 --unit proto --target release/8
assert_eq 0 "$rc" "$out"
assert_eq release/8 "$(unit_field proto target)"

capture yan unit set --task t1 --unit proto --mode branch
assert_eq 0 "$rc" "$out"
assert_eq branch "$(unit_field proto mode)"

capture yan unit set --task t1 --unit proto --mode sideways
assert_ne 0 "$rc" "mode comes from a closed set"

capture yan unit set --task t1 --unit proto --scope libs/proto --scope libs/shared
assert_eq 0 "$rc" "$out"
assert_eq 'libs/proto libs/shared' \
	"$(jq -r '.units[] | select(.name == "proto") | .scope | join(" ")' "$TASK")"

# --- the same branch twice is not a new round -------------------------------

snapshot
capture yan unit set --task t1 --unit auth --branch feat/auth-r4 --end delivered
assert_eq 2 "$rc"
assert_contains "$out" "same as the current one"
assert_untouched

# --- history is append-only, and the whole file is still valid --------------

assert_ok jq empty "$TASK"
assert_eq 3 "$(jq '.units[] | select(.name == "auth") | .history | length' "$TASK")"
assert_eq yan/t1-auth-r1 "$(hist auth 0 branch)" "history[0] is never rewritten"

printf 'ok\n'
