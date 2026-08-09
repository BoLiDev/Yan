#!/usr/bin/env bash
#
# yan shift new - dispatch a shift (td agents.md §5.3, architecture.md §5.2).
#
#   sync the integration branch
#     -> lease a tree, cutting the shift branch
#       -> write shifts/<sid>/brief.md
#         -> ASSERT the sub-agent's working directory is not the main clone
#           -> start the terminal with agents.shift (or --agent)
#             -> write run/meta.json
#
# THE ASSERTION IS THE POINT OF THIS FILE. td worktree.md §7 states it as an
# invariant of the pool: *when spawning a sub-agent, assert that its working
# directory is not the main clone's path, and refuse to start otherwise.* A
# main clone under repos/ is read-only to yan except for `git fetch`
# (boundaries.md §9.1); an agent started there would edit, commit and push the
# one checkout every worktree in the pool is cut from. It is also the failure
# that hides: everything looks like it worked. So the check runs before the
# terminal, it refuses rather than warns, and it gives the tree back on its way
# out. architecture.md §7 lists it as one of the four ordering regressions.
#
# SYNC RUNS FIRST, and it runs as `yan sync` rather than as a copy of its
# steps. Its timing is fixed - before every new shift (td branching.md §6.3) -
# so that the shift branch comes off a head that has just caught up and
# conflicts stay in one place. Two of its exit codes are passed straight
# through, because they say something this command cannot improve on: 3 the
# pool is full, so no new shift can start at all, and 5 the integration branch
# conflicts with target and a shift has to reconcile it first.
#
# THE SHIFT BRANCH NAME IS ALWAYS OURS: yan/<task>-<unit>-<sid>
# (td branching.md §6.5). It is never derived from the integration branch's
# name - git itself forbids `feature/X` and `feature/X/s1` coexisting, branch
# protection rules would catch the rest, and colleagues should never see our
# internal branches. It carries no round number either: sid increases and
# cannot collide across rounds.
#
# WHERE ARTIFACTS GO. YAN_TASK_DIR points at tasks/<id>, outside the worktree,
# because the tree is wiped by `yan tree return`: a prototype written inside it
# is either destroyed or accidentally committed into a work repository
# (td memory.md §4.3).
#
# Exit codes: 0 fine, 2 you called this wrongly, 3 the pool is full, 4 the
# working-directory assertion refused, 5 sync hit a conflict, 1 anything else.
#
set -euo pipefail

: "${YAN_HOME:?yan-shift-new: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-shift.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-shift.sh"
# shellcheck source=bin/lib-pool.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-pool.sh"
# shellcheck source=bin/lib-term.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-term.sh"
# shellcheck source=bin/lib-json.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-json.sh"
# shellcheck source=bin/lib-boot.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-boot.sh"

RC_POOL_FULL=3
RC_MAIN_CLONE=4
RC_CONFLICT=5

die() {
	printf 'yan shift new: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan shift new --task <id> --unit <name>
                     [--sid <sid>] [--agent <cli>]
                     [--brief <file> | --brief-text <text>] [--json]

Syncs the unit's integration branch, leases a tree with the shift branch cut
in it, writes shifts/<sid>/brief.md, and starts the shift agent in the task's
terminal container.

  --task    the task; defaults to $YAN_TASK
  --unit    which unit of that task this shift works on
  --sid     the shift id; derived as the next free s<n> when omitted
  --agent   override agents.shift from conf/config.json for this dispatch
  --brief   a file whose contents become the body of the work order
  --json    print the dispatch record instead of a summary

The shift branch is always yan/<task>-<unit>-<sid> and is never derived from
the integration branch's name (branching.md §6.5).

Exit codes: 3 the pool is full, 4 the working directory would have been the
main clone and the dispatch was refused, 5 the integration branch conflicts
with its target and a shift has to reconcile it first.
EOF
}

# --- arguments --------------------------------------------------------------

task=${YAN_TASK:-}
unit=
sid=
agent=
brief_file=
brief_text=
as_json=0

