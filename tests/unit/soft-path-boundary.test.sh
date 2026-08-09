#!/usr/bin/env bash
#
# Phase 9 Trace bullet 6:
#
#   AGENTS NEVER IMPORT NODE / CLACK
#
# architecture.md §2 draws two edges into `bin/`, and they are not the same
# edge. The model's says *only calls subcommands, never sources a lib*; the
# soft path's says *collects answers, then yan with full flags*. `ui/` is for
# people (cli-ux.md §2) and is not a second entry point for agents - agents
# already know their arguments, so they never need node at all.
#
# That is a structural claim, so it is asserted structurally, in three ways
# that fail for different reasons:
#
#   1. AGENTS.md - the only always-loaded context - never sends the model to
#      node, npm, or ui/;
#   2. no shell script outside the one launcher knows where the soft path is;
#   3. AT RUNTIME, a `node` recorder first on PATH is never touched by the
#      commands agents run. That is the assertion the other two cannot make: a
#      grep proves nobody wrote it down, and only running it proves nobody
#      does it.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --- 1. the model's instructions never mention the soft path ----------------

agents=$(cat "$YAN_REPO_ROOT/AGENTS.md")
for word in 'npm ' 'clack' 'Clack' '.mjs' 'soft-path' 'import '; do
	assert_not_contains "$agents" "$word" \
		"AGENTS.md must not send the model into the human soft path (architecture.md §2)"
done

# The two sentences that have to be there. The first is design principle 4
# expressed as an instruction; the second names node explicitly, because "I
# could just run the prompts myself" is the mistake this bullet exists to stop.
assert_contains "$agents" 'only ever run `yan <command>`'
assert_contains "$agents" 'or `node` yourself'

# And the authority rules, which had no home before this phase (boundaries.md
# §9.2): `user` has to ask for unit set, for landing, and for anything a
# colleague sees.
assert_contains "$agents" 'yan unit set'
assert_contains "$agents" 'yan land'
assert_contains "$agents" 'mentioning anyone'

# The Codex checkpoint protocol has to be stated here, because an interactive
# Codex may never fire the project's SessionStart hook (supervision.md).
assert_contains "$agents" 'yan wait --seconds'
assert_contains "$agents" 'no autoarm'

# --- 2. only the launcher knows where ui/ is --------------------------------

leaks=$(grep -rln -e 'soft-path.mjs' -e '@clack' "$YAN_REPO_ROOT/bin" || true)
while IFS= read -r f; do
	[ -n "$f" ] || continue
	case ${f##*/} in
	# lib-ui.sh launches it; lib-boot.sh reports whether it is installed.
	lib-ui.sh | lib-boot.sh) ;;
	*) _assert_die "$f knows where the soft path lives - only bin/lib-ui.sh may" ;;
	esac
done <<<"$leaks"

# bin/ holds three prefixes and no others, and the prompt code is not one of
# them: human-only code lives under ui/ so agents never mistake it for a
# primitive (architecture.md §3).
assert_file_missing "$YAN_REPO_ROOT/bin/ui"
for f in "$YAN_REPO_ROOT"/bin/*; do
	name=${f##*/}
	case $name in
	yan | yan-*.sh | lib-*.sh | hook-*.sh) ;;
	*) _assert_die "bin/$name is not a subcommand, a library or a hook" ;;
	esac
done

# --- 3. the soft path never reaches back down -------------------------------
#
# It collects answers and runs `yan`. It does not source a library, does not
# run git or the forge or the terminal itself, and writes nothing: every
# irreversible step stays in the scripts (cli-ux.md §2).

ui_src=$(cat "$YAN_REPO_ROOT/ui/soft-path.mjs" "$YAN_REPO_ROOT/ui/lib/plan.mjs")
for forbidden in 'bin/lib' "'git'" "'gh'" "'glab'" "'tmux'" 'writeFileSync' 'appendFileSync' 'mkdirSync'; do
	assert_not_contains "$ui_src" "$forbidden" \
		'ui/ collects answers and runs yan; it never does the work itself'
done
assert_contains "$ui_src" 'spawnSync(SHELL, [YAN_BIN' \
	'the only thing the soft path may start is yan itself'

# The pinned install cli-ux.md §2 asks for.
pkg=$YAN_REPO_ROOT/ui/package.json
assert_file_exists "$pkg"
assert_ok jq empty "$pkg"
pin=$(jq -r '.dependencies["@clack/prompts"]' "$pkg")
assert_ne 'null' "$pin" '@clack/prompts has to be there'
case $pin in
[0-9]*.[0-9]*.[0-9]*) ;;
*) _assert_die "@clack/prompts must be pinned to an exact version, not '$pin'" ;;
esac

# --- 4. and at runtime, nothing an agent runs starts node -------------------

home=$tmp/home
mk_yan_home "$home"
cp "$YAN_REPO_ROOT/tests/stub/lib-term.sh" "$home/bin/lib-term.sh"
cp "$YAN_REPO_ROOT/tests/stub/lib-forge.sh" "$home/bin/lib-forge.sh"
export YAN_HOME=$home
export YAN_STUB_TERM_DIR=$tmp/calls
yan=$home/bin/yan
mkdir -p "$home/repos/monorepo-x"

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
task_init t042 'unify the auth header'
task_unit_add t042 auth monorepo-x master --branch feat/auth --scope apps/auth

mkdir -p "$tmp/bin"
cat >"$tmp/bin/node" <<'EOF'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >>"${NODE_RECORD:?}"
exit 0
EOF
chmod +x "$tmp/bin/node"
export NODE_RECORD=$tmp/node.log
: >"$NODE_RECORD"
PATH=$tmp/bin:$PATH
export PATH

# Everything here is something the model runs in an ordinary session. Some of
# them refuse - a refusal is a perfectly good sample, because the question is
# only ever "did node start".
run_quiet() { capture env bash "$yan" "$@" <"/dev/null"; }
run_quiet --help
run_quiet ls
run_quiet ls t042
run_quiet ls t042 --json
run_quiet continue --task t042
run_quiet state s1
run_quiet land --task t042 --user-asked
run_quiet mr --task t042 --unit auth
run_quiet unit set --task t042 --unit auth

assert_eq '' "$(cat "$NODE_RECORD")" \
	'not one command an agent runs may start node (architecture.md §2)'

# The positive control: `yan doctor` DOES ask node for its version, which is
# how we know the recorder would have caught anything else.
run_quiet doctor
assert_contains "$(cat "$NODE_RECORD")" 'node --version' \
	'the recorder works - doctor is the one command that reports on node'

printf 'ok\n'
