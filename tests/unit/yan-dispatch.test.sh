#!/usr/bin/env bash
#
# Trace bullet 1: an unknown subcommand exits non-zero with a short help list.
# Also proves the dispatcher derives everything from disk - no central table.
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

# --- unknown subcommand ----------------------------------------------------
#
# Exit 2, the same code Commander's own argument errors use: which half answers
# depends only on whether dist/ has been built, so the two have to agree.

assert_fail bash "$YAN" bogus
capture bash "$YAN" bogus
assert_eq 2 "$rc" "an unknown subcommand is a usage error"
assert_contains "$out" "unknown command: bogus"

# --- explicit help forms ---------------------------------------------------
#
# There is nothing to list in this fixture, and that is the point rather than
# an omission: since Phase 8 every command has a TypeScript twin, so a tree
# that has never been built has no subcommands at all. What is asserted here is
# the shape; the derived list is asserted below, against files this test makes.

for form in -h --help help; do
	capture bash "$YAN" "$form"
	assert_eq 0 "$rc" "'yan $form' must exit 0"
	assert_contains "$out" "usage: yan"
done

# Bare `yan` prints the same thing. It is not an unknown command, so it is not
# an error.
capture bash "$YAN"
assert_eq 0 "$rc"
assert_contains "$out" "usage: yan"

# --- version ---------------------------------------------------------------

capture bash "$YAN" --version
assert_eq 0 "$rc"
assert_contains "$out" "yan "

# --- derived dispatch ------------------------------------------------------

cat >"$home/bin/yan-fake.sh" <<'EOF'
#!/usr/bin/env bash
printf 'one-word|%s|home=%s\n' "$*" "${YAN_HOME:-unset}"
EOF
cat >"$home/bin/yan-fake-sub.sh" <<'EOF'
#!/usr/bin/env bash
printf 'two-word|%s\n' "$*"
EOF
chmod +x "$home/bin/yan-fake.sh" "$home/bin/yan-fake-sub.sh"

# Longest match wins: `yan fake sub` reaches bin/yan-fake-sub.sh.
capture bash "$YAN" fake sub alpha beta
assert_eq 0 "$rc"
assert_contains "$out" "two-word|alpha beta"

# No two-word file: the rest becomes arguments to the one-word file.
capture bash "$YAN" fake other
assert_eq 0 "$rc"
assert_contains "$out" "one-word|other"

# The hyphenated spelling reaches the same file.
capture bash "$YAN" fake-sub alpha
assert_eq 0 "$rc"
assert_contains "$out" "two-word|alpha"

# YAN_HOME is exported to the subcommand and points at the temp home.
capture bash "$YAN" fake
assert_contains "$out" "home=$home"

# The help list is a glob, so the new files show up without editing bin/yan.
capture bash "$YAN" --help
assert_contains "$out" "fake"
assert_contains "$out" "fake-sub"

# ...and disappear again when the files do.
rm -f "$home/bin/yan-fake.sh" "$home/bin/yan-fake-sub.sh"
capture bash "$YAN" --help
assert_not_contains "$out" "fake"
assert_fail bash "$YAN" fake

# --- there is no central case list in bin/yan ------------------------------

assert_fail grep -qE '^[[:space:]]*(doctor|repo-add|shift)\)' "$YAN_REPO_ROOT/bin/yan"

# --- YAN_HOME resolution ---------------------------------------------------

# A pre-set YAN_HOME is honoured when it is a real yan home...
capture env YAN_HOME="$home" bash "$YAN_REPO_ROOT/bin/yan" --help
assert_eq 0 "$rc"

# ...and ignored when it is not, falling back to the script's own location.
cat >"$home/bin/yan-where.sh" <<'EOF'
#!/usr/bin/env bash
printf 'YAN_HOME  %s\n' "${YAN_HOME:-unset}"
EOF
chmod +x "$home/bin/yan-where.sh"
mkdir -p "$tmp/not-a-home"
capture env YAN_HOME="$tmp/not-a-home" bash "$YAN" where
assert_contains "$out" "YAN_HOME  $home"

printf 'ok\n'
