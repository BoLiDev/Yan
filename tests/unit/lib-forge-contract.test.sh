#!/usr/bin/env bash
#
# Phase 4, Trace bullet 1: callers speak only forge vocabulary, and no gh or
# glab flag leaks upward.
#
# The forge CLIs are replaced by fakes on PATH that record their argv and print
# whatever the test tells them to, so this exercises the real lib-forge.sh -
# argument shaping, host routing, provider selection, failure handling - with
# no network at all. A machine with no gh login passes this file.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"
# shellcheck source=bin/lib-forge.sh
. "$YAN_REPO_ROOT/bin/lib-forge.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mk_yan_home "$tmp/home"
export YAN_HOME=$tmp/home

# --- fake forge CLIs -------------------------------------------------------

fakebin=$tmp/fakebin
mkdir -p "$fakebin"
export FORGE_TEST_LOG=$tmp/argv.log
export FORGE_TEST_OUT=
export FORGE_TEST_RC=0
: >"$FORGE_TEST_LOG"

mk_fake_cli() { # <name>
	cat >"$fakebin/$1" <<'EOF'
#!/usr/bin/env bash
# Records its own name, its argv one bracketed word at a time, and the host
# environment variable it was handed. Prints canned output.
{
	printf '%s' "$(basename "$0")"
	for a in "$@"; do printf ' [%s]' "$a"; done
	printf ' host=%s%s\n' "${GH_HOST:-}" "${GITLAB_HOST:-}"
} >>"$FORGE_TEST_LOG"
if [ "${FORGE_TEST_RC:-0}" -ne 0 ]; then
	printf 'fake %s: the forge said no\n' "$(basename "$0")" >&2
	exit "${FORGE_TEST_RC}"
fi
# gh.exe and glab.exe are native Windows programs and terminate their lines
# with CRLF on Git Bash. FORGE_TEST_CRLF=1 makes the fake do the same.
if [ "${FORGE_TEST_CRLF:-0}" = 1 ]; then
	printf '%s\r\n' "${FORGE_TEST_OUT:-}"
else
	printf '%s\n' "${FORGE_TEST_OUT:-}"
fi
EOF
	chmod +x "$fakebin/$1"
}

mk_fake_cli gh
mk_fake_cli glab
export PATH="$fakebin:$PATH"

log_reset() { : >"$FORGE_TEST_LOG"; }
log() { cat "$FORGE_TEST_LOG"; }

err=
run_forge() {
	rc=0
	out=$("$@" 2>"$tmp/err") || rc=$?
	err=$(cat "$tmp/err")
	return 0
}

# --- GitHub is what conf/config.json selects -------------------------------

FORGE_TEST_OUT='{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}'
log_reset
run_forge forge_mr_state --mr 7 --repo acme/widget
assert_eq 0 "$rc"
assert_eq merged "$out"
assert_contains "$(log)" 'gh [pr] [view] [7] [--repo] [acme/widget] [--json] [state,mergedAt]'
assert_not_contains "$(log)" 'glab' "forge.kind is github, so glab is never run"

# A merge request URL already names the repository; --repo would only be a
# chance to disagree with it.
log_reset
run_forge forge_mr_state --mr https://github.com/acme/widget/pull/7
assert_eq merged "$out"
assert_contains "$(log)" 'gh [pr] [view] [https://github.com/acme/widget/pull/7] [--json]'
assert_not_contains "$(log)" '[--repo]'

FORGE_TEST_OUT='{"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"}]}'
log_reset
run_forge forge_ci_state --mr 7 --repo acme/widget
assert_eq 0 "$rc"
assert_eq red "$out"
assert_contains "$(log)" '[--json] [statusCheckRollup]'

# --- carriage returns ------------------------------------------------------
#
# jq.exe writes CRLF on Git Bash and so do gh.exe and glab.exe. A single-value
# `$(...)` hides it, so the failure is invisible until something multi-line
# appears - at which point an exact comparison against a closed set fails for
# no visible reason. Everything below runs the whole path with CRLF output.

export FORGE_TEST_CRLF=1
FORGE_TEST_OUT='{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}'
run_forge forge_mr_state --mr 7 --repo acme/widget
assert_eq merged "$out"

# Compare bytes, not a value that command substitution has already tidied up.
forge_mr_state --mr 7 --repo acme/widget >"$tmp/raw" 2>/dev/null
if grep -q $'\r' "$tmp/raw"; then
	_assert_die 'forge_mr_state emitted a carriage return'
fi

FORGE_TEST_OUT='https://github.com/acme/widget/pull/42'
run_forge forge_mr_create --source feat/x --target main --title x --body b
assert_eq 'https://github.com/acme/widget/pull/42' "$out"
forge_mr_create --source feat/x --target main --title x --body b >"$tmp/raw" 2>/dev/null
if grep -q $'\r' "$tmp/raw"; then
	_assert_die 'forge_mr_create emitted a carriage return in the URL'
