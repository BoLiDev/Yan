#!/usr/bin/env bash
#
# Phase 4, Trace bullet 5: the stub forge can replay a fixed MR-state sequence.
#
# Phases 6, 7 and 9 all need this. What they actually test is what a caller
# does as a merge request moves open -> open -> merged, or as CI goes
# pending -> red, and that is not something a real forge can be asked to do on
# demand. So the sequence is programmed and the caller is the thing under test.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export YAN_STUB_FORGE_DIR=$tmp/stub
# shellcheck source=tests/stub/lib-forge.sh
. "$YAN_REPO_ROOT/tests/stub/lib-forge.sh"

MR=https://forge.invalid/acme/widget/-/merge_requests/1

# --- the sequence is replayed, one entry per call -------------------------

forge_stub_reset
export YAN_STUB_FORGE_MR_STATES="open open merged"
assert_eq open "$(forge_mr_state --mr "$MR")"
assert_eq open "$(forge_mr_state --mr "$MR")"
assert_eq merged "$(forge_mr_state --mr "$MR")"
assert_eq merged "$(forge_mr_state --mr "$MR")" \
	"past the end the last value repeats: a poll loop that has seen merged keeps seeing merged"

# Commas and newlines work too, so a sequence can be written either way.
forge_stub_reset
export YAN_STUB_FORGE_MR_STATES="closed,open"
assert_eq closed "$(forge_mr_state --mr "$MR")"
assert_eq open "$(forge_mr_state --mr "$MR")"

forge_stub_reset
export YAN_STUB_FORGE_MR_STATES=$'unknown\nmerged'
assert_eq unknown "$(forge_mr_state --mr "$MR")"
assert_eq merged "$(forge_mr_state --mr "$MR")"

# --- or from a file -------------------------------------------------------

forge_stub_reset
unset YAN_STUB_FORGE_MR_STATES
printf 'open\nunknown\nclosed\n' >"$tmp/states"
export YAN_STUB_FORGE_MR_STATES_FILE=$tmp/states
assert_eq open "$(forge_mr_state --mr "$MR")"
assert_eq unknown "$(forge_mr_state --mr "$MR")"
assert_eq closed "$(forge_mr_state --mr "$MR")"
unset YAN_STUB_FORGE_MR_STATES_FILE

# --- exhaustion can be made to look like a forge that stopped answering ---

forge_stub_reset
export YAN_STUB_FORGE_MR_STATES="open"
export YAN_STUB_FORGE_EXHAUSTED=unknown
assert_eq open "$(forge_mr_state --mr "$MR")"
assert_eq unknown "$(forge_mr_state --mr "$MR")"
unset YAN_STUB_FORGE_EXHAUSTED

# --- a caller across a whole sequence -------------------------------------
#
# branching.md §6.4 decides a round's `end` from the merge request's state, and
# the four values line up one for one with the four conclusions. This is why
# there are exactly four, and why a fifth would have nowhere to go.

decide_end() {
	case "$(forge_mr_state --mr "$1")" in
	merged) printf 'delivered\n' ;;
	closed) printf 'abandoned\n' ;;
	open) printf 'ask-user: the round is not over\n' ;;
	unknown) printf 'ask-user: cannot reach the forge\n' ;;
	*) printf 'IMPOSSIBLE\n' ;;
	esac
}

forge_stub_reset
export YAN_STUB_FORGE_MR_STATES="merged closed open unknown"
assert_eq 'delivered' "$(decide_end "$MR")"
assert_eq 'abandoned' "$(decide_end "$MR")"
assert_eq 'ask-user: the round is not over' "$(decide_end "$MR")"
assert_eq 'ask-user: cannot reach the forge' "$(decide_end "$MR")"

# And a supervision-shaped caller across a CI sequence: pending until it is
# not, then red means "dispatch a shift to fix it" - a decision the seam does
# not make for it.
watch_ci() {
	local seen=()
	local n=0 v
	while [ "$n" -lt 3 ]; do
		v=$(forge_ci_state --mr "$1")
		seen+=("$v")
		n=$((n + 1))
	done
	printf '%s\n' "${seen[*]}"
}

forge_stub_reset
export YAN_STUB_FORGE_CI_STATES="pending pending red"
assert_eq 'pending pending red' "$(watch_ci "$MR")"

forge_stub_reset
export YAN_STUB_FORGE_CI_STATES="none"
assert_eq 'none none none' "$(watch_ci "$MR")"
unset YAN_STUB_FORGE_CI_STATES

# --- the stub refuses to be programmed outside the closed set -------------

forge_stub_reset
export YAN_STUB_FORGE_MR_STATES="squashed"
rc=0
out=$(forge_mr_state --mr "$MR" 2>"$tmp/err") || rc=$?
assert_eq 2 "$rc" "a fifth value is a bug in the test, and the stub says so"
assert_contains "$(cat "$tmp/err")" 'not merged|closed|open|unknown'
unset YAN_STUB_FORGE_MR_STATES

# --- calls are recorded in yan vocabulary ---------------------------------

forge_stub_reset
export YAN_STUB_FORGE_MR_STATES="open merged"
forge_mr_state --mr "$MR" >/dev/null
forge_mr_merge --mr "$MR" --strategy squash
forge_mr_state --mr "$MR" >/dev/null
assert_eq 3 "$(forge_stub_call_count)"
assert_contains "$(forge_stub_calls)" "mr_merge mr=$MR strategy=squash delete_source=0"
assert_not_contains "$(forge_stub_calls)" 'pr merge' "the record is yan vocabulary, not gh's"

url=$(forge_mr_create --source feat/x --target main --title 'Add x')
assert_contains "$url" 'merge_requests/1'
assert_contains "$(forge_stub_calls)" 'mr_create source=feat/x target=main draft=0'

# --- the stub accepts exactly the same flags as the real library ----------

rc=0
forge_mr_state --mr "$MR" --admin >/dev/null 2>"$tmp/err" || rc=$?
assert_eq 2 "$rc"
assert_contains "$(cat "$tmp/err")" "never gh's or glab's"

rc=0
forge_mr_state --repo acme/widget >/dev/null 2>"$tmp/err" || rc=$?
assert_eq 2 "$rc"

# --- YAN_LIB selects it, and the cursor survives separate processes -------
#
# yan subcommands are separate processes, so the sequence has to be replayed
# across them, not inside one shell.

probe=$tmp/probe.sh
cat >"$probe" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=/dev/null
. "${YAN_LIB:-$YAN_HOME/bin}/lib-forge.sh"
forge_mr_state --mr "$1"
EOF

forge_stub_reset
export YAN_STUB_FORGE_MR_STATES="open open merged"
capture env YAN_HOME="$YAN_REPO_ROOT" YAN_LIB="$YAN_REPO_ROOT/tests/stub" bash "$probe" "$MR"
assert_eq 0 "$rc"
assert_eq open "$out"
capture env YAN_HOME="$YAN_REPO_ROOT" YAN_LIB="$YAN_REPO_ROOT/tests/stub" bash "$probe" "$MR"
assert_eq open "$out"
capture env YAN_HOME="$YAN_REPO_ROOT" YAN_LIB="$YAN_REPO_ROOT/tests/stub" bash "$probe" "$MR"
assert_eq merged "$out" "the cursor lives in a file, so it survives across processes"

printf 'ok\n'