need_value() { # need_value <flag> <remaining-argument-count>
	if [ "$2" -lt 2 ]; then
		die "$1 needs a value" 2
	fi
}

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--task)
		need_value "$1" "$#"
		shift
		task=$1
		;;
	--unit)
		need_value "$1" "$#"
		shift
		unit=$1
		;;
	--sid)
		need_value "$1" "$#"
		shift
		sid=$1
		;;
	--agent)
		need_value "$1" "$#"
		shift
		agent=$1
		;;
	--brief)
		need_value "$1" "$#"
		shift
		brief_file=$1
		;;
	--brief-text)
		need_value "$1" "$#"
		shift
		brief_text=$1
		;;
	--json)
		as_json=1
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		usage >&2
		die "unexpected argument: $1 - pass --task and --unit" 2
		;;
	esac
	shift
done

[ -n "$task" ] || die "--task is required (or set YAN_TASK)" 2
[ -n "$unit" ] || die "--unit is required - a shift always works on one unit of a task" 2
if [ -n "$brief_file" ] && [ -n "$brief_text" ]; then
	die "--brief and --brief-text are alternatives - pass one" 2
fi
if [ -n "$brief_file" ] && [ ! -f "$brief_file" ]; then
	die "no such brief file: $brief_file" 2
fi

task_exists "$task" || die "no such task: $task" 2
task_unit_json "$task" "$unit" >/dev/null || die "no such unit: $unit in task $task" 2

repo=$(task_unit_get "$task" "$unit" repo)
base=$(task_unit_get "$task" "$unit" branch)
target=$(task_unit_get "$task" "$unit" target)
mode=$(task_unit_get "$task" "$unit" mode)

[ -n "$base" ] || die "unit $unit has no integration branch yet - 'yan unit add' or 'yan unit set --branch' sets one" 2

scope=()
while IFS= read -r line; do
	[ -n "$line" ] || continue
	scope+=("$line")
done < <(task_unit_scope "$task" "$unit")

# --- where the repository is ------------------------------------------------

repo_dir() { # repo_dir <name-or-path>
	local r=$1
	if [ -d "$YAN_HOME/repos/$r" ]; then
		(cd -P "$YAN_HOME/repos/$r" >/dev/null 2>&1 && pwd)
		return 0
	fi
	if [ -d "$r" ]; then
		(cd -P "$r" >/dev/null 2>&1 && pwd)
		return 0
	fi
	die "unknown repository: $r - the unit names it, but there is no clone under repos/" 2
}

# pool_size follows the repository (td Appendix D). The seam must not read
# mem/repos.json - that is yan's own bookkeeping - so the subcommand reads it
# and passes it in, exactly as `yan tree` and `yan sync` do.
pool_size() { # pool_size <repo-key>
	local key=$1 file=$YAN_HOME/mem/repos.json v=
	if [ -f "$file" ]; then
		v=$(jq -r --arg r "$key" '.[$r].pool_size // empty' "$file" 2>/dev/null) || v=
		v=${v//$'\r'/}
	fi
	case ${v:-} in
	'' | *[!0-9]* | 0) v=8 ;;
	esac
	printf '%s\n' "$v"
}

clone=$(repo_dir "$repo")
size=$(pool_size "${clone##*/}")

# meta_jq <args...> - jq for building run/meta.json, and nothing else.
#
# conventions §2.4 from the other side, and this one is quiet: when MSYS2
# launches a NATIVE program it rewrites arguments that look like POSIX paths,
# so `jq --arg tree /tmp/x` silently records C:/Users/.../Temp/x. The pool
# hands out the shell's own spelling on both runtimes and lib-pool goes to some
# trouble to keep it that way; recording a different spelling here would undo
# that for every later reader. The variables are ignored on Linux. Only used
# for `jq -n`, never with a file argument, which would then be a POSIX path
# jq.exe could not open.
meta_jq() {
	MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 jq "$@"
}

