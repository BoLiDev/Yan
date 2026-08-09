#!/usr/bin/env bash
#
# Phase 4, end to end against the real GitHub API. Opt-in: tests/run.sh --e2e.
#
# READ-ONLY. This file opens nothing, merges nothing and closes nothing, on
# this repository or any other. It asks about pull requests that already exist
# and checks that the answers land in yan's closed sets.
#
# Skips cleanly, with a reason, when gh is missing or not logged in.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

skip() {
	printf 'SKIP  %s\n' "$1"
	exit 0
}

command -v gh >/dev/null 2>&1 || skip 'gh is not on PATH - install the GitHub CLI to run the forge e2e test'
gh auth status >/dev/null 2>&1 || skip 'gh is not authenticated - run: gh auth login'

# shellcheck source=bin/lib-forge.sh
. "$YAN_REPO_ROOT/bin/lib-forge.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mk_yan_home "$tmp/home"
export YAN_HOME=$tmp/home
mk_config "$tmp/home" '{"version":1,"forge":{"kind":"github"}}'

REPO=BoLiDev/Yan

# The one that matters: a genuinely merged pull request on this repository.
assert_eq merged "$(forge_mr_state --mr 1 --repo "$REPO")" \
	"PR #1 of this repository is merged"

# The same pull request named the way yan actually stores it - by URL.
assert_eq merged "$(forge_mr_state --mr "https://github.com/$REPO/pull/1")"

# This repository runs no CI, so the rollup is empty.
assert_eq none "$(forge_ci_state --mr 1 --repo "$REPO")"

# A real API refusal. Not a crash, and not a confident wrong answer.
rc=0
out=$(forge_mr_state --mr 99999999 --repo "$REPO" 2>/dev/null) || rc=$?
assert_eq 0 "$rc"
assert_eq unknown "$out"

rc=0
out=$(forge_ci_state --mr 99999999 --repo "$REPO" 2>/dev/null) || rc=$?
assert_eq 0 "$rc"
assert_eq pending "$out"

# A squash-merged pull request in a public repository, whose head branch has
# since been deleted. Nothing local could work this out.
assert_eq merged "$(forge_mr_state --mr https://github.com/cli/cli/pull/14103)"

printf 'ok (read-only)\n'