fi

# A merge request URL that arrived with a stray CR - from a JSON file read on
# Windows, say - must still identify the same merge request.
FORGE_TEST_OUT='{"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z"}'
log_reset
run_forge forge_mr_state --mr "$(printf 'https://github.com/acme/widget/pull/7\r')"
assert_eq merged "$out"
assert_contains "$(log)" '[https://github.com/acme/widget/pull/7]'

# And the config reader, on a filter that really does return several lines -
# the only shape where the damage is visible, because command substitution
# quietly tidies up the trailing CRLF of a single-line answer.
mk_config "$tmp/home" '{"version":1,"forge":{"kind":"github","host":"github.com"}}'
v=$(_forge_config_get '.forge | to_entries[] | .key')
assert_contains "$v" 'kind'
assert_contains "$v" 'host'
if [ "$v" != "${v//$'\r'/}" ]; then
	_assert_die 'reading configuration left carriage returns behind'
fi
mk_config "$tmp/home" '{"version":1,"forge":{"kind":"github"}}'

unset FORGE_TEST_CRLF

# --- the forge cannot be reached ------------------------------------------
#
# Never a crash, never a wrong confident answer, and always a value from the
# closed set, so a caller running under `set -e` branches instead of dying.

FORGE_TEST_RC=1
FORGE_TEST_OUT=
run_forge forge_mr_state --mr 7 --repo acme/widget
assert_eq 0 "$rc" "an unreachable forge is an answer, not an error"
assert_eq unknown "$out"
assert_contains "$err" 'cannot ask the forge'
assert_contains "$err" 'the forge said no' "the CLI's own words are quoted in the note, not swallowed"

run_forge forge_ci_state --mr 7 --repo acme/widget
assert_eq 0 "$rc"
assert_eq pending "$out" "an unreachable forge is pending for CI - never green, never red, never none"

FORGE_TEST_RC=1
run_forge forge_mr_merge --mr 7 --repo acme/widget
assert_eq 1 "$rc" "an action that did not work exits 1"
FORGE_TEST_RC=0

# Junk on stdout with a zero exit is still not an answer.
FORGE_TEST_OUT='<html>502 Bad Gateway</html>'
run_forge forge_mr_state --mr 7
assert_eq unknown "$out"
run_forge forge_ci_state --mr 7
assert_eq pending "$out"

# --- no gh or glab flag may be smuggled through ---------------------------

run_forge forge_mr_state --mr 7 --admin
assert_eq 2 "$rc"
assert_contains "$err" "never gh's or glab's"

run_forge forge_mr_state --mr 7 --json state
assert_eq 2 "$rc"

run_forge forge_mr_merge --mr 7 --auto
assert_eq 2 "$rc"

# Yan's own flags are still scoped per verb: --body belongs to create.
run_forge forge_mr_state --mr 7 --body hello
assert_eq 2 "$rc"
assert_contains "$err" '--body is not accepted here'

run_forge forge_mr_state --repo acme/widget
assert_eq 2 "$rc"
assert_contains "$err" '--mr is required'

run_forge forge_mr_state --mr
assert_eq 2 "$rc"
assert_contains "$err" 'needs a value'

run_forge forge_mr_merge --mr 7 --strategy fast-forward
assert_eq 2 "$rc"
assert_contains "$err" 'merge, squash or rebase'

run_forge forge_mr_create --source feat/x --title 'x'
assert_eq 2 "$rc"
assert_contains "$err" '--source and --target'

run_forge forge_mr_state --mr 7 --dir "$tmp/nowhere"
assert_eq 2 "$rc"
assert_contains "$err" 'not a directory'

# --- merging ---------------------------------------------------------------

FORGE_TEST_OUT=
log_reset
run_forge forge_mr_merge --mr 7 --repo acme/widget
assert_eq 0 "$rc"
assert_contains "$(log)" 'gh [pr] [merge] [7] [--repo] [acme/widget] [--merge]'
assert_not_contains "$(log)" '[--delete-branch]' \
	"shift done returns the tree before deleting the branch; the forge must not do it early"

log_reset
run_forge forge_mr_merge --mr 7 --strategy squash --delete-source
assert_contains "$(log)" '[--squash]'
assert_contains "$(log)" '[--delete-branch]'

# --- creating --------------------------------------------------------------

FORGE_TEST_OUT=$'Creating pull request for feat/x into main in acme/widget\n\nhttps://github.com/acme/widget/pull/42'
log_reset
run_forge forge_mr_create --source feat/x --target main --title 'Add x' --body 'because' --repo acme/widget
assert_eq 0 "$rc"
assert_eq 'https://github.com/acme/widget/pull/42' "$out" \
	"only the URL comes out; the CLI's prose stays inside"