# --- comparable paths -------------------------------------------------------
#
# conventions §2.4: on Git Bash the shell says /tmp/x and a native tool says
# C:/Users/.../Temp/x for the same directory. The assertion below compares a
# path the pool printed with a path this script built, so both go through the
# same normalisation first, and case is folded on Windows only - two spellings
# that differ in case are the same directory there and are not on Linux.
path_key() {
	local p=${1-}
	if command -v cygpath >/dev/null 2>&1; then
		p=$(cygpath -m -- "$p" 2>/dev/null || printf '%s' "${1-}")
		while [ -n "$p" ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done
		printf '%s\n' "$p" | tr '[:upper:]' '[:lower:]'
	else
		while [ -n "$p" ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done
		printf '%s\n' "$p"
	fi
}

# --- which shift is this ----------------------------------------------------
#
# sid is derived by scanning shifts/, never stored in a counter file: the
# directory IS the registry (design principle 1). It increases and carries no
# round number, so the second round's s7 cannot collide with the first round's
# s3 (td branching.md §6.5).
next_sid() {
	local dir d n max=0
	dir=$(task_dir "$task")/shifts
	while IFS= read -r n; do
		n=${n##*/}
		n=${n#s}
		case $n in
		'' | *[!0-9]*) continue ;;
		esac
		if [ "$n" -gt "$max" ]; then
			max=$n
		fi
	done < <(
		shopt -s nullglob
		for d in "$dir"/s[0-9]*; do
			[ -d "$d" ] && printf '%s\n' "$d"
		done
	)
	printf 's%s\n' "$((max + 1))"
}

if [ -z "$sid" ]; then
	sid=$(next_sid)
fi
shift_id_ok "$sid" || exit $?
shift_use "$task" "$sid" || exit $?
if [ -d "$SHIFT_DIR" ]; then
	die "shift $sid already exists in task $task - $SHIFT_DIR is there already" 2
fi

branch=yan/$task-$unit-$sid
holder=$task/$unit/$sid

# --- 1. sync ----------------------------------------------------------------
#
# As a subcommand, not as a second copy of its steps: sync leases a tree of its
# own, fetches, merges target, pushes and gives the tree back, and none of that
# belongs in two files.

sync_rc=0
"$YAN_HOME/bin/yan" sync --task "$task" --unit "$unit" || sync_rc=$?
case $sync_rc in
0) ;;
"$RC_POOL_FULL")
	die "the pool is full, cannot start a new shift - a shift has to finish before another can start" "$RC_POOL_FULL"
	;;
"$RC_CONFLICT")
	die "$base conflicts with $target - dispatch a shift to reconcile them before starting new work" "$RC_CONFLICT"
	;;
*)
	die "cannot sync $base before dispatching - see the message above"
	;;
esac

# --- 2. lease a tree, cutting the shift branch ------------------------------

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

rc=0
lease_json=$(pool_get "$clone" "$size" "$base" "$branch" "$holder" 2>"$tmpdir/pool.err") || rc=$?
pool_err=$(cat "$tmpdir/pool.err" 2>/dev/null || true)
if [ "$rc" -ne 0 ]; then
	# Same wording, same exit code as the sync path: a full pool is not a
	# dispatch failure to go looking for, it is the pool saying wait.
	case $pool_err in
	*"pool is full"*)
		printf '%s\n' "$pool_err" >&2
		die "the pool is full, cannot start a new shift - 'yan tree status --repo $repo' shows who holds the trees" "$RC_POOL_FULL"
		;;
	esac
	printf '%s\n' "$pool_err" >&2
	die "could not lease a tree for $branch"
fi

tree=$(printf '%s' "$lease_json" | jq -r '.path' | tr -d '\r')
lease_id=$(printf '%s' "$lease_json" | jq -r '.lease_id' | tr -d '\r')
[ -n "$tree" ] && [ -d "$tree" ] || die "the pool returned a path that is not a directory: ${tree:-<empty>}"

leased=1
started=0
undo() {
	local saved=$?
	if [ "$leased" -eq 1 ] && [ "$started" -eq 0 ]; then
		# Nothing has run in this tree, so there is nothing to lose. The lease
		# id is carried across so the return is refused rather than destructive
		# if somebody else already holds the slot.
		pool_return "$clone" "$tree" "$lease_id" "$holder" >/dev/null 2>&1 ||
			printf 'yan shift new: the tree at %s could not be returned - '"'"'yan tree status --repo %s'"'"' shows the lease\n' "$tree" "$repo" >&2
		rm -rf -- "$SHIFT_DIR"
	fi
	rm -rf "$tmpdir"
	exit "$saved"
}
trap undo EXIT

# --- 3. write the work order ------------------------------------------------

