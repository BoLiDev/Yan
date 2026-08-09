#!/usr/bin/env bash
#
# Phase 9 Trace bullet 5, first half:
#
#   `yan mr` OPENS THE OUTBOUND MR AND WRITES unit.mr
#
# boundaries.md §9.2 puts this row in the "on its own" column, because opening
# a merge request is reversible: it can be closed and nothing outside `user`'s
# own branches has changed. Its sibling row - merging that MR into `target` -
# is `yan land`, and `user` has to ask. Two rows, two files; the split is the
# reason both exist.
#
# The forge is the stand-in (architecture.md §7), so nothing here reaches the
# network. git is a recorder on PATH: the only git this command may run is the
# question "is the integration branch on the remote yet", and that is worth
# proving as much as the MR itself - pushing it is `yan sync`'s step
# (branching.md §6.3) and must not be duplicated here.
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
cp "$YAN_REPO_ROOT/tests/stub/lib-forge.sh" "$home/bin/lib-forge.sh"

export YAN_HOME=$home
export YAN_STUB_FORGE_DIR=$tmp/forge
yan=$home/bin/yan

mkdir -p "$home/repos/monorepo-x" "$tmp/bin"
cat >"$tmp/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >>"${GIT_RECORD:?}"
exit "${FAKE_GIT_RC:-0}"
EOF
chmod +x "$tmp/bin/git"
export GIT_RECORD=$tmp/git.log
PATH=$tmp/bin:$PATH
export PATH

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth
task_unit_add t042 proto monorepo-x master --branch feat/proto --mode branch
task_unit_add t042 probe monorepo-x master --branch feat/probe --mode scout

fcalls() { cat "$tmp/forge/calls" 2>/dev/null || true; }

# --- it opens the MR and records the URL ------------------------------------

export YAN_STUB_FORGE_MR_URL='https://forge.invalid/acme/monorepo-x/-/merge_requests/88'
capture env bash "$yan" mr --task t042 --unit auth
assert_eq 0 "$rc" "$out"
assert_contains "$out" 'https://forge.invalid/acme/monorepo-x/-/merge_requests/88'

assert_contains "$(fcalls)" 'mr_create source=feat/auth target=master draft=0' \
	'the outbound MR runs integration branch -> target (branching.md §6.2)'

assert_eq 'https://forge.invalid/acme/monorepo-x/-/merge_requests/88' \
	"$(task_unit_get t042 auth mr)" \
	'unit.mr is one of the four current scalars, written when yan mr opens it'

assert_contains "$(cat "$home/tasks/t042/log.md")" 'outbound MR opened'

# The one git question this command asks, and no other.
assert_contains "$(cat "$GIT_RECORD")" 'ls-remote'
assert_not_contains "$(cat "$GIT_RECORD")" ' push ' \
	'pushing the integration branch is yan sync, and stays there'
assert_not_contains "$(cat "$GIT_RECORD")" '--force'

# --- a round has ONE outbound MR --------------------------------------------

capture env bash "$yan" mr --task t042 --unit auth
assert_eq 2 "$rc"
assert_contains "$out" 'already has an outbound merge request'
assert_contains "$out" 'unit set --branch' 'a new round is how a second one is opened'

# --- mode decides whether an MR is even the deliverable ---------------------
#
# delivery.md §8.2: a `branch` unit delivers a clean local branch and a `scout`
# delivers a report. Neither opens a merge request.

rm -f "$tmp/forge/calls"
capture env bash "$yan" mr --task t042 --unit proto
assert_eq 2 "$rc"
assert_contains "$out" "mode 'branch'"
capture env bash "$yan" mr --task t042 --unit probe
assert_eq 2 "$rc"
assert_contains "$out" 'scout'
assert_eq '' "$(fcalls)" 'and the forge was never asked'

# --- the branch has to be on the remote first -------------------------------

task_init t043 'not pushed yet'
task_unit_add t043 auth monorepo-x master --branch feat/later
capture env FAKE_GIT_RC=2 bash "$yan" mr --task t043 --unit auth
assert_ne 0 "$rc"
assert_contains "$out" 'not on the remote yet'
assert_contains "$out" 'yan sync'
assert_eq '' "$(task_unit_get t043 auth mr)" 'and nothing was recorded'

# --- a forge that refuses records nothing -----------------------------------

capture env YAN_STUB_FORGE_CREATE_RC=1 bash "$yan" mr --task t043 --unit auth
assert_ne 0 "$rc"
assert_eq '' "$(task_unit_get t043 auth mr)" \
	'unit.mr is written only after the forge confirmed the URL'

# --- usage errors -----------------------------------------------------------

capture env bash "$yan" mr --task t042
assert_eq 2 "$rc"
assert_contains "$out" '--unit is required'

capture env bash "$yan" mr --task nosuch --unit auth
assert_eq 2 "$rc"
assert_contains "$out" 'no such task'

capture env bash "$yan" mr --task t042 --unit nosuch
assert_eq 2 "$rc"
assert_contains "$out" 'no such unit'

capture env bash "$yan" mr --task t042 --unit auth --body a --body-file b
assert_eq 2 "$rc"
assert_contains "$out" 'alternatives'

printf 'ok\n'
