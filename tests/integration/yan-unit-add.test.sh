#!/usr/bin/env bash
#
# Phase 6, Trace bullet 1: `unit add` requires an explicit target, and when the
# branch-name hook exits non-zero it STOPS - it never falls back to the
# built-in default (td boundaries.md §10).
#
# That second half is the one worth a real repository. The failure it guards
# against is silent: yan would create `yan/t1-api-r1`, the team's naming rules
# would reject it at the forge much later, and by then the branch has commits
# on it. So the test does not only check the exit code - it checks that NO
# branch was created and NO unit was written.
#
# Real git against a local bare remote. Nothing here touches the network.
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
HOOKS=$home/conf/hooks

bare=$tmp/remote.git
clone=$home/repos/demo
mk_bare_remote "$bare"
mk_clone "$bare" "$clone"

yan() { env YAN_HOME="$home" bash "$YAN" "$@"; }

task_new() { # task_new <id> <title>
	env YAN_HOME="$home" bash -c '
		set -euo pipefail
		# shellcheck source=/dev/null
		. "$YAN_HOME/bin/lib-task.sh"
		task_init "$1" "$2"
	' _ "$1" "$2"
}

unit_field() { # unit_field <task> <unit> <field>
	jq -r --arg u "$2" --arg f "$3" \
		'.units[] | select(.name == $u) | .[$f] // ""' "$home/tasks/$1/task.json"
}

has_branch() { # has_branch <branch>
	fx_git -C "$clone" show-ref --verify --quiet "refs/heads/$1"
}

write_hook() { # write_hook <body>
	mkdir -p "$HOOKS"
	printf '#!/usr/bin/env bash\n%s\n' "$1" >"$HOOKS/branch-name"
}

task_new t1 'a demo task'

# --- target is never defaulted ----------------------------------------------

capture yan unit add --task t1 --unit auth --repo demo
assert_eq 2 "$rc"
assert_contains "$out" "--target is required"
assert_eq 0 "$(jq '.units | length' "$home/tasks/t1/task.json")" "a refused add writes nothing"

# --- with no hook installed, the built-in default applies -------------------
#
# yan/<task>-<unit>-r<n>, n = len(history) + 1 (branching.md §6.5). The round
# number is in the name because the integration branch gets replaced wholesale,
# and the same name cannot be created twice.

capture yan unit add --task t1 --unit auth --repo demo --target main --scope apps/auth
assert_eq 0 "$rc" "$out"
assert_eq yan/t1-auth-r1 "$(unit_field t1 auth branch)"
assert_eq main "$(unit_field t1 auth target)"
assert_ok has_branch yan/t1-auth-r1
assert_eq "$(fx_git -C "$clone" rev-parse origin/main)" "$(fx_git -C "$clone" rev-parse yan/t1-auth-r1)" \
	"a new integration branch is cut from the target"

# The main clone is never checked out into (boundaries.md §9.1): the only write
# allowed there is a fetch, and creating a ref is not a working-tree write.
assert_eq main "$(fx_git -C "$clone" rev-parse --abbrev-ref HEAD)"
assert_eq '' "$(fx_git -C "$clone" status --porcelain)"

capture yan unit add --task t1 --unit auth --repo demo --target main
assert_ne 0 "$rc"
assert_contains "$out" "already exists"

# --- TRACE 1: the hook refuses, so nothing happens --------------------------

write_hook 'printf "AUTH-123 has no branch yet; ask the release manager\n" >&2; exit 1'

capture yan unit add --task t1 --unit api --repo demo --target main
assert_ne 0 "$rc" "a refusing hook stops the command"
assert_contains "$out" "refused"
assert_contains "$out" "ask the release manager" "the hook's own words reach the user"

assert_eq '' "$(unit_field t1 api branch)" "no unit may be written after a refusal"
assert_eq 1 "$(jq '.units | length' "$home/tasks/t1/task.json")"
assert_fail has_branch yan/t1-api-r1 \
	"THE regression: yan must not quietly fall back to its built-in default"

# --- a hook that answers owns the name, whatever shape it has ---------------

write_hook 'printf "looked up the ticket...\n"; printf "team/AUTH-123_integration\n"'

capture yan unit add --task t1 --unit api --repo demo --target main
assert_eq 0 "$rc" "$out"
assert_eq team/AUTH-123_integration "$(unit_field t1 api branch)" \
	"a hook-supplied name is used as is; the round number plays no part"
assert_ok has_branch team/AUTH-123_integration

# --- an explicit name is user's decision already, so the hook is not asked ---

write_hook 'exit 1'

capture yan unit add --task t1 --unit docs --repo demo --target main --branch spike/docs
assert_eq 0 "$rc" "$out"
assert_eq spike/docs "$(unit_field t1 docs branch)"
assert_ok has_branch spike/docs

rm -f "$HOOKS/branch-name"

# --- a branch that already exists on the remote is adopted, not re-cut ------

fx_git -C "$clone" push origin main:already/there >/dev/null 2>&1
fx_git -C "$clone" update-ref -d refs/remotes/origin/already/there 2>/dev/null || true
assert_fail has_branch already/there

capture yan unit add --task t1 --unit legacy --repo demo --target main --branch already/there
assert_eq 0 "$rc" "$out"
assert_contains "$out" "adopted"
assert_ok has_branch already/there
assert_eq "$(fx_git -C "$bare" rev-parse already/there)" "$(fx_git -C "$clone" rev-parse already/there)"

# --- a base that does not exist is refused rather than invented -------------

capture yan unit add --task t1 --unit ghost --repo demo --target no/such/branch
assert_ne 0 "$rc"
assert_contains "$out" "cannot resolve the base"
assert_eq '' "$(unit_field t1 ghost branch)"

# --- the log tells the story -------------------------------------------------

log=$(cat "$home/tasks/t1/log.md")
assert_contains "$log" "auth  unit added on yan/t1-auth-r1"
assert_contains "$log" "name from hook"
assert_contains "$log" "name from user"

printf 'ok\n'