mkdir -p -- "$SHIFT_DIR" || die "cannot create $SHIFT_DIR"
task_dir_abs=$(task_dir "$task")
mkdir -p -- "$task_dir_abs/artifacts" || true

{
	printf '# %s %s (task %s)\n\n' "$sid" "$unit" "$task"
	printf '| | |\n| --- | --- |\n'
	printf '| unit | %s |\n' "$unit"
	printf '| repo | %s |\n' "$repo"
	printf '| worktree | %s |\n' "$tree"
	printf '| shift branch | %s |\n' "$branch"
	printf '| integration branch | %s |\n' "$base"
	printf '| mode | %s |\n' "$mode"
	if [ "${#scope[@]}" -gt 0 ]; then
		printf '| scope | %s |\n' "${scope[*]}"
	else
		printf '| scope | (the whole repository) |\n'
	fi
	printf '\n## The work\n\n'
	if [ -n "$brief_file" ]; then
		cat -- "$brief_file"
		printf '\n'
	elif [ -n "$brief_text" ]; then
		printf '%s\n' "$brief_text"
	else
		printf '(no work order was supplied - ask yan before changing anything)\n'
	fi
	printf '\n## How this shift works\n\n'
	printf -- '- Work only inside %s. Never touch %s: it is the main clone.\n' "$tree" "$clone"
	printf -- '- You are on %s, which was cut from %s. Push it and open a merge request into %s.\n' "$branch" "$base" "$base"
	printf -- '- Run the project'"'"'s install step first, every time. The tree may be warm from an\n'
	printf -- '  earlier shift, in which case it finishes in seconds with nothing to do.\n'
	printf -- '- Artifacts - prototypes, notes, screenshots, data - go in $YAN_TASK_DIR/artifacts\n'
	printf -- '  (%s/artifacts), NEVER inside the worktree: the tree is wiped when it is\n' "$task_dir_abs"
	printf -- '  returned, so anything left in it is destroyed or accidentally committed.\n'
	printf -- '- Report only when yan has to act:\n'
	printf -- '      %s/bin/yan report <started|done|blocked|needs-decision|conflict> "<one line>"\n' "$YAN_HOME"
	printf -- '- Check your own diff against the scope before landing: %s/bin/yan scope-check %s\n' "$YAN_HOME" "$sid"
	if [ "$mode" = scout ]; then
		printf -- '- mode is scout: investigate and write it up. Do not push and do not open a merge request.\n'
	fi
	printf -- '- Do not talk to other shifts, and do not talk to user. Everything goes through yan.\n'
} >"$SHIFT_DIR/brief.md" || die "cannot write $SHIFT_DIR/brief.md"

# --- 4. the assertion -------------------------------------------------------
#
# The sub-agent's working directory is the main scope path inside the leased
# tree (delivery.md §8.3). It must not be the main clone, and must not be
# anywhere inside it.

