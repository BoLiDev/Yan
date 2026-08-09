#!/usr/bin/env bash
#
# Regression: jq.exe on Git Bash emits CRLF.
#
#   $ printf '{"a":"1","b":"2"}' | jq -r 'to_entries[]|.key' | od -c
#   0000000   a  \r  \n   b  \r  \n
#
# `$(...)` strips a trailing newline, so a single-value read hides this
# completely and only multi-line reads are corrupted - on one platform only.
# Every value that leaves lib-json must be free of it, and every JSON file it
# writes must be LF, so a file written on Windows matches one written on Linux.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=bin/lib-json.sh
. "$YAN_REPO_ROOT/bin/lib-json.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

CR=$'\r'
f=$tmp/repos.json
json_write "$f" '{"repos":{"alpha":1,"beta":2,"gamma":3}}'

# --- multi-line reads carry no CR -----------------------------------------
#
# The failure this guards against is silent: with a CR the value still prints
# as `alpha` on a terminal, but never compares equal to `alpha`.

keys=$(json_read "$f" '.repos|keys[]')
assert_not_contains "$keys" "$CR" "multi-line json_read must not return a CR"
assert_eq "alpha
beta
gamma" "$keys" "multi-line json_read is LF-only"

# The comparison that would silently fail: a non-final line against a literal.
assert_eq "alpha" "$(json_read "$f" '.repos|keys[0]')" "single-value read"

# --- a value that is genuinely the last line -------------------------------
# This case looks fine even when the bug is present, so assert it stays fine
# rather than assuming it.
assert_eq "3" "$(json_read "$f" '.repos.gamma')" "trailing-line value"

# --- the file on disk is LF ------------------------------------------------
assert_not_contains "$(cat "$f")" "$CR" "json_write must produce an LF file"

# --- json_edit keeps both properties ---------------------------------------
json_edit "$f" '.repos.delta = 4'
assert_not_contains "$(cat "$f")" "$CR" "json_edit must produce an LF file"
assert_not_contains "$(json_read "$f" '.repos|keys[]')" "$CR" "json_edit output is LF-only"
assert_eq "4" "$(json_read "$f" '.repos.delta')" "json_edit wrote the value"
assert_eq "1" "$(json_read "$f" '.version')" "json_edit preserved version"

# --- jq's exit status still reaches the caller -----------------------------
# The obvious fix - piping jq straight into sed - would return sed's status and
# turn every invalid write into a silent success. Guard that seam explicitly.
assert_fail json_write "$tmp/bad.json" 'not json at all'
assert_file_missing "$tmp/bad.json"
assert_fail json_read "$f" '.repos|'

# An existing file must survive a refused write untouched.
before=$(cat "$f")
assert_fail json_write "$f" '{"broken":'
assert_eq "$before" "$(cat "$f")" "a refused write leaves the file intact"
