#!/usr/bin/env bash
#
# Phase 9 Trace bullets 1, 3 and 4, from the soft side:
#
#   soft path on a TTY with missing args -> Clack -> HARD PATH WITH FULL FLAGS
#   `yan continue` without an id selects among the INCOMPLETE tasks
#   monorepo detection offers a package multiselect; ONE UNIT PER PACKAGE
#
# What a test can and cannot prove here, and why the split is drawn where it
# is: Clack needs a real terminal, and a test runner has none. So the prompts
# themselves are not exercised - the ANSWERS ARE SCRIPTED and everything below
# the last answer is. That "everything below" is the actual contract between
# `ui/` and the rest of yan (architecture.md §2): answers in, `yan <cmd>` with
# a full set of flags out. If the assembly is right, the only untested part is
# Clack drawing a menu.
#
# The two environment variables are documented in ui/soft-path.mjs:
#   YAN_UI_TEST_ANSWERS  answer every prompt from a JSON file
#   YAN_UI_PRINT_ONLY    print the assembled argv instead of running it
#
# It goes through bin/lib-ui.sh's ui_run rather than calling node directly, so
# the node discovery this needs on Linux (nvm is not on a non-interactive
# shell's PATH, conventions §1) is part of what is being tested.
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

# ui/ is not part of mk_yan_home's skeleton (node_modules/ would come with it),
# so the sources are copied in by hand.
mkdir -p "$home/ui/lib"
cp "$YAN_REPO_ROOT/ui/package.json" "$home/ui/package.json"
cp "$YAN_REPO_ROOT/ui/soft-path.mjs" "$home/ui/soft-path.mjs"
cp "$YAN_REPO_ROOT/ui/lib/plan.mjs" "$home/ui/lib/plan.mjs"

# --- dependencies absent must read like a sentence, not a stack trace -------
#
# node_modules/ is gitignored, so "not installed yet" is the ordinary state of
# a fresh clone (cli-ux.md §2).

cat >"$tmp/why" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
. "$YAN_HOME/bin/lib-ui.sh"
ui_why_unavailable
EOF

capture bash "$tmp/why"
assert_eq 0 "$rc"
assert_contains "$out" '@clack/prompts is not installed'
assert_contains "$out" 'npm install'
assert_not_contains "$out" 'ERR_MODULE_NOT_FOUND'

# With the dependency in place the soft path reports itself as available.
mkdir -p "$home/ui/node_modules/@clack/prompts"
capture bash "$tmp/why"
assert_eq 0 "$rc"
assert_eq '' "$out" 'nothing is in the way once node and clack are both there'

# --- the harness ------------------------------------------------------------

cat >"$tmp/soft" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
. "$YAN_HOME/bin/lib-ui.sh"
ui_run "$@"
EOF

answers=$tmp/answers.json
soft() { # soft <ui command> [args...] - print the argv the ui would run
	capture env YAN_UI_PRINT_ONLY=1 YAN_UI_TEST_ANSWERS="$answers" \
		bash "$tmp/soft" "$@" <"/dev/null"
}

# node itself has to be findable. On Linux it comes from nvm and is NOT on a
# non-interactive shell's PATH, which is exactly the case lib-ui handles.
cat >"$tmp/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
. "$YAN_HOME/bin/lib-ui.sh"
ui_node
EOF
capture bash "$tmp/node"
assert_eq 0 "$rc" "lib-ui could not find node on this machine: $out"

# --- a monorepo: one unit per selected package ------------------------------

mkdir -p "$home/repos/monorepo-x/packages/auth" \
	"$home/repos/monorepo-x/packages/web" \
	"$home/repos/monorepo-x/apps/admin"
printf 'packages:\n  - "packages/*"\n' >"$home/repos/monorepo-x/pnpm-workspace.yaml"
mkdir -p "$home/repos/proto"