workdir=$tree
add_dirs=()
if [ "${#scope[@]}" -gt 0 ]; then
	if [ -d "$tree/${scope[0]}" ]; then
		workdir=$tree/${scope[0]}
	fi
	for ((i = 1; i < ${#scope[@]}; i++)); do
		if [ -d "$tree/${scope[i]}" ]; then
			add_dirs+=("$tree/${scope[i]}")
		fi
	done
fi

clone_key=$(path_key "$clone")
work_key=$(path_key "$workdir")
tree_key=$(path_key "$tree")
case $work_key in
"$clone_key" | "$clone_key"/*)
	printf 'yan shift new: the sub-agent would have started in %s\n' "$workdir" >&2
	printf 'yan shift new: that is the main clone (%s), which yan only ever fetches into\n' "$clone" >&2
	die "refusing to start a shift in the main clone - a shift works only in a leased worktree (worktree.md §7). The tree has been returned; check the pool's configuration before retrying" "$RC_MAIN_CLONE"
	;;
esac
case $tree_key in
"$clone_key" | "$clone_key"/*)
	die "refusing to start a shift: the pool handed out $tree, which is inside the main clone $clone" "$RC_MAIN_CLONE"
	;;
esac

# --- 5. start the agent -----------------------------------------------------

if [ -z "$agent" ]; then
	agent=$(boot_config_get '.agents.shift' '')
	agent=${agent//$'\r'/}
fi
[ -n "$agent" ] || die "no shift agent configured - set agents.shift in $(boot_config_path), or pass --agent" 2

# The harness mapping table (delivery.md §8.3 asks for a small table here and
# says in as many words not to build an abstraction layer for it). Four
# columns: how this harness is given an extra directory, how it is made
# read-only for a scout, HOW IT IS MADE TO RUN UNATTENDED, and whether it takes
# its opening prompt as an argument. The working directory is not in the table
# because the terminal sets it (term_agent_start -c).
#
# ---------------------------------------------------------------------------
# WHY THE UNATTENDED COLUMN EXISTS
# ---------------------------------------------------------------------------
# A shift runs for hours in a pane with nobody watching it (td §5.5). A harness
# that asks permission before each tool use does not "run slowly" in that
# setting - it stops on its first command and waits forever. Observed against a
# real dispatch: the agent read its brief, went to run one `ls`, and parked on
#
#   Do you want to proceed?  > 1. Yes  2. Yes, allow ...  3. No
#
# Nothing downstream can recover from that on its own: supervision would
# eventually notice the pane has stopped changing and call it stuck, which is
# correct but useless - every shift would need a human for its first command.
#
# Granting the permission up front is consistent with how this design draws its
# safety boundary, and does not weaken it. delivery.md §8.3 already refuses to
# use an isolation mechanism for enforcement: the agent's world is its working
# directory plus --add-dir, the tree is a disposable lease that gets reset and
# cleaned when it is returned (worktree.md), the shift branch is its own, and
# "branch protection on the forge is the real last line of defence". The thing
# being skipped is a prompt, not a boundary.
#
# scout is the exception and keeps its read-only mode: its whole contract is
# that it does not change code (§8.2), so it must not be handed a free hand.
#
# ONE PROMPT THIS DOES NOT REMOVE. Claude Code also asks, once per directory it
# has never seen, whether the workspace is trusted; that dialog is only skipped
# in non-interactive mode, and a shift is interactive by definition. Because the
# pool hands out a fixed set of stable paths, it appears at most once per pool
# slot per machine and never again. It is not silently fatal either: an agent
# parked on a dialog stops changing its pane, which is exactly the third source
# `yan wait` watches - supervision.md names "waiting on a dialog" as one of the
# things that source is for - so `yan` is woken, reads the pane, and can answer
# with `yan send`. Verified end to end against a real dispatch.
agent_args=()
case ${agent##*/} in
claude | claude.exe)
	for d in ${add_dirs[@]+"${add_dirs[@]}"}; do
		agent_args+=(--add-dir "$d")
	done
	if [ "$mode" = scout ]; then
		agent_args+=(--permission-mode plan)
	else
		agent_args+=(--dangerously-skip-permissions)
	fi
	;;
codex | codex.exe)
	if [ "$mode" = scout ]; then
		agent_args+=(--sandbox read-only)
	else
		# UNVERIFIED: codex is not installed on this machine, so this flag comes
		# from its documentation and has never been run. Check it against
		# `codex --help` before trusting a Codex shift to run unattended.
		agent_args+=(--dangerously-bypass-approvals-and-sandbox)
	fi
	;;
*) ;;
esac

# td agents.md §5.6 requirement 1: a shift harness accepts an initial prompt at
# startup, so it can be told to read its brief. The path is spelled out rather
# than written as $YAN_SHIFT_DIR, because the pane's command is quoted for
# `sh -c` and nothing expands it.
prompt="Read $SHIFT_DIR/brief.md and do what it says. It is your whole work order."

label=$sid-$unit
container_name=$(task_container_name "$task")
container=$(term_container_create "$container_name") ||
	die "cannot create or find the terminal container for task $task"

