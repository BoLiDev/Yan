#!/usr/bin/env bash
#
# Trace bullet 3: lib-git refuses to run without an explicit directory
# argument, and never uses a force flag.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=bin/lib-git.sh
. "$YAN_REPO_ROOT/bin/lib-git.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

LIBGIT=$YAN_REPO_ROOT/bin/lib-git.sh

# --- every function refuses an empty or bogus directory --------------------

fns=(
	git_current_branch
	git_branch_exists
	git_remote_branch_exists
	git_fetch
	git_checkout
	git_create_branch
	git_status_porcelain
	git_is_clean
	git_push
	git_delete_remote_branch
	git_rebase
	git_merge
	git_worktree_add
	git_worktree_remove
	git_worktree_list
	git_worktree_prune
	git_reset_hard
	git_clean_fd
	git_branches_containing_head
	git_diff_name_only
	git_rev_parse
	git_clone
)

for fn in "${fns[@]}"; do
	# The function must exist at all.
	assert_ok declare -F "$fn"

	# No argument at all.
	capture "$fn"
	assert_ne 0 "$rc" "$fn must refuse to run with no directory argument"
	assert_contains "$out" "lib-git:" "$fn must explain itself"

	# An empty directory argument.
	capture "$fn" ""
	assert_ne 0 "$rc" "$fn must refuse an empty directory argument"

	# A directory that does not exist.
	capture "$fn" "$tmp/definitely-not-a-directory"
	assert_ne 0 "$rc" "$fn must refuse a non-existent directory"
	assert_contains "$out" "not a directory"
done

capture git_current_branch
assert_contains "$out" "a directory argument is required"
assert_contains "$out" "never uses the current working directory"

# --- required arguments beyond the directory -------------------------------

assert_fail git_branch_exists "$tmp"
assert_fail git_create_branch "$tmp" newbranch
assert_fail git_delete_remote_branch "$tmp" origin
assert_fail git_worktree_add "$tmp"
assert_fail git_clone "$tmp" "https://example.invalid/x.git"

# --- the source contains no force flag -------------------------------------
#
# boundaries.md §9.2 lists force-pushing and forced destruction as forbidden.
# This is a source-level check on purpose: a runtime test can only cover the
# paths it happens to exercise.

capture grep -rn -- '--force' "$YAN_REPO_ROOT/bin"
assert_ne 0 "$rc" "bin/ must not contain a force flag: $out"

capture grep -rnE 'git[^;&|]*push[^;&|]*[[:space:]]-f([[:space:]]|"|$)' "$YAN_REPO_ROOT/bin"
assert_ne 0 "$rc" "bin/ must not force-push: $out"

capture grep -rnE 'git[^;&|]*worktree[^;&|]*[[:space:]]-f([[:space:]]|"|$)' "$YAN_REPO_ROOT/bin"
assert_ne 0 "$rc" "bin/ must not force worktree removal: $out"

# git clean must be -fd and never -x (worktree.md warm-reuse contract).
capture grep -nE 'clean[^;&|]*-[a-zA-Z]*x' "$LIBGIT"
assert_ne 0 "$rc" "git clean must never use -x: $out"
assert_ok grep -qE 'clean -fd' "$LIBGIT"

# --- git_push actively refuses a force flag handed to it -------------------

assert_fail git_push "$tmp" origin main --force
assert_fail git_push "$tmp" origin main -f
assert_fail git_push "$tmp" origin main --force-with-lease
capture git_push "$tmp" origin main --force
assert_contains "$out" "refusing to force-push"

# --- double sourcing is safe ----------------------------------------------

# shellcheck source=bin/lib-git.sh
. "$YAN_REPO_ROOT/bin/lib-git.sh"
assert_ok declare -F git_current_branch

printf 'ok\n'