jq -n '{version: 1,
        "monorepo-x": {url: "git@example.invalid:acme/monorepo-x.git", mode_default: "mr"},
        "proto":      {url: "git@example.invalid:acme/proto.git", mode_default: "mr"}}' \
	>"$home/mem/repos.json"

cat >"$answers" <<'JSON'
{
  "title": "unify the auth header",
  "description": "the same header, everywhere",
  "repos": ["monorepo-x"],
  "scopes.monorepo-x": ["apps/admin", "packages/auth"],
  "target.monorepo-x": "master"
}
JSON

soft task-new
assert_eq 0 "$rc" "$out"
argv=$out

# The hand-off is `yan task new` with EVERY flag filled in - the hard path, the
# same one an agent would have called (cli-ux.md §1).
assert_eq 'task' "$(printf '%s' "$argv" | jq -r '.[0]')"
assert_eq 'new' "$(printf '%s' "$argv" | jq -r '.[1]')"
assert_contains "$argv" '"--title","unify the auth header"'
assert_contains "$argv" '"--description","the same header, everywhere"'

# One selected package is one unit, with that path as its scope
# (cli-ux.md §5, branching.md §6.4: one sub-application, one branch, one tree).
assert_eq 2 "$(printf '%s' "$argv" | jq '[.[] | select(. == "--repo")] | length')" \
	'two packages selected under one repo become two units in the same run'
assert_contains "$argv" '"--unit","admin","--scope","apps/admin","--target","master"'
assert_contains "$argv" '"--unit","auth","--scope","packages/auth","--target","master"'

# --- the escape is always there ---------------------------------------------
#
# cli-ux.md §5: a noisy list is acceptable as long as "the whole repository"
# stays one of the choices. It is the empty scope, because the prefix that
# matches every path is no prefix at all.

cat >"$answers" <<'JSON'
{
  "title": "everything, everywhere",
  "description": "",
  "repos": ["monorepo-x"],
  "scopes.monorepo-x": [""],
  "target.monorepo-x": "master"
}
JSON

soft task-new
assert_eq 0 "$rc" "$out"
assert_eq '["task","new","--title","everything, everywhere","--repo","monorepo-x","--unit","monorepo-x","--target","master"]' \
	"$out" 'the whole repository is one unit with no --scope at all'

# --- a repository that is not a monorepo ------------------------------------

cat >"$answers" <<'JSON'
{
  "title": "bump the proto",
  "description": "",
  "repos": ["proto"],
  "target.proto": "main"
}
JSON

soft task-new
assert_eq 0 "$rc" "$out"
assert_eq '["task","new","--title","bump the proto","--repo","proto","--unit","proto","--target","main"]' "$out"

# --- values already on the command line are not asked for again -------------

cat >"$answers" <<'JSON'
{ "repos": ["proto"], "target.proto": "main" }
JSON

soft task-new --title 'given up front' --description 'also given'
assert_eq 0 "$rc" "$out"
assert_contains "$out" '"--title","given up front"'
assert_contains "$out" '"--description","also given"'

# --- yan continue: select among the INCOMPLETE tasks ------------------------

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
task_init t001 'still going'
task_unit_add t001 auth monorepo-x master --branch feat/auth
task_init t002 'finished ages ago'
task_set_complete t002 true

cat >"$answers" <<'JSON'
{ "task": "t001" }
JSON

soft continue
assert_eq 0 "$rc" "$out"
assert_eq '["continue","--task","t001"]' "$out" \
	'the selection comes straight back as the hard-path flag'

# When every task is complete there is nothing to select, and that is said
# rather than shown as an empty menu.
task_set_complete t001 true
soft continue
assert_ne 0 "$rc"
assert_contains "$out" 'no incomplete tasks'

# --- the ui refuses to be a second entry point ------------------------------

soft nonsense
assert_eq 2 "$rc"
assert_contains "$out" 'unknown soft path'

printf 'ok\n'
