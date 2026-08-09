#!/usr/bin/env bash
#
# The Phase 7 spine end to end, against a real tmux server, the real worktree
# pool and real git: `yan continue` -> `yan shift new` -> `yan session-start`
# -> `yan shift done`.
#
# Only the forge is a stand-in - whether a merge request merged cannot be asked
# of a local bare repository - and nothing here touches the network.
#
# Every session this file creates carries a name unique to the run and is
# killed by the trap, so a failure half way through leaves nothing behind. The
# trap uses tmux directly on purpose: lib-term has no way to close a container,
# and that is exactly the point (td §5.7).
#
# The agents are stand-ins that simply stay alive. That is enough: this file is
# about the wiring - the container, the working directory, the environment the
# pane inherits, the ids recorded in run/meta.json - and on Windows it also
# exercises the winpty path, without which a real CLI would see no TTY and exit
# before printing anything (conventions §2.1). Which stand-in can be used is
# itself platform-dependent; the note beside mk_config says why.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

if ! command -v tmux >/dev/null 2>&1; then
	printf 'SKIP  tmux is not on PATH\n'
	exit 0
fi
case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS* | CYGWIN*)
	if ! command -v winpty >/dev/null 2>&1; then
		printf 'SKIP  winpty is not on PATH, and on Windows an agent cannot be spawned without it\n'
		exit 0
	fi
	;;
esac

tmp=$(mktemp -d)
run_id="yan-p7-$$-${RANDOM}"
container="t042 $run_id"

cleanup() {
	tmux kill-session -t "=$container" >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT

home=$tmp/home
mk_yan_home "$home"
cp "$YAN_REPO_ROOT/tests/stub/lib-forge.sh" "$home/bin/lib-forge.sh"

export YAN_HOME=$home
export YAN_POOL_ROOT=$tmp/trees
export YAN_STUB_FORGE_DIR=$tmp/forge
yan=$home/bin/yan

# The stand-in agents.
#
# `cat` with no arguments blocks on its terminal, which is exactly what an
# agent CLI looks like from tmux's side, and it is a real executable on both
# runtimes - which matters, because on Windows the pane command goes through
# winpty and winpty can only start a Win32 application. A shell script with a
# shebang cannot be started that way at all:
#
#     winpty: error: cannot start '.../fake-agent': %1 is not a valid Win32
#     application. (error 0xc1)
#
# So the shift's agent is a script that prints its environment and sleeps only
# where a script can be spawned; on Windows the shift runs `cat` too and this
# file asserts the wiring - the container, the ids, the tree, the teardown -
# rather than what the agent printed. What reaches a pane through -e is proven
# against real tmux in tests/integration/lib-term.test.sh either way.
mk_config "$home" '{
  "version": 1,
  "agents": { "yan": "cat", "shift": "cat" },
  "forge": { "kind": "github" },
  "backend": "tmux"
}'

mkdir -p "$tmp/bin"
cat >"$tmp/bin/fake-agent" <<'EOF'
#!/usr/bin/env bash
printf 'FAKE AGENT ARGS: %s\n' "$*"
printf 'FAKE AGENT TASKDIR: %s\n' "${YAN_TASK_DIR:-<unset>}"
sleep 600
EOF
chmod +x "$tmp/bin/fake-agent"

shift_agent=()
readable_agent=1
case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS* | CYGWIN*) readable_agent=0 ;;
*) shift_agent=(--agent "$tmp/bin/fake-agent") ;;
esac

bare=$tmp/remote.git
mk_bare_remote "$bare"
clone=$home/repos/widget
mk_clone "$bare" "$clone"
fx_git -C "$clone" checkout -b feat/auth >/dev/null 2>&1
fx_git -C "$clone" push -u origin feat/auth >/dev/null 2>&1
fx_git -C "$clone" checkout main >/dev/null 2>&1

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"
# shellcheck source=bin/lib-term.sh
. "$YAN_REPO_ROOT/bin/lib-term.sh"

# The container name is derived from the task, so the title carries the run id
# and this file's sessions can never collide with a developer's own.
task_init t042 "$run_id"
task_unit_add t042 auth widget main --branch feat/auth --scope apps/auth
mkdir -p "$clone/apps/auth"

wait_until() { # wait_until <seconds> <command...>
	local budget=$1 waited=0
	shift
	while [ "$waited" -lt "$((budget * 10))" ]; do
		if "$@" >/dev/null 2>&1; then
			return 0
		fi
		sleep 0.1 2>/dev/null || sleep 1
		waited=$((waited + 1))
	done
	return 1
}

# Not `term_read | grep -q`: under pipefail the producer takes SIGPIPE when
# grep exits early and the whole pipeline is reported as failed (conventions).
pane_has() {
	case "$(term_read "$1" 200)" in
	*"$2"*) return 0 ;;
	*) return 1 ;;
	esac
}

# --- Trace 3: `yan continue --task <id>` creates the container and starts yan

