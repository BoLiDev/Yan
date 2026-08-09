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

# --- a commit identity every leased worktree can see ------------------------
#
# Every shift commits, and it commits in a leased worktree under ~/.yan-trees -
# not in this checkout and not in the main clone. An identity that lives only
# in a repository's own .git/config is therefore invisible where it is needed,
# and `git commit` fails after the work is already done.
#
# Found on the machine yan was built on: Git Bash had no global identity at
# all, while the checkout had a local one - which reads as perfectly healthy
# from inside the checkout.
#
# GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM point git at files we control, so this
# neither reads nor writes the developer's real configuration.

idhome=$tmp/idhome
mk_yan_home "$idhome"

: >"$tmp/empty-global"
: >"$tmp/empty-system"
GIT_CONFIG_GLOBAL=$tmp/empty-global GIT_CONFIG_SYSTEM=$tmp/empty-system \
	capture bash "$idhome/bin/yan" doctor
assert_contains "$out" "git identity" "doctor must ask about the commit identity"
assert_contains "$out" "leased worktree" "and say why a local identity is not enough"
assert_ne 0 "$rc" "a missing commit identity is a failure, not a warning"

printf '[user]\n\tname = Test Person\n\temail = test@example.invalid\n' >"$tmp/good-global"
GIT_CONFIG_GLOBAL=$tmp/good-global GIT_CONFIG_SYSTEM=$tmp/empty-system \
	capture bash "$idhome/bin/yan" doctor
assert_contains "$out" "Test Person <test@example.invalid>" "a global identity satisfies it"
