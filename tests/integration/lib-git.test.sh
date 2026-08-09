#!/usr/bin/env bash
#
# lib-git against real git and a real (local, bare) remote.
#
# Local filesystem only - no network. This also exercises tests/fixtures.sh,
# which every later phase leans on.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"
# shellcheck source=bin/lib-git.sh
. "$YAN_REPO_ROOT/bin/lib-git.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bare=$tmp/remote.git
clone=$tmp/work
mk_bare_remote "$bare"
mk_clone "$bare" "$clone"

# --- inspection ------------------------------------------------------------

assert_eq main "$(git_current_branch "$clone")"
assert_ok git_branch_exists "$clone" main
assert_fail git_branch_exists "$clone" nope
assert_ok git_remote_branch_exists "$clone" main origin
assert_fail git_remote_branch_exists "$clone" nope origin
assert_ok git_fetch "$clone" origin
assert_ok git_is_clean "$clone"
assert_ne "" "$(git_rev_parse "$clone" HEAD)"
assert_eq main "$(git_rev_parse "$clone" --abbrev-ref HEAD)"

# --- dirty tree, clean -fd, and the warm-reuse contract --------------------

mk_commit "$clone" .gitignore 'build/' 'ignore build output'
mkdir -p "$clone/build"
printf 'expensive to rebuild\n' >"$clone/build/cache"
printf 'stray\n' >"$clone/stray.txt"

assert_fail git_is_clean "$clone"
assert_contains "$(git_status_porcelain "$clone")" "stray.txt"

git_clean_fd "$clone"
assert_file_missing "$clone/stray.txt" "clean -fd removes untracked files"
assert_file_exists "$clone/build/cache" "clean -fd must NOT remove gitignored files (no -x)"
assert_ok git_is_clean "$clone"

git_reset_hard "$clone"
assert_ok git_is_clean "$clone"

# --- branches --------------------------------------------------------------

git_create_branch "$clone" feature main
assert_ok git_branch_exists "$clone" feature
git_create_branch "$clone" rebase-me main
assert_ok git_branch_exists "$clone" rebase-me

# --- worktrees -------------------------------------------------------------

wt=$tmp/wt
# git prints paths in its own native spelling, which on Git Bash is not the
# spelling the shell used to create them. Normalise before comparing.
wt_native=$(native_path "$wt")
git_worktree_add "$clone" "$wt" feature
assert_file_exists "$wt/README.md"
assert_contains "$(git_worktree_list "$clone")" "$wt_native"

mk_commit "$wt" feature.txt 'from the feature branch' 'add feature.txt'

# --- push, containment, remote deletion ------------------------------------

assert_ok git_push "$clone" origin feature
assert_ok git_remote_branch_exists "$clone" feature origin

git_fetch "$wt" origin >/dev/null
assert_contains "$(git_branches_containing_head "$wt")" "origin/feature"

git_delete_remote_branch "$clone" origin feature
assert_fail git_remote_branch_exists "$clone" feature origin

git_worktree_remove "$clone" "$wt"
assert_file_missing "$wt"
assert_not_contains "$(git_worktree_list "$clone")" "$wt_native"

# --- merge -----------------------------------------------------------------

assert_eq main "$(git_current_branch "$clone")"
git_merge "$clone" feature --no-edit >/dev/null
assert_file_exists "$clone/feature.txt"

# --- diff ------------------------------------------------------------------

assert_contains "$(git_diff_name_only "$clone" HEAD~1 HEAD)" "feature.txt"

# --- checkout + rebase -----------------------------------------------------

git_checkout "$clone" rebase-me >/dev/null 2>&1
assert_eq rebase-me "$(git_current_branch "$clone")"
mk_commit "$clone" rebase.txt 'work in progress' 'add rebase.txt'
assert_file_missing "$clone/feature.txt"

assert_ok git_rebase "$clone" main
assert_file_exists "$clone/feature.txt" "rebase must bring main's history under rebase-me"
assert_file_exists "$clone/rebase.txt"

git_checkout "$clone" main >/dev/null 2>&1

# --- clone -----------------------------------------------------------------

git_clone "$tmp" "$bare" second >/dev/null 2>&1
assert_file_exists "$tmp/second/README.md"

# --- the directory argument is never optional, even on real repos ----------

assert_fail git_current_branch
assert_fail git_status_porcelain ""

printf 'ok\n'
