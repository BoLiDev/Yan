#!/usr/bin/env bash
#
# Phase 4, Trace bullets 2 and 3: forge_mr_state is only ever one of
# {merged, closed, open, unknown} and forge_ci_state only one of
# {green, red, pending, none}.
#
# These are the highest-value tests in the phase. The mapping from a forge's
# raw JSON to yan's vocabulary is where a wrong confident answer would come
# from, so every case below is driven by a payload that a real CLI really
# printed (GitHub) or by a shape taken from the published API documentation
# (GitLab - see tests/fixtures/forge/PROVENANCE.json, which is explicit about
# which is which).
#
# No network. The fixtures are files.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=bin/lib-forge.sh
. "$YAN_REPO_ROOT/bin/lib-forge.sh"

FX=$YAN_REPO_ROOT/tests/fixtures/forge

fx() { cat -- "$FX/$1"; }

# --- GitHub: merge request state ------------------------------------------

assert_eq merged "$(_forge_github_map_mr_state "$(fx github/mr-merged-mergecommit.json)")" \
	"a pull request merged with a merge commit is merged"

# The awkward one. cli/cli#14103 was SQUASH-merged: its head commit is not an
# ancestor of the base branch, and the head branch has since been deleted.
# Anything that reasoned from local git ancestry would get this wrong.
assert_eq merged "$(_forge_github_map_mr_state "$(fx github/mr-merged-squash-branch-deleted.json)")" \
	"a squash-merged pull request whose branch is gone is still merged"

assert_eq open "$(_forge_github_map_mr_state "$(fx github/mr-open.json)")"
assert_eq closed "$(_forge_github_map_mr_state "$(fx github/mr-closed-unmerged.json)")" \
	"closed without merging is closed, and being a draft changes nothing"

# What the mapper is actually handed when the API refuses: gh exits non-zero
# and stdout is empty. Never a crash, never a confident wrong answer.
assert_eq unknown "$(_forge_github_map_mr_state "$(fx github/mr-api-error.stdout.txt)")" \
	"an empty payload is unknown"
assert_eq unknown "$(_forge_github_map_mr_state "$(fx github/mr-api-error.stderr.txt)")" \
	"an error message where JSON was expected is unknown"
assert_eq unknown "$(_forge_github_map_mr_state '')"
assert_eq unknown "$(_forge_github_map_mr_state 'not json at all')"
assert_eq unknown "$(_forge_github_map_mr_state '[]')" "an array is not a pull request"
assert_eq unknown "$(_forge_github_map_mr_state '{"state":"SOMETHING_NEW","mergedAt":null}')" \
	"an unrecognised state does not leak through as a fifth value"

# The REST spelling, in case a caller ever feeds `gh api` output through: there
# `state` is `closed` and merged-ness lives in a separate boolean.
assert_eq merged "$(_forge_github_map_mr_state '{"state":"closed","merged":true}')"
assert_eq closed "$(_forge_github_map_mr_state '{"state":"closed","merged":false}')"

# --- GitHub: CI ------------------------------------------------------------

assert_eq none "$(_forge_github_map_ci_state "$(fx github/ci-none.json)")" \
	"an empty rollup means this repository ran no CI"
assert_eq green "$(_forge_github_map_ci_state "$(fx github/ci-checks-green.json)")" \
	"checks API, SUCCESS and SKIPPED only"
assert_eq red "$(_forge_github_map_ci_state "$(fx github/ci-checks-mixed-red.json)")" \
	"mixed check results: any failure means red"
assert_eq pending "$(_forge_github_map_ci_state "$(fx github/ci-checks-running.json)")" \
	"IN_PROGRESS check runs (conclusion is the empty string) mean pending"

# The legacy commit-status API. GitHub's other CI model, in the same array.
assert_eq green "$(_forge_github_map_ci_state "$(fx github/ci-status-green.json)")"
assert_eq pending "$(_forge_github_map_ci_state "$(fx github/ci-status-pending.json)")" \
	"legacy PENDING statuses mixed with finished check runs are pending"
assert_eq red "$(_forge_github_map_ci_state "$(fx github/ci-status-red.json)")"

# Precedence: a run that is still going but has already failed is red. The
# caller can dispatch the fix now; waiting for the rest only delays it.
assert_eq red "$(_forge_github_map_ci_state "$(fx github/ci-red-beats-pending.json)")"

assert_eq none "$(_forge_github_map_ci_state '{"statusCheckRollup":null}')" \
	"gh prints null for a pull request with no checks"
assert_eq pending "$(_forge_github_map_ci_state '{}')" \
	"a payload with no rollup at all is not none - that would be a confident wrong answer"
assert_eq pending "$(_forge_github_map_ci_state '')"
assert_eq pending "$(_forge_github_map_ci_state 'GraphQL: Could not resolve to a PullRequest')"
assert_eq green "$(_forge_github_map_ci_state '{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"NEUTRAL"},{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SKIPPED"}]}')" \
	"neutral and skipped are not failures"
assert_eq red "$(_forge_github_map_ci_state '{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"TIMED_OUT"}]}')"
assert_eq red "$(_forge_github_map_ci_state '{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"CANCELLED"}]}')"
assert_eq pending "$(_forge_github_map_ci_state '{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"STALE"}]}')" \
	"a superseded check is neither a pass nor a failure"