# --- 6. run/meta.json -------------------------------------------------------
#
# Written BEFORE the agent is started, with the terminal ids filled in
# immediately afterwards. The other order would leave a running agent with no
# record of it if the write failed, and a running agent nothing has recorded is
# the one thing yan cannot rebuild its picture from (td agents.md §5.1).
#
# ---------------------------------------------------------------------------
# THE SHAPE OF run/meta.json
# ---------------------------------------------------------------------------
# td INDEX.md §3 calls it "tree path / terminal id / shift branch name / agent
# CLI". This is that, spelled out. Phase 1's `yan ls` reads unit / branch /
# tree / agent, and those four keep their names for good.
#
#   version    1
#   task sid   which shift this is; the directory says so too, and a file that
#              cannot say what it describes is a file nobody can debug
#   unit repo  which unit of the task, and the repository it belongs to
#   branch     THE SHIFT BRANCH, yan/<task>-<unit>-<sid>
#   base       the integration branch it was cut from
#   tree       the leased worktree's absolute path
#   clone      the main clone the tree was cut from. `yan shift done` needs it
#              to give the tree back and to delete the remote branch, and by
#              then task.json may name a different repository
#   workdir    where the agent was actually started - tree plus the main scope
#              path. Kept because it is what the working-directory assertion
#              passed on, and a later reader should see the same thing
#   holder     the pool holder string, <task>/<unit>/<sid>
#   lease_id   the pool lease id. THIS is what makes returning the tree safe on
#              a retry: `--if-lease-id` compares it while the lock is held and
#              refuses before anything destructive happens (worktree.md §7)
#   mode       scout | branch | mr, as it was when the shift was dispatched
#   agent      the agent CLI that was actually started (td §5.6)
#   container  the terminal container id ($0 under tmux)
#   window     the agent's window id (@3)
#   pane       the agent's pane id (%7). Ids, never labels: tmux does not
#              promise labels are unique (td §5.7 practice 1)
#   mr         the shift branch's merge request once one is known; empty at
#              spawn, because it does not exist yet
#   at         when the shift was dispatched, UTC
#
# Every reader goes through lib-shift, which reads it defensively: a missing
# key costs one fact and never a crash.
mkdir -p -- "$SHIFT_RUN" || die "cannot create $SHIFT_RUN"
meta=$(meta_jq -nc \
	--arg task "$task" --arg sid "$sid" --arg unit "$unit" --arg repo "$repo" \
	--arg branch "$branch" --arg base "$base" --arg tree "$tree" \
	--arg clone "$clone" --arg holder "$holder" --arg lease_id "$lease_id" \
	--arg agent "$agent" --arg container "$container" \
	--arg workdir "$workdir" --arg mode "$mode" \
	--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	'{version: 1, task: $task, sid: $sid, unit: $unit, repo: $repo,
	  branch: $branch, base: $base, tree: $tree, clone: $clone, workdir: $workdir,
	  holder: $holder, lease_id: $lease_id, mode: $mode,
	  agent: $agent, container: $container, window: "", pane: "",
	  mr: "", at: $at}')
json_write "$(shift_meta_file)" "$meta" || die "cannot write $(shift_meta_file)"

ids=$(term_agent_start \
	-c "$workdir" \
	-e "YAN_HOME=$YAN_HOME" \
	-e "YAN_TASK=$task" \
	-e "YAN_TASK_DIR=$task_dir_abs" \
	-e "YAN_SID=$sid" \
	-e "YAN_SHIFT_DIR=$SHIFT_DIR" \
	"$container" "$label" "$agent" ${agent_args[@]+"${agent_args[@]}"} "$prompt") ||
	die "cannot start '$agent' for shift $sid in container $container"
started=1

window=${ids%% *}
pane=${ids##* }

json_edit "$(shift_meta_file)" '.window = $w | .pane = $p' \
	--arg w "$window" --arg p "$pane" ||
	die "the agent started but its terminal ids could not be recorded in $(shift_meta_file)"

log_append "$task" "$sid $unit  dispatched on $branch ($agent in $workdir)" || true

# --- report -----------------------------------------------------------------

if [ "$as_json" -eq 1 ]; then
	cat -- "$(shift_meta_file)"
else
	printf '%s  %s\n' "$sid" "$unit"
	printf 'branch   %s (from %s)\n' "$branch" "$base"
	printf 'tree     %s\n' "$tree"
	printf 'workdir  %s\n' "$workdir"
	printf 'agent    %s  (%s %s in container %s)\n' "$agent" "$window" "$pane" "$container"
	printf 'brief    %s\n' "$SHIFT_DIR/brief.md"
fi
