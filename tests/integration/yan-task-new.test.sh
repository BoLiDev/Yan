#!/usr/bin/env bash
#
# Phase 9 Trace bullet 2:
#
#   `yan task new` ENDS WITH `user` INSIDE THE TASK CONTAINER (create + enter)
#
# cli-ux.md §3: create is not "mkdir plus an empty brief". It is the contract,
# the involved repositories, a concrete scope, at least one unit - and the
# multiplexer session with the main agent already running. There is no separate
# start step and no `yan start` in the inventory, so a create that stopped at
# task.json would leave the whole product sentence unfinished.
#
# Real git against a local bare remote, because `yan unit add` really cuts the
# integration branch. The terminal is the stand-in that records calls: "user is
# inside the task" is then an assertion about which container was created and
# which agent was started in it, and the ENTER STEP IS NOT A COPY - it is
# `yan continue`, so the recorded calls are `continue`'s.
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

export YAN_HOME=$home
export YAN_STUB_TERM_DIR=$tmp/calls
yan=$home/bin/yan

clog() { cat "$tmp/calls/calls" 2>/dev/null || true; }

# A monorepo and a plain repository, both registered the ordinary way.
mk_bare_remote "$tmp/mono.git"
mk_bare_remote "$tmp/proto.git"
bash "$yan" repo-add "$tmp/mono.git" --name monorepo-x >/dev/null
bash "$yan" repo-add "$tmp/proto.git" --name proto >/dev/null
mkdir -p "$home/repos/monorepo-x/apps/auth" "$home/repos/monorepo-x/apps/admin"

# --- create ------------------------------------------------------------------
#
# Three units across two repositories in one run: one unit per package is the
# soft path's default (cli-ux.md §5), and the hard path expresses it as a
# repeated --repo block.

capture env bash "$yan" task new \
	--title 'unify the auth header' \
	--description 'the same header, everywhere' \
	--repo monorepo-x --scope apps/auth --target main \
	--repo monorepo-x --scope apps/admin --target main \
	--repo proto --target main --needs auth \
	</dev/null
assert_eq 0 "$rc" "$out"

# --- the id is t042-shaped ---------------------------------------------------
#
# scope.md §12's current leaning: a plain sequence number, with the readable
# title living in brief.md and log.md. It also goes into branch names
# (branching.md §6.5), where short is worth something.

assert_file_exists "$home/tasks/t001/task.json"
assert_eq 'unify the auth header' "$(jq -r .title "$home/tasks/t001/task.json")"
assert_contains "$(cat "$home/tasks/t001/brief.md")" 'the same header, everywhere'
assert_contains "$(cat "$home/tasks/t001/log.md")" 'task created'

# --- one unit per package, named after the package ---------------------------

detail=$(bash "$yan" ls t001 --json)
assert_eq 3 "$(printf '%s' "$detail" | jq '.units | length')"
assert_eq 'auth admin proto' "$(printf '%s' "$detail" | jq -r '[.units[].name] | join(" ")')"
assert_eq 'apps/auth' "$(printf '%s' "$detail" | jq -r '.units[0].scope | join(" ")')"
assert_eq 'apps/admin' "$(printf '%s' "$detail" | jq -r '.units[1].scope | join(" ")')"
assert_eq '' "$(printf '%s' "$detail" | jq -r '.units[2].scope | join(" ")')" \
	'a non-monorepo unit scopes the repo root, which is the empty prefix list'
assert_eq 'auth' "$(printf '%s' "$detail" | jq -r '.units[2].needs | join(" ")')"
assert_eq 'main' "$(printf '%s' "$detail" | jq -r '.units[0].target')"

# The integration branches really exist in the main clones.
assert_ok git -C "$home/repos/monorepo-x" show-ref --verify --quiet refs/heads/yan/t001-auth-r1
assert_ok git -C "$home/repos/monorepo-x" show-ref --verify --quiet refs/heads/yan/t001-admin-r1
assert_ok git -C "$home/repos/proto" show-ref --verify --quiet refs/heads/yan/t001-proto-r1

# --- and `user` is inside the task -------------------------------------------

log=$(clog)
assert_contains "$log" 'container_create name=t001 unify the auth header' \
	'create ends by creating the task container'
start=$(printf '%s\n' "$log" | grep '^agent_start ')
assert_contains "$start" 'label=yan' 'and by starting agents.yan inside it'
assert_contains "$start" 'YAN_TASK=t001'
assert_contains "$start" "dir=$home"
assert_contains "$start" "--add-dir $home/repos/monorepo-x"
assert_contains "$start" "--add-dir $home/repos/proto" \
	'every clone this task touches, and nothing else'

order=$(printf '%s\n' "$log" | sed -n 's/^\([a-z_]*\).*/\1/p' | tr '\n' ' ')
assert_eq 'container_create list agent_start ' "$order" \
	'the enter step is yan continue itself, not a second copy of it'

# --- a second run allocates the next id, and enters that one -----------------

rm -f "$tmp/calls/calls"
capture env bash "$yan" task new --title 'something else' \
	--repo proto --target main --json </dev/null
assert_eq 0 "$rc" "$out"
assert_eq t002 "$(printf '%s' "$out" | jq -r .task)"
assert_eq true "$(printf '%s' "$out" | jq -r .entered.started)" \
	'--json still enters; it only changes how the result is printed'
assert_contains "$(clog)" 'container_create name=t002 something else'

# --- an explicit id is used as given ----------------------------------------

capture env bash "$yan" task new --id t042 --title 'the readable title lives here' \
	--repo proto --target main </dev/null
assert_eq 0 "$rc" "$out"
assert_file_exists "$home/tasks/t042/task.json"

# and the next derived id counts from the highest number on disk
capture env bash "$yan" task new --title 'after t042' --repo proto --target main </dev/null
assert_eq 0 "$rc" "$out"
assert_file_exists "$home/tasks/t043/task.json"

printf 'ok\n'