assert_eq pending "$(_forge_github_map_ci_state '{"statusCheckRollup":[{"__typename":"CheckRun","status":"QUEUED","conclusion":""}]}')"

# --- GitLab: merge request state ------------------------------------------
#
# Documentation-derived fixtures. Nobody has run these against a live server.

assert_eq merged "$(_forge_gitlab_map_mr_state "$(fx gitlab/mr-merged.json)")"
assert_eq open "$(_forge_gitlab_map_mr_state "$(fx gitlab/mr-opened.json)")" \
	"GitLab says opened; yan says open"
assert_eq closed "$(_forge_gitlab_map_mr_state "$(fx gitlab/mr-closed.json)")"
assert_eq open "$(_forge_gitlab_map_mr_state "$(fx gitlab/mr-locked.json)")" \
	"GitLab's fourth state, locked, collapses onto open - §6.4 gets four values, not five"
assert_eq unknown "$(_forge_gitlab_map_mr_state "$(fx gitlab/mr-state-unknown-to-yan.json)")"
assert_eq unknown "$(_forge_gitlab_map_mr_state '')"
assert_eq unknown "$(_forge_gitlab_map_mr_state 'error: 404 Not Found')"
assert_eq merged "$(_forge_gitlab_map_mr_state '{"state":"opened","merged_at":"2026-05-14T03:38:31.354Z"}')" \
	"merged_at settles it even when state disagrees"

# --- GitLab: CI ------------------------------------------------------------

assert_eq green "$(_forge_gitlab_map_ci_state "$(fx gitlab/mr-merged.json)")"
assert_eq pending "$(_forge_gitlab_map_ci_state "$(fx gitlab/mr-opened.json)")" "running is pending"
assert_eq pending "$(_forge_gitlab_map_ci_state "$(fx gitlab/mr-locked.json)")" \
	"manual means it is waiting for a human, which is pending"
assert_eq red "$(_forge_gitlab_map_ci_state "$(fx gitlab/ci-failed.json)")"
assert_eq red "$(_forge_gitlab_map_ci_state "$(fx gitlab/ci-canceled.json)")" \
	"a cancelled pipeline did not pass"
assert_eq none "$(_forge_gitlab_map_ci_state "$(fx gitlab/ci-skipped.json)")" \
	"skipped means nothing ran"
assert_eq pending "$(_forge_gitlab_map_ci_state "$(fx gitlab/ci-pending-created.json)")"
assert_eq none "$(_forge_gitlab_map_ci_state "$(fx gitlab/ci-no-pipeline.json)")"
assert_eq green "$(_forge_gitlab_map_ci_state "$(fx gitlab/ci-legacy-pipeline-field.json)")" \
	'older GitLab exposes pipeline rather than head_pipeline'
assert_eq pending "$(_forge_gitlab_map_ci_state '')"
assert_eq pending "$(_forge_gitlab_map_ci_state '{"head_pipeline":{"status":"canceling"}}')"
assert_eq pending "$(_forge_gitlab_map_ci_state '{"head_pipeline":{"status":"who_knows"}}')"

# --- every fixture lands inside the closed set -----------------------------
#
# Not a spot check: run the lot through both mappers and refuse anything that
# is not a member.

while IFS= read -r f; do
	[ -n "$f" ] || continue
	body=$(cat -- "$f")
	for v in "$(_forge_github_map_mr_state "$body")" "$(_forge_gitlab_map_mr_state "$body")"; do
		case $v in
		merged | closed | open | unknown) ;;
		*) _assert_die "fixture $f produced '$v', which is not a merge request state" ;;
		esac
	done
	for v in "$(_forge_github_map_ci_state "$body")" "$(_forge_gitlab_map_ci_state "$body")"; do
		case $v in
		green | red | pending | none) ;;
		*) _assert_die "fixture $f produced '$v', which is not a CI state" ;;
		esac
	done
done < <(find "$FX" -type f \( -name '*.json' -o -name '*.txt' \) ! -name 'PROVENANCE.json' | LC_ALL=C sort)

# --- the gates themselves --------------------------------------------------

assert_eq unknown "$(_forge_gate_mr_state banana 2>/dev/null)" \
	"the gate is the last statement on every path out; a fifth value cannot escape"
assert_eq pending "$(_forge_gate_ci_state banana 2>/dev/null)"

# --- provenance is complete and honest -------------------------------------
#
# A fixture with no provenance entry is a fixture nobody can trust later.

while IFS= read -r f; do
	[ -n "$f" ] || continue
	rel=${f#"$FX"/}
	entry=$(jq -r --arg k "$rel" '.files[$k] // empty' "$FX/PROVENANCE.json")
	if [ -z "$entry" ]; then
		_assert_die "fixture $rel has no entry in PROVENANCE.json"
	fi
	verified=$(jq -r --arg k "$rel" '.files[$k].verified' "$FX/PROVENANCE.json")
	case $rel in
	github/*) assert_eq true "$verified" "$rel came off the wire and must say so" ;;
	gitlab/*) assert_eq false "$verified" "$rel is documentation-derived and must not claim otherwise" ;;
	esac
done < <(find "$FX" -type f \( -name '*.json' -o -name '*.txt' \) ! -name 'PROVENANCE.json' | LC_ALL=C sort)

printf 'ok\n'
