#!/usr/bin/env bash
#
# Phase 1 Trace bullet 4: lib-log appends only; rewriting an existing line is
# impossible through the API.
#
# The bullet is tested from both directions:
#   1. the API SURFACE offers no operation that could rewrite a line, and
#   2. appending twice leaves the first line byte-for-byte identical.
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
YAN_HOME=$home
export YAN_HOME

# shellcheck source=bin/lib-log.sh
. "$YAN_REPO_ROOT/bin/lib-log.sh"

mkdir -p "$home/tasks/t042"
f=$home/tasks/t042/log.md
assert_eq "$f" "$(log_file t042)"

# --- the heading is written once, and only when the file is absent ---------

log_init t042 'unify the auth header'
assert_file_exists "$f"
assert_eq '# t042 unify the auth header' "$(head -n 1 "$f")"

log_init t042 'a completely different title'
assert_eq '# t042 unify the auth header' "$(head -n 1 "$f")" \
	"log_init must never touch an existing file, not even its heading"

# --- one line per event, in the shape of td memory.md §4.2 ----------------

log_append t042 's1 auth  parse the header  → !31 merged into the integration branch' 08-04
assert_eq '- 08-04  s1 auth  parse the header  → !31 merged into the integration branch' \
	"$(tail -n 1 "$f")"

# --- appending twice preserves the first line BYTE FOR BYTE ---------------

cp "$f" "$tmp/snap1"
log_append t042 's2 auth  call the parser from auth' 08-05
lines=$(wc -l <"$tmp/snap1")
head -n "$lines" "$f" >"$tmp/prefix"
assert_ok cmp -s "$tmp/snap1" "$tmp/prefix"

log_append t042 'decision  retarget to master' 09-01
head -n "$lines" "$f" >"$tmp/prefix2"
assert_ok cmp -s "$tmp/snap1" "$tmp/prefix2"

assert_eq 3 "$(grep -c '^- ' "$f")"
assert_contains "$(cat "$f")" '- 08-05  s2 auth  call the parser from auth'

# --- the API surface offers no way to rewrite a line ----------------------
#
# This is the half of the bullet that a behavioural test cannot reach: you
# cannot prove "there is no such operation" by calling operations. So enumerate
# what the library actually defines and require the public surface to be
# exactly the three append-or-read functions.

surface=$(declare -F | sed 's/^declare -f //' | grep '^log_' | LC_ALL=C sort | tr '\n' ' ')
assert_eq 'log_append log_file log_init ' "$surface" \
	"lib-log's public API must be exactly log_append, log_file and log_init"

for forbidden in set replace update rewrite delete remove edit insert truncate line_set; do
	assert_not_contains " $surface" " log_$forbidden " \
		"lib-log must not define a mutating operation"
done

# The implementation matches the surface. The only writer, log_append, must
# contain no truncating redirection and no in-place rewriting tool at all.
src=$YAN_REPO_ROOT/bin/lib-log.sh
body=$(sed -n '/^log_append() {/,/^}/p' "$src")
assert_contains "$body" '>>"$file"' "log_append must append"
assert_eq 0 "$(printf '%s\n' "$body" | grep -c -E '[^>]>"\$file"')" \
	"log_append must never truncate log.md"
assert_eq 0 "$(grep -c -E 'sed -i|mktemp|[[:space:]]mv[[:space:]]|truncate' "$src")" \
	"lib-log must not replace log.md by any route"

# --- usage errors ---------------------------------------------------------

assert_fail log_append t042
assert_fail log_append '' 'anything'
assert_fail log_append t042 $'two\nlines'
assert_fail log_file
assert_eq 3 "$(grep -c '^- ' "$f")" "a refused call must not have written anything"

# --- double sourcing is safe ----------------------------------------------

# shellcheck source=bin/lib-log.sh
. "$YAN_REPO_ROOT/bin/lib-log.sh"
assert_eq 3 "$(grep -c '^- ' "$f")"

printf 'ok\n'