capture bash "$yan" continue --task t042 --json
assert_eq 0 "$rc" "$out"
session=$(printf '%s' "$out" | jq -r .container)
yan_pane=$(printf '%s' "$out" | jq -r .pane)
assert_eq true "$(printf '%s' "$out" | jq -r .started)"
assert_ok tmux has-session -t "=$container"
assert_eq alive "$(term_agent_alive "$yan_pane")"
assert_eq 1 "$(term_list "$session" | grep -c .)" 'one agent: yan'

# --- Trace 4: a second yan on the same task is refused ----------------------

capture bash "$yan" continue --task t042 --json
assert_eq 0 "$rc" "$out"
assert_eq false "$(printf '%s' "$out" | jq -r .started)" 'no duplicate is spawned'
assert_eq true "$(printf '%s' "$out" | jq -r .attached)"
assert_eq "$yan_pane" "$(printf '%s' "$out" | jq -r .pane)" 'it is the same agent'
assert_eq 1 "$(term_list "$session" | grep -c .)" 'and still exactly one agent'

# --- Trace 1: `yan shift new` syncs, leases, briefs, then starts ------------

capture bash "$yan" shift new --task t042 --unit auth --brief-text 'parse the header' \
	${shift_agent[@]+"${shift_agent[@]}"}
assert_eq 0 "$rc" "$out"

meta=$home/tasks/t042/shifts/s1/run/meta.json
assert_file_exists "$meta"
tree=$(jq -r .tree "$meta")
pane=$(jq -r .pane "$meta")
workdir=$(jq -r .workdir "$meta")

assert_eq yan/t042-auth-s1 "$(jq -r .branch "$meta")"
assert_eq yan/t042-auth-s1 "$(fx_git -C "$tree" rev-parse --abbrev-ref HEAD)" \
	'leasing the tree cut the shift branch and left the tree on it, never detached'
assert_ne "$(native_path "$clone")" "$(native_path "$tree")" 'a shift never works in the main clone'
assert_contains "$(native_path "$workdir")" "$(native_path "$tree")" 'and its working directory is inside the leased tree'

assert_eq 2 "$(term_list "$session" | grep -c .)" 'the shift is a second agent in the SAME container'
assert_contains "$(term_list "$session")" 's1-auth'
case $pane in
%[0-9]*) ;;
*)
	printf 'run/meta.json must record a pane id, got: %s\n' "$pane" >&2
	exit 1
	;;
esac

if [ "$readable_agent" -eq 1 ]; then
	# The pane really inherited the environment: a pane inherits the tmux
	# SERVER's environment, not the caller's, so YAN_TASK_DIR only arrives via
	# -e - and it has to point outside the worktree, which the tree return
	# would wipe (memory.md §4.3).
	assert_eq alive "$(term_agent_alive "$pane")"
	assert_ok wait_until 60 pane_has "$pane" 'FAKE AGENT TASKDIR:'
	assert_contains "$(term_read "$pane" 200)" "tasks/t042" 'YAN_TASK_DIR reaches the agent'
	assert_contains "$(term_read "$pane" 200)" 'brief.md' 'and it was told to read its brief'
fi

# --- Trace 5: the rebuild sees all of it, and stores none of it -------------

snapshot() { find "$home" -type f -printf '%P %s\n' 2>/dev/null | LC_ALL=C sort; }
before=$(snapshot)

export YAN_STUB_FORGE_MR_STATES=open
capture bash "$yan" session-start --task t042
assert_eq 0 "$rc" "$out"
assert_contains "$out" 'shift s1'
assert_contains "$out" 'pool=leased'
if [ "$readable_agent" -eq 1 ]; then
	assert_contains "$out" 'terminal=alive'
fi
assert_eq "$before" "$(snapshot)" 'a rebuild writes nothing'

# --- Trace 2: clock out, in the order that survives a squash merge ----------

mk_commit "$tree" apps/auth/header.txt 'the header' 's1: parse the header'
fx_git -C "$tree" push -u origin yan/t042-auth-s1 >/dev/null 2>&1

MR=https://forge.invalid/acme/widget/-/merge_requests/31
rm -rf "$tmp/forge"
export YAN_STUB_FORGE_MR_STATES=merged
capture bash "$yan" shift "done" s1 --mr "$MR"
assert_eq 0 "$rc" "$out"

assert_file_missing "$home/tasks/t042/shifts/s1/run"
assert_file_exists "$home/tasks/t042/shifts/s1/outcome.md"
assert_eq '' "$(fx_git -C "$clone" ls-remote --heads origin refs/heads/yan/t042-auth-s1)" \
	'the merged shift branch is gone from origin'
assert_eq dead "$(term_agent_alive "$pane")" 'the shift agent window is closed'
assert_eq alive "$(term_agent_alive "$yan_pane")" 'and yan is untouched - a container outlives its agents'
assert_ok tmux has-session -t "=$container"

printf 'ok\n'
