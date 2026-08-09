#!/usr/bin/env bash
#
# Phase 4, Trace bullet 4: bootstrap checks only the CLI that forge.kind
# selects - never both.
#
# It also pins the two files together. lib-boot.sh is the single sanctioned
# reader of forge.kind outside lib-forge.sh (it has to name the missing CLI
# before lib-forge could ever run), so the risk is the two drifting apart and
# `yan doctor` blessing a CLI the seam never calls. Both are exercised here
# with the same fakes on PATH and compared.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"
# shellcheck source=bin/lib-boot.sh
. "$YAN_REPO_ROOT/bin/lib-boot.sh"
# shellcheck source=bin/lib-forge.sh
. "$YAN_REPO_ROOT/bin/lib-forge.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mk_yan_home "$tmp/home"
export YAN_HOME=$tmp/home

fakebin=$tmp/fakebin
mkdir -p "$fakebin"
export FORGE_TEST_LOG=$tmp/argv.log
export FORGE_TEST_OUT='{"state":"OPEN","mergedAt":null,"merged_at":null}'
export FORGE_TEST_RC=0
: >"$FORGE_TEST_LOG"

mk_fake_cli() {
	cat >"$fakebin/$1" <<'EOF'
#!/usr/bin/env bash
{
	printf '%s' "$(basename "$0")"
	for a in "$@"; do printf ' [%s]' "$a"; done
	printf '\n'
} >>"$FORGE_TEST_LOG"
if [ "${FORGE_TEST_RC:-0}" -ne 0 ]; then
	exit "${FORGE_TEST_RC}"
fi
printf '%s\n' "${FORGE_TEST_OUT:-}"
EOF
	chmod +x "$fakebin/$1"
}

# BOTH CLIs are installed on this machine. Exactly one may be checked.
mk_fake_cli gh
mk_fake_cli glab
export PATH="$fakebin:$PATH"

which_cli_does_the_seam_use() { # <mr-ref>
	: >"$FORGE_TEST_LOG"
	forge_mr_state --mr "$1" >/dev/null 2>&1 || true
	head -n 1 "$FORGE_TEST_LOG" | cut -d' ' -f1
}

# --- github ----------------------------------------------------------------

mk_config "$tmp/home" '{"version":1,"forge":{"kind":"github"}}'

out=$(boot_check_forge)
assert_contains "$out" 'forge (github)'
assert_contains "$out" "$fakebin/gh"
assert_not_contains "$out" 'glab' "glab is installed here, and must not be looked at"
assert_not_contains "$out" 'FAIL'

assert_eq gh "$(which_cli_does_the_seam_use 7)" \
	"doctor blessed gh, so the seam must actually run gh"

# --- gitlab ----------------------------------------------------------------

mk_config "$tmp/home" '{"version":1,"forge":{"kind":"gitlab","host":"gitlab.company.internal"}}'

out=$(boot_check_forge)
assert_contains "$out" 'forge (gitlab)'
assert_contains "$out" "$fakebin/glab"
assert_contains "$out" 'glab is authenticated for gitlab.company.internal'
assert_not_contains "$out" 'forge (github)' 'gh is installed here, and must not be looked at'
assert_not_contains "$out" 'FAIL'

# Authentication is deliberately not unified: glab owns its own login, and the
# check is that glab itself says it is logged in to the configured host.
assert_contains "$(cat "$FORGE_TEST_LOG")" 'glab [auth] [status] [--hostname] [gitlab.company.internal]'
assert_not_contains "$(cat "$FORGE_TEST_LOG")" 'gh [auth]'

assert_eq glab "$(which_cli_does_the_seam_use 88)" \
	"doctor blessed glab, so the seam must actually run glab"

# glab installed but not logged in to that host.
FORGE_TEST_RC=1
out=$(boot_check_forge)
FORGE_TEST_RC=0
assert_contains "$out" 'FAIL'
assert_contains "$out" 'glab auth login --hostname gitlab.company.internal'

# host is required for gitlab, and both files say so.
mk_config "$tmp/home" '{"version":1,"forge":{"kind":"gitlab"}}'
out=$(boot_check_forge)
assert_contains "$out" 'forge.host'
assert_contains "$out" 'FAIL'

rc=0
forge_mr_state --mr 88 >/dev/null 2>"$tmp/err" || rc=$?
assert_eq 2 "$rc"
assert_contains "$(cat "$tmp/err")" 'forge.host is required'

# --- neither ---------------------------------------------------------------

mk_config "$tmp/home" '{"version":1,"forge":{"kind":"nowhere"}}'
out=$(boot_check_forge)
assert_contains "$out" 'FAIL'
assert_not_contains "$out" "$fakebin/gh"
assert_not_contains "$out" "$fakebin/glab"

mk_config "$tmp/home" '{"version":1}'
out=$(boot_check_forge)
assert_contains "$out" 'FAIL'
assert_contains "$out" 'forge.kind'

printf 'ok\n'
