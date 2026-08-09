#!/usr/bin/env bash
#
# `yan doctor` is the whole bootstrap checklist. bin/yan itself only does the
# two universal checks inline.
#
# Nothing in this file may touch the network, so only the github shape is
# exercised (gh is checked with `command -v`); the gitlab path additionally
# runs `glab auth status` and therefore belongs in integration/e2e.
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

# --- the sample-shaped config: github, tmux -------------------------------

capture bash "$YAN" doctor
assert_contains "$out" "yan doctor"
assert_contains "$out" "git"
assert_contains "$out" "jq"
assert_contains "$out" "conf/config.json"
assert_contains "$out" "backend (tmux)"
assert_contains "$out" "forge (github)"
assert_not_contains "$out" "glab" "only the CLI selected by forge.kind may be checked"

# node is listed but never fatal in the MVP.
assert_contains "$out" "node"

# --- herdr fails closed ----------------------------------------------------

mk_config "$home" '{
  "version": 1,
  "agents": { "yan": "claude", "shift": "claude" },
  "forge": { "kind": "github" },
  "backend": "herdr"
}'
capture bash "$YAN" doctor
assert_ne 0 "$rc" "backend: herdr must fail closed"
assert_contains "$out" "herdr is not implemented in the MVP"

# --- an unknown backend is refused too -------------------------------------

mk_config "$home" '{
  "version": 1,
  "agents": { "yan": "claude", "shift": "claude" },
  "forge": { "kind": "github" },
  "backend": "screen"
}'
capture bash "$YAN" doctor
assert_ne 0 "$rc"
assert_contains "$out" "the MVP supports tmux only"

# --- backend defaults to tmux when absent ----------------------------------

mk_config "$home" '{
  "version": 1,
  "agents": { "yan": "claude", "shift": "claude" },
  "forge": { "kind": "github" }
}'
capture bash "$YAN" doctor
assert_contains "$out" "backend (tmux)"

# --- a missing / unusable forge.kind is a failure --------------------------

mk_config "$home" '{ "version": 1, "agents": { "yan": "claude", "shift": "claude" } }'
capture bash "$YAN" doctor
assert_ne 0 "$rc"
assert_contains "$out" "forge.kind"

mk_config "$home" '{
  "version": 1,
  "agents": { "yan": "claude", "shift": "claude" },
  "forge": { "kind": "bitbucket" }
}'
capture bash "$YAN" doctor
assert_ne 0 "$rc"
assert_contains "$out" "unknown value 'bitbucket'"

# --- a missing config is reported, not a crash -----------------------------

rm -f "$home/conf/config.json"
capture bash "$YAN" doctor
assert_ne 0 "$rc"
assert_contains "$out" "conf/config.sample.json"

# --- the shipped sample is valid and matches Appendix D --------------------

sample=$YAN_REPO_ROOT/conf/config.sample.json
assert_file_exists "$sample"
assert_ok jq empty "$sample"
assert_eq 1 "$(jq -r .version "$sample")"
assert_ne "" "$(jq -r '.agents.yan' "$sample")"
assert_ne "" "$(jq -r '.agents.shift' "$sample")"
assert_ne "" "$(jq -r '.forge.kind' "$sample")"
assert_eq tmux "$(jq -r '.backend' "$sample")"

printf 'ok\n'
