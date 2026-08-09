#!/usr/bin/env bash
#
# Phase 1 Trace bullet 1: `yan repo-add` clones into repos/ and is the only
# writer of mem/repos.json.
#
# Real git against a LOCAL BARE REMOTE built by mk_bare_remote. Nothing here
# touches the network.
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
yan=$home/bin/yan
registry=$home/mem/repos.json

bare=$tmp/origin/monorepo-x.git
mk_bare_remote "$bare"

# --- the clone lands in repos/, the registry gets the Appendix D fields ----

capture bash "$yan" repo-add "$bare"
assert_eq 0 "$rc" "repo-add should succeed"
assert_file_exists "$home/repos/monorepo-x/README.md" "the clone goes into repos/<name>/"
assert_file_exists "$home/repos/monorepo-x/.git"

assert_eq 1 "$(jq -r .version "$registry")" "the registry carries version"
assert_eq mr "$(jq -r '."monorepo-x".mode_default' "$registry")" "mode_default defaults to mr"
assert_eq 8 "$(jq -r '."monorepo-x".pool_size' "$registry")" "pool_size defaults to 8"
assert_eq '["mode_default","pool_size","url"]' "$(jq -c '."monorepo-x" | keys' "$registry")"

# --- idempotent, and it never re-clones over an existing clone -------------

printf 'warm\n' >"$home/repos/monorepo-x/warm-cache"

# user tunes the two fields by hand, exactly as Appendix D intends.
jq '."monorepo-x".pool_size = 3 | ."monorepo-x".mode_default = "branch"' "$registry" >"$tmp/r" &&
	mv "$tmp/r" "$registry"

capture bash "$yan" repo-add "$bare"
assert_eq 0 "$rc" "re-adding a known repository is a no-op, not an error"
assert_contains "$out" 'no re-clone'
assert_eq 3 "$(jq -r '."monorepo-x".pool_size' "$registry")" "a tuned pool_size must survive"
assert_eq branch "$(jq -r '."monorepo-x".mode_default' "$registry")" "a tuned mode_default must survive"
assert_file_exists "$home/repos/monorepo-x/warm-cache" "the existing clone must not be replaced"

# An explicit flag is the only thing that changes a tuned field.
capture bash "$yan" repo-add "$bare" --pool-size 5
assert_eq 0 "$rc"
assert_eq 5 "$(jq -r '."monorepo-x".pool_size' "$registry")"
assert_eq branch "$(jq -r '."monorepo-x".mode_default' "$registry")"

# --- a directory in the way is refused, never cloned over ------------------

other=$tmp/origin/service-y.git
mk_bare_remote "$other"
mkdir -p "$home/repos/service-y"
printf 'not a clone\n' >"$home/repos/service-y/hand-made"

capture bash "$yan" repo-add "$other"
assert_ne 0 "$rc" "repo-add must refuse to clone over an existing directory"
assert_contains "$out" 'already exists'
assert_file_exists "$home/repos/service-y/hand-made" "the refusal must be before anything destructive"
assert_eq null "$(jq -r '."service-y" // "null"' "$registry")" "a refused add registers nothing"

rm -rf "$home/repos/service-y"
capture bash "$yan" repo-add "$other"
assert_eq 0 "$rc"
assert_file_exists "$home/repos/service-y/README.md"
assert_eq 8 "$(jq -r '."service-y".pool_size' "$registry")"

# --- the same name from a different URL is refused ------------------------

capture bash "$yan" repo-add "$tmp/origin/../origin/service-y.git" --name monorepo-x
assert_ne 0 "$rc"
assert_contains "$out" 'already registered'
assert_eq "$(native_path "$bare")" "$(jq -r '."monorepo-x".url' "$registry")"

# --- explicit name, and the registry stays a valid single object ----------

capture bash "$yan" repo-add "$other" --name mirror --mode-default scout --pool-size 2
assert_eq 0 "$rc"
assert_file_exists "$home/repos/mirror/README.md"
assert_eq scout "$(jq -r '.mirror.mode_default' "$registry")"
assert_eq 2 "$(jq -r '.mirror.pool_size' "$registry")"

assert_ok jq empty "$registry"
assert_eq '["mirror","monorepo-x","service-y","version"]' "$(jq -c 'keys' "$registry")"
assert_eq 0 "$(find "$home/mem" -name '.yan-json.*' | wc -l)" "no temp file may be left behind"

# --- argument errors -------------------------------------------------------

assert_fail bash "$yan" repo-add
assert_fail bash "$yan" repo-add "$bare" --mode-default wander
assert_fail bash "$yan" repo-add "$bare" --pool-size 0
assert_fail bash "$yan" repo-add "$bare" --pool-size many
assert_fail bash "$yan" repo-add "$bare" --name 'bad/name'
assert_fail bash "$yan" repo-add "$bare" "$other"
assert_fail bash "$yan" repo-add "$tmp/origin/version.git" # `version` is taken by the file itself

printf 'ok\n'
