#!/usr/bin/env bash
#
# lib-term's contract, without a terminal.
#
# Everything here is true whether or not tmux is installed, so it runs in any
# container: the backend gate, the "ids, never labels" rule, and the promise
# that this file cannot destroy a container or the tmux server.
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
export YAN_HOME=$home

# shellcheck source=bin/lib-term.sh
. "$YAN_REPO_ROOT/bin/lib-term.sh"

src=$YAN_REPO_ROOT/bin/lib-term.sh

# --- Trace: ids are used, nothing is located by label alone -----------------
#
# tmux does not promise window names are unique, so a name lookup can hit the
# wrong agent. Every per-agent function refuses anything that is not an id, and
# "you called this wrongly" is exit 2.

for bad in yan s3-auth '' '@' '%' '@x' 'window@3' '3'; do
	capture term_send "$bad" 'hello'
	assert_eq 2 "$rc" "term_send must refuse a label: '$bad'"
	assert_contains "$out" "never a label"

	capture term_read "$bad"
	assert_eq 2 "$rc" "term_read must refuse a label: '$bad'"

	capture term_agent_alive "$bad"
	assert_eq 2 "$rc" "term_agent_alive must refuse a label: '$bad'"

	capture term_agent_close "$bad"
	assert_eq 2 "$rc" "term_agent_close must refuse a label: '$bad'"
done

for bad in mysession t042 '' '$' '$x' '@3' '%7'; do
	capture term_list "$bad"
	assert_eq 2 "$rc" "term_list must refuse a container name: '$bad'"
	assert_contains "$out" "never a name"

	capture term_agent_start "$bad" label sleep 1
	assert_eq 2 "$rc" "term_agent_start must refuse a container name: '$bad'"
done

# Well-formed ids get past the guard (they then fail on tmux, not on parsing).
capture term_agent_alive '@3'
assert_ne 2 "$rc" "a real window id must not be rejected as malformed"
capture term_agent_alive '%77'
assert_ne 2 "$rc" "a real pane id must not be rejected as malformed"

# --- usage errors ----------------------------------------------------------

capture term_container_create
assert_eq 2 "$rc"
assert_contains "$out" "usage: term_container_create"

capture term_container_create 'has:colon'
assert_eq 2 "$rc"
assert_contains "$out" "target separator"

# tmux splits a target on '.' too, even for something that can only be a
# session, so a container named `fix v1.2` could never be attached to by name.
capture term_container_create 'fix v1.2'
assert_eq 2 "$rc"
assert_contains "$out" "target separator"

capture term_agent_start '$0' 'label'
assert_eq 2 "$rc" "a command is required"

capture term_agent_start -c "$tmp/no-such-dir" '$0' 'label' sleep 1
assert_eq 2 "$rc"
assert_contains "$out" "no such directory"

capture term_agent_start --nonsense '$0' 'label' sleep 1
assert_eq 2 "$rc"
assert_contains "$out" "unknown option"

capture term_read '%1' 'twenty'
assert_eq 2 "$rc"
assert_contains "$out" "whole number of lines"

# --- Trace: backend herdr fails closed -------------------------------------
#
# Herdr is design-complete and deliberately not implemented. Every one of the
# seven refuses, and says the same thing, so it cannot half-work.

mk_config "$home" '{ "version": 1, "backend": "herdr" }'

for call in \
	"term_container_create t042" \
	"term_agent_start \$0 yan claude" \
	"term_send %1 hello" \
	"term_read %1" \
	"term_agent_alive %1" \
	"term_agent_close %1" \
	"term_list \$0"; do
	# shellcheck disable=SC2086 # the call is a fixed literal built above, not user input
	capture $call
	assert_ne 0 "$rc" "herdr must fail closed: $call"
	assert_contains "$out" "not implemented in the MVP" "$call"
	assert_contains "$out" "backend" "$call"
done

mk_config "$home" '{ "version": 1, "backend": "screen" }'
capture term_list '$0'
assert_ne 0 "$rc"
assert_contains "$out" "tmux only"

# A missing backend field means tmux, the documented default (Appendix D).
mk_config "$home" '{ "version": 1 }'
capture term_list '$0'
assert_not_contains "$out" "not implemented in the MVP"

mk_config "$home" '{ "version": 1, "backend": "tmux" }'

# jq.exe on Git Bash can answer with CRLF. A trailing CR is invisible in every
# error message it appears in, and it would turn the herdr refusal into a
# generic "unknown backend" - or, far worse, stop "tmux" matching at all. Put a
# jq that always adds one in front of the real one and nothing may change.
crlf_bin=$tmp/crlf-bin
mkdir -p "$crlf_bin"
real_jq=$(command -v jq)
cat >"$crlf_bin/jq" <<EOF
#!/usr/bin/env bash
out=\$("$real_jq" "\$@") || exit \$?
printf '%s' "\$out" | sed 's/\$/\r/'
EOF
chmod +x "$crlf_bin/jq"
assert_contains "$(printf '{"backend":"tmux"}' | "$crlf_bin/jq" -r '.backend' | od -c)" '\r' \
	"the stand-in jq really does emit CRLF"

mk_config "$home" '{ "version": 1, "backend": "herdr" }'
capture env PATH="$crlf_bin:$PATH" YAN_HOME="$home" "$(command -v bash)" -c \
	". \"$YAN_REPO_ROOT/bin/lib-term.sh\"; term_list '\$0'"
assert_ne 0 "$rc"
assert_contains "$out" "not implemented in the MVP" "a CR must not hide the herdr refusal"

mk_config "$home" '{ "version": 1, "backend": "tmux" }'
capture env PATH="$crlf_bin:$PATH" YAN_HOME="$home" "$(command -v bash)" -c \
	". \"$YAN_REPO_ROOT/bin/lib-term.sh\"; term_send 'not-an-id' hello"
assert_eq 2 "$rc" "a CR must not stop tmux being recognised as the backend"
assert_contains "$out" "never a label"

# --- Trace: alive returns only alive | dead | unknown ----------------------
#
# The one verdict that is hard to produce on a healthy machine is `unknown`:
# make tmux unreachable and the honest answer is that we cannot tell. It must
# never be rounded up to `alive`.

bash_bin=$(command -v bash)
empty=$tmp/empty-path
mkdir -p "$empty"
capture env YAN_HOME="$home" PATH="$empty" "$bash_bin" -c \
	". \"$YAN_REPO_ROOT/bin/lib-term.sh\"; term_agent_alive '@3'"
assert_contains "$out" "unknown" "no tmux to ask means unknown, never alive"
assert_not_contains "$out" "alive" "unknown must never be rounded up to alive"

# --- Trace: this file cannot close a container or the server ---------------

assert_fail grep -n 'kill-session' "$src"
assert_fail grep -n 'kill-server' "$src"
assert_ok grep -n 'kill-window' "$src"
assert_ok grep -n 'kill-pane' "$src"

# --- the winpty branch is present and is a branch --------------------------
#
# conventions §2.1: a native console program in an MSYS2 tmux pane gets a pipe
# instead of a console and exits. The wrap is required on Windows and must not
# happen on Linux, so it has to hang off boot_platform.

assert_ok grep -n 'boot_platform' "$src"
assert_ok grep -n 'winpty' "$src"
capture grep -c 'winpty' "$src"
assert_ne "0" "$out"

# --- detached spawning is not optional -------------------------------------

assert_ok grep -n 'new-session -d' "$src"
assert_ok grep -n 'new-window -d' "$src"

printf 'ok\n'
