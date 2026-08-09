#!/usr/bin/env bash
#
# Trace bullet 4: the `YAN_LIB=tests/stub` sourcing shape works.
#
# Every subcommand and library sources its dependencies as
#     . "${YAN_LIB:-$YAN_HOME/bin}/lib-<name>.sh"
# so a test swaps a seam by pointing YAN_LIB at tests/stub. Nothing else.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

probe=$tmp/probe.sh
cat >"$probe" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
. "${YAN_LIB:-$YAN_HOME/bin}/lib-noop.sh"
noop_which
EOF

# Default: the real module under $YAN_HOME/bin.
capture env YAN_HOME="$YAN_REPO_ROOT" bash "$probe"
assert_eq 0 "$rc"
assert_eq real "$out"

# YAN_LIB wins.
capture env YAN_HOME="$YAN_REPO_ROOT" YAN_LIB="$YAN_REPO_ROOT/tests/stub" bash "$probe"
assert_eq 0 "$rc"
assert_eq stub "$out"

# The convention is actually followed by everything shipped in bin/ that
# sources a library: check the literal form, not just the behaviour.
capture grep -rn '\. "\${YAN_LIB:-\$YAN_HOME/bin}/' "$YAN_REPO_ROOT/bin"
assert_eq 0 "$rc" "at least one shipped script must demonstrate the form"
assert_contains "$out" "yan-doctor.sh"

# Any `. .../lib-*.sh` line in bin/ must use the YAN_LIB form.
while IFS= read -r line; do
	[ -n "$line" ] || continue
	assert_contains "$line" '${YAN_LIB:-$YAN_HOME/bin}' "sourcing must go through YAN_LIB"
done < <(grep -rhn '^[[:space:]]*\.[[:space:]]' "$YAN_REPO_ROOT/bin" || true)

printf 'ok\n'
