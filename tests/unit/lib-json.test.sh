#!/usr/bin/env bash
#
# Trace bullet 2: JSON writes always go tmp -> mv, leave no temp file behind,
# and every written object carries `version`. An invalid write leaves the
# previous content intact.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=bin/lib-json.sh
. "$YAN_REPO_ROOT/bin/lib-json.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

count_temps() { # <dir>
	local f n=0
	shopt -s nullglob
	for f in "$1"/.yan-json.*; do
		if [ -e "$f" ]; then
			n=$((n + 1))
		fi
	done
	shopt -u nullglob
	printf '%s\n' "$n"
}

# --- version is always injected -------------------------------------------

f=$tmp/a.json
json_write "$f" '{"a":1}'
assert_file_exists "$f"
assert_eq 1 "$(json_read "$f" .a)"
assert_eq 1 "$(json_read "$f" .version)" "a written object must carry version"
assert_eq 0 "$(count_temps "$tmp")" "no temp file may be left behind"
assert_ok jq empty "$f"

# --- an explicit version is respected, not overwritten --------------------

g=$tmp/b.json
json_write "$g" '{"version":7,"b":2}'
assert_eq 7 "$(json_read "$g" .version)"

# --- nested directories are created ---------------------------------------

deep=$tmp/x/y/z/deep.json
json_write "$deep" '{"d":1}'
assert_file_exists "$deep"
assert_eq 1 "$(json_read "$deep" .version)"

# --- the temp file lives beside the target, not in $TMPDIR ----------------
#
# If the implementation used mktemp's default location, the mv would cross a
# filesystem and this write would have to fall back to a copy. Pointing TMPDIR
# at something that does not exist proves the template is anchored to the
# target's own directory.

(
	TMPDIR=$tmp/definitely-not-here
	export TMPDIR
	json_write "$tmp/c.json" '{"c":3}'
)
assert_eq 3 "$(json_read "$tmp/c.json" .c)"
assert_eq 0 "$(count_temps "$tmp")"

# --- invalid JSON is refused and the old content survives -----------------

assert_fail json_write "$f" '{"a":'
assert_eq 1 "$(json_read "$f" .a)" "a refused write must not damage the target"
assert_eq 1 "$(json_read "$f" .version)"
assert_eq 0 "$(count_temps "$tmp")" "a refused write must not leave a temp file"

assert_fail json_write "$f" 'not json at all'
assert_eq 1 "$(json_read "$f" .a)"
assert_fail json_write "$f" ''
assert_eq 1 "$(json_read "$f" .a)"

# --- json_edit -------------------------------------------------------------

json_edit "$g" '.b = 99'
assert_eq 99 "$(json_read "$g" .b)"
assert_eq 7 "$(json_read "$g" .version)" "json_edit must preserve version"
assert_eq 0 "$(count_temps "$tmp")"

json_edit "$g" '.name = $n' --arg n hello
assert_eq hello "$(json_read "$g" .name)"
assert_eq 7 "$(json_read "$g" .version)"

# A program that deletes version gets it back.
json_edit "$g" 'del(.version)'
assert_eq 7 "$(json_read "$g" .version)"

# A broken program leaves the file untouched.
assert_fail json_edit "$g" '.b ='
assert_eq 99 "$(json_read "$g" .b)"
assert_eq 0 "$(count_temps "$tmp")"

assert_fail json_edit "$tmp/missing.json" '.'

# --- json_init -------------------------------------------------------------

i=$tmp/init.json
json_init "$i" '{"first":true}'
assert_eq true "$(json_read "$i" .first)"
json_init "$i" '{"second":true}'
assert_eq true "$(json_read "$i" .first)" "json_init must not overwrite"
assert_eq null "$(json_read "$i" .second)"

# --- usage errors ----------------------------------------------------------

assert_fail json_write
assert_fail json_write "$tmp/z.json"
assert_fail json_read
assert_fail json_read "$tmp/missing.json" .
assert_fail json_edit "$g"

# --- double sourcing is safe ----------------------------------------------

# shellcheck source=bin/lib-json.sh
. "$YAN_REPO_ROOT/bin/lib-json.sh"
assert_eq 99 "$(json_read "$g" .b)"

printf 'ok\n'
