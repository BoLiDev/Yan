#!/usr/bin/env bash
#
# Phase 5 Trace bullet 3: `yan send` types the text once and can retry the
# Enter alone (td agents.md §5.4).
#
# The stand-in terminal records one line per call, so "the text and the Enter
# went as two separate steps" and "retrying the Enter did not retype the line"
# are both exact assertions rather than an eyeball on a pane. The same
# behaviour against a real tmux server is in tests/integration.
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
cp "$YAN_REPO_ROOT/tests/stub/lib-term.sh" "$home/bin/lib-term.sh"

YAN_HOME=$home
export YAN_HOME
export YAN_STUB_TERM_DIR=$tmp/term
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t042 'unify the auth header'
run=$home/tasks/t042/shifts/s3/run
mkdir -p "$run"
printf '{ "version": 1, "unit": "auth", "branch": "yan/t042/s3", "agent": "claude", "window": "@3", "pane": "%%7" }\n' >"$run/meta.json"

calls() {
	if [ -f "$tmp/term/calls" ]; then
		cat "$tmp/term/calls"
	fi
}
reset_calls() { rm -rf "$tmp/term"; }

# --- a plain send: text, then Enter, as two steps --------------------------

reset_calls
capture bash "$yan" send s3 'check the failing test first'
assert_eq 0 "$rc" "$out"
assert_eq 'send_text id=%7 text=check the failing test first
send_enter id=%7' "$(calls)" 'the text and the Enter are two separate calls, in that order'

# --- the retry: Enter alone, and the line is NOT typed again ---------------

reset_calls
capture bash "$yan" send s3 --enter
assert_eq 0 "$rc" "$out"
assert_eq 'send_enter id=%7' "$(calls)" 'retrying sends only the Enter'

reset_calls
capture bash "$yan" send s3 --no-enter 'type it and wait'
assert_eq 0 "$rc" "$out"
assert_eq 'send_text id=%7 text=type it and wait' "$(calls)" 'type once, press Enter later'

capture bash "$yan" send s3 --enter 'text as well'
assert_eq 2 "$rc" '--enter takes no text'

# --- one short line only ----------------------------------------------------

reset_calls
capture bash "$yan" send s3 $'two\nlines'
assert_eq 2 "$rc" 'a newline is not one line'
assert_contains "$out" 'file'
assert_eq '' "$(calls)" 'nothing reached the terminal'

long=$(printf 'x%.0s' $(seq 1 501))
capture bash "$yan" send s3 "$long"
assert_eq 2 "$rc" 'anything long goes in a file and only the path is sent'
assert_contains "$out" '501 characters'
assert_eq '' "$(calls)"

capture env YAN_SEND_MAX=600 bash "$yan" send s3 "$long"
assert_eq 0 "$rc" 'the limit is a knob, not a law of nature'

capture bash "$yan" send s3 ''
assert_eq 2 "$rc" 'an empty line is refused; --enter is how you mean that'

# --- the terminal id comes from meta.json, and it is an id -----------------

reset_calls
printf '{ "version": 1, "agent": "claude", "pane": "s3-auth" }\n' >"$run/meta.json"
capture bash "$yan" send s3 'hello'
assert_ne 0 "$rc" 'a label is not a source of truth; the seam refuses it'
assert_contains "$out" 'never a label'

printf '{ "version": 1, "agent": "claude" }\n' >"$run/meta.json"
capture bash "$yan" send s3 'hello'
assert_eq 1 "$rc" 'no terminal id recorded is a real error, not a silent no-op'
assert_contains "$out" 'no terminal id'

# --- a shift that has clocked out has no terminal --------------------------

printf '{ "version": 1, "pane": "%%7" }\n' >"$run/meta.json"
rm -rf "$run"
capture bash "$yan" send s3 'hello'
assert_eq 1 "$rc"
assert_contains "$out" 'clocked out'

# --- usage ------------------------------------------------------------------

capture bash "$yan" send
assert_eq 2 "$rc"
capture bash "$yan" send s3
assert_eq 2 "$rc" 'a line is required unless --enter was passed'
capture bash "$yan" send nosuchshift 'hello'
assert_eq 1 "$rc"

printf 'ok\n'
