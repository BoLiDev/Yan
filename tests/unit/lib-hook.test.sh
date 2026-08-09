#!/usr/bin/env bash
#
# Phase 6: the conf/hooks/ seam (td boundaries.md §10).
#
# lib-hook is the only place allowed to execute anything under conf/, and the
# contract it carries is small enough to pin down completely:
#
#   input   JSON on stdin
#   output  ONE LINE on stdout - the last non-empty one, because a hook may
#           create the branch first and print its name at the end
#   missing hook       not an error (nobody configured an outside authority)
#   hook exits non-0   IS an error, and the caller must never paper over it
#
# The asymmetry between stdin and stdout is deliberate: fields can be added to
# the input later without breaking a hook that is already installed.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

export YAN_HOME=$tmp/home
mkdir -p "$YAN_HOME/conf/hooks"

# shellcheck source=bin/lib-hook.sh
. "$YAN_REPO_ROOT/bin/lib-hook.sh"

HOOKS=$YAN_HOME/conf/hooks
CTX='{"task":"t042","unit":"auth","target":"master","scope":["apps/auth"]}'

write_hook() { # write_hook <name> <body>
	printf '#!/usr/bin/env bash\n%s\n' "$2" >"$HOOKS/$1"
}

# --- no hook is not an error ------------------------------------------------

assert_eq "$HOOKS" "$(hook_dir)"
assert_fail hook_exists branch-name

rc=0
out=$(hook_call branch-name "$CTX") || rc=$?
assert_eq "$HOOK_RC_MISSING" "$rc" "a missing hook is 'no outside authority configured', not a failure"
assert_eq '' "$out" "a missing hook prints nothing"

# --- the ordinary case ------------------------------------------------------

write_hook branch-name 'cat > "$YAN_HOME/stdin.json"; printf "feat/auth\n"'
assert_ok hook_exists branch-name

capture hook_call branch-name "$CTX"
assert_eq 0 "$rc"
assert_eq feat/auth "$out"

# The input really is JSON on stdin, whole and parseable.
assert_file_exists "$YAN_HOME/stdin.json"
assert_eq t042 "$(jq -r '.task' "$YAN_HOME/stdin.json")"
assert_eq apps/auth "$(jq -r '.scope[0]' "$YAN_HOME/stdin.json")"

# --- a hook may create the branch first and print the name at the end --------

write_hook branch-name 'printf "creating the branch...\n"; printf "\n"; printf "team/AUTH-123\n"'
capture hook_call branch-name "$CTX"
assert_eq 0 "$rc"
assert_eq team/AUTH-123 "$out" "the answer is the LAST non-empty line"

# A hook written on Windows leaves CR behind; the name must not carry it.
write_hook branch-name 'printf "feat/crlf\r\n"'
hook_call branch-name "$CTX" >"$tmp/answer"
assert_fail grep -q $'\r' "$tmp/answer" "a carriage return would make the branch name name nothing"
assert_eq feat/crlf "$(cat "$tmp/answer")"

# Surrounding blanks are trimmed - a hook that pads its output still answers.
write_hook branch-name 'printf "   feat/padded   \n"'
capture hook_call branch-name "$CTX"
assert_eq feat/padded "$out"

# --- a hook that does not read stdin still succeeds --------------------------
#
# Under `set -o pipefail` a `printf json | hook` producer takes SIGPIPE and the
# pipeline reports 141 even though the hook exited 0. lib-hook uses a
# here-string precisely so this case is not a mysterious failure.

write_hook branch-name 'printf "feat/ignores-stdin\n"'
capture hook_call branch-name "$CTX"
assert_eq 0 "$rc" "a hook that never reads its stdin must not look like a failure"
assert_eq feat/ignores-stdin "$out"

# --- refusal is an error, and it says so -------------------------------------

write_hook branch-name 'printf "this unit is not allowed a branch\n" >&2; exit 1'
capture hook_call branch-name "$CTX"
assert_eq 1 "$rc"
assert_contains "$out" "refused"
assert_contains "$out" "this unit is not allowed a branch" \
	"the hook's own stderr must reach the user unedited"

# A hook that exits 3 must NOT be mistaken for a hook that is not installed.
write_hook branch-name 'exit 3'
capture hook_call branch-name "$CTX"
assert_eq 1 "$rc" "a hook exiting 3 is a refusal, not 'no hook here'"
assert_ne "$HOOK_RC_MISSING" "$rc"

# Exit 0 with nothing to say is also a failure: there is no answer to record.
write_hook branch-name 'exit 0'
capture hook_call branch-name "$CTX"
assert_eq 1 "$rc"
assert_contains "$out" "printed nothing"

# --- an executable hook is run directly --------------------------------------
#
# The bit is optional, because conf/ is gitignored and copied in by hand, and
# on Windows it usually does not survive the copy. Both paths have to work.

write_hook branch-name 'printf "feat/exec\n"'
chmod +x "$HOOKS/branch-name"
capture hook_call branch-name "$CTX"
assert_eq 0 "$rc"
assert_eq feat/exec "$out"

# --- the seam is the only door into conf/, so it guards the doorway ----------

capture hook_path '../../bin/yan'
assert_eq 2 "$rc" "a hook name may not walk out of conf/hooks"
capture hook_path 'sub/dir'
assert_eq 2 "$rc"
capture hook_path '.ssh'
assert_eq 2 "$rc"
capture hook_path ''
assert_eq 2 "$rc"

capture hook_call branch-name
assert_eq 2 "$rc" "hook_call takes a name and a JSON document"

# --- the reserved name is not implemented, and that is not special-cased -----
#
# `merge-check` is a reserved name in boundaries.md §10 and nothing calls it
# yet. Nothing in lib-hook knows any hook's name, so it behaves like any other.

assert_fail hook_exists merge-check
rc=0
hook_call merge-check '{}' >/dev/null || rc=$?
assert_eq "$HOOK_RC_MISSING" "$rc"

printf 'ok\n'