assert_contains "$(log)" 'gh [pr] [create] [--base] [main] [--head] [feat/x] [--title] [Add x] [--body] [because]'

printf 'a longer brief\n' >"$tmp/body.md"
log_reset
run_forge forge_mr_create --source feat/x --target main --title 'Add x' --body-file "$tmp/body.md"
assert_eq 0 "$rc"
assert_contains "$(log)" '[--body] [a longer brief]'

run_forge forge_mr_create --source feat/x --target main --title x --body a --body-file "$tmp/body.md"
assert_eq 2 "$rc"
assert_contains "$err" 'alternatives'

FORGE_TEST_OUT='no url in here'
run_forge forge_mr_create --source feat/x --target main --title x --body a
assert_eq 1 "$rc"
assert_contains "$err" 'did not print a merge request URL'

# --- GitLab ---------------------------------------------------------------

mk_config "$tmp/home" '{
  "version": 1,
  "agents": { "yan": "claude", "shift": "claude" },
  "forge": { "kind": "gitlab", "host": "gitlab.company.internal" },
  "backend": "tmux"
}'

FORGE_TEST_OUT='{"state":"opened","merged_at":null,"head_pipeline":{"status":"running"}}'
log_reset
run_forge forge_mr_state --mr 'https://gitlab.company.internal/grp/sub/proj/-/merge_requests/88'
assert_eq 0 "$rc"
assert_eq open "$out"
# The URL is split into an iid and a project path here, once, instead of at
# every call site - glab does not take a URL where gh does.
assert_contains "$(log)" 'glab [mr] [view] [88] [--repo] [grp/sub/proj] [--output] [json]'
assert_contains "$(log)" 'host=gitlab.company.internal'
assert_not_contains "$(log)" 'gh [' "forge.kind is gitlab, so gh is never run"

log_reset
run_forge forge_ci_state --mr 88 --repo grp/proj
assert_eq pending "$out"
assert_contains "$(log)" 'glab [mr] [view] [88] [--repo] [grp/proj]'

FORGE_TEST_OUT=
log_reset
run_forge forge_mr_merge --mr 88 --repo grp/proj
assert_eq 0 "$rc"
# glab's --auto-merge defaults to true: without this, "merge it" would quietly
# become "merge it later" whenever a pipeline was running.
assert_contains "$(log)" '[--auto-merge=false]'
assert_contains "$(log)" '[--yes]'

FORGE_TEST_OUT='!88 https://gitlab.company.internal/grp/proj/-/merge_requests/88'
log_reset
run_forge forge_mr_create --source feat/x --target main --title 'Add x' --body b --repo grp/proj
assert_eq 'https://gitlab.company.internal/grp/proj/-/merge_requests/88' "$out"
assert_contains "$(log)" 'glab [mr] [create] [--source-branch] [feat/x] [--target-branch] [main]'
assert_contains "$(log)" '[--no-editor] [--yes]'

run_forge forge_mr_state --mr not-a-number
assert_eq 2 "$rc"
assert_contains "$err" 'cannot work out the merge request number'

# --- configuration is this file's business, and nobody else's -------------

mk_config "$tmp/home" '{"version":1,"forge":{"kind":"gitlab"}}'
run_forge forge_mr_state --mr 88
assert_eq 2 "$rc"
assert_contains "$err" 'forge.host is required'

mk_config "$tmp/home" '{"version":1,"forge":{"kind":"bitbucket"}}'
run_forge forge_mr_state --mr 88
assert_eq 2 "$rc"
assert_contains "$err" 'which yan does not support'

mk_config "$tmp/home" '{"version":1}'
run_forge forge_mr_state --mr 88
assert_eq 2 "$rc"
assert_contains "$err" 'forge.kind is not set'

rm -f "$tmp/home/conf/config.json"
run_forge forge_mr_state --mr 88
assert_eq 2 "$rc"
assert_contains "$err" 'no configuration at'

# A missing CLI is named, not guessed at.
run_forge _forge_exec yan-no-such-forge-cli --version
assert_eq 127 "$rc"
assert_contains "$err" 'is not on PATH'

# --- the seam is the only place that knows which forge this is ------------

leaks=$(grep -rln -E '(^|[^a-z_-])(gh|glab)[[:space:]]|forge\.kind' "$YAN_REPO_ROOT/bin" || true)
while IFS= read -r f; do
	[ -n "$f" ] || continue
	case ${f##*/} in
	lib-forge.sh) ;;
	# lib-boot.sh is the one sanctioned exception: it has to name the missing
	# CLI before lib-forge could ever run. tests/unit/lib-boot-forge.test.sh
	# keeps the two in step.
	lib-boot.sh) ;;
	*) _assert_die "$f mentions a forge CLI or forge.kind - only lib-forge.sh may" ;;
	esac
done <<<"$leaks"

printf 'ok\n'
