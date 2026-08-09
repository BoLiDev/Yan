#!/usr/bin/env bash
#
# yan continue [<id>] - create or attach a task's terminal container and start
# yan inside it (td agents.md §5.2 / §5.7, cli-ux.md §4, architecture.md §5.2).
#
# This is the enter step, and the only one: `yan task new` ends by doing the
# same thing for a task it has just created, and there is no `yan start` in the
# inventory any more.
#
# ---------------------------------------------------------------------------
# ONE YAN PER TASK
# ---------------------------------------------------------------------------
#
# td §5.2 states the rule and its exact shape: *the lock is per task, not per
# home directory. Running two yan instances for two different tasks is fine.
# Only a second yan on the same task is refused.* The reason is context budget:
# a task-scoped yan sees one task's files and nothing else, and two of them on
# one task would both be writing that task's bookkeeping.
#
# It is enforced twice, because the two failures are different:
#
#   the race    two `yan continue` calls at the same instant would each look,
#               see nothing, and each start an agent. lib-lock's directory lock
#               closes that window (conventions §2.2: mkdir is the atomic
#               primitive on both runtimes, and there is no flock on Git Bash).
#               It is held for the enter step only - a lock cannot express "an
#               agent is running", because the process holding it exits long
#               before the agent does.
#
#   the answer  whether a yan is already running is asked of the terminal, not
#               of a file. yan keeps no durable state of its own (td §5.1), so
#               the live inventory IS the record: term_list reports the agents
#               in this container, by id.
#
# When one is already alive we attach rather than spawn a duplicate
# (cli-ux.md §4) - attaching is what user meant, and a second agent is what
# they did not.
#
# THE SOFT PATH. With no id and a person at the keyboard, this selects among
# the INCOMPLETE tasks with a Clack prompt (cli-ux.md §4) - the list comes from
# `yan ls --json`, and the selection comes straight back as
# `yan continue --task <id>`. Without a TTY there is nobody to answer, so it
# refuses and names the flag to pass (cli-ux.md §1). That order matters: a
# prompt reached by a hook, a script or an agent is a hang, not a question.
#
# Exit codes: 0 fine (including "already running, attach instead"), 2 you
# called this wrongly, 1 anything else.
#
set -euo pipefail

: "${YAN_HOME:?yan-continue: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-term.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-term.sh"
# shellcheck source=bin/lib-lock.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-lock.sh"
# shellcheck source=bin/lib-boot.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-boot.sh"
# shellcheck source=bin/lib-ui.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-ui.sh"

# The label of yan's own window in the task container. Shifts are labelled
# <sid>-<unit>, so the two can never be confused. Nothing is LOCATED by this
# name - term_list answers with ids and this only says which of our own windows
# is which (td §5.7 practice 1).
YAN_AGENT_LABEL=yan

die() {
	printf 'yan continue: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan continue <task-id> [--agent <cli>] [--json]
       yan continue --task <task-id> [--agent <cli>] [--json]

Creates or attaches the task's terminal container and starts yan in it with
agents.yan from conf/config.json.

  --agent  override agents.yan for this run
  --json   print what happened instead of a summary

A second yan on the same task is refused: when one is already running this
attaches to it rather than spawning a duplicate.

With no id and a terminal, this asks which of the incomplete tasks to open.
Without a terminal it refuses: pass --task <id>.
EOF
}

id=
agent=
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
		id=$1
		;;
	--agent)
		need_value "$1" "$#"
		shift
		agent=$1
		;;
	--json)
		as_json=1
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		if [ -n "$id" ]; then
			usage >&2
			die "only one task id may be given" 2
		fi
		id=$1
		;;
	esac
	shift
done

if [ -z "$id" ]; then
	# Soft path: a person, a terminal, and a missing value (cli-ux.md §1).
	# ui_run replaces this process, so nothing after it runs on that path.
	if ui_soft_path_wanted; then
		soft=(continue)
		[ -n "$agent" ] && soft+=(--agent "$agent")
		ui_run "${soft[@]}"
		die "the interactive prompts could not be started"
	fi

	why=$(ui_why_unavailable)
	if ui_is_tty && [ -n "$why" ]; then
		printf 'yan continue: the interactive path is unavailable: %s\n' "$why" >&2
	fi
	usage >&2
	die "which task? pass 'yan continue <id>' or 'yan continue --task <id>'. Choosing from the incomplete tasks interactively needs a terminal; 'yan ls' lists them" 2
fi

task_exists "$id" || die "no such task: $id - 'yan ls' lists the tasks in $YAN_HOME/tasks" 2

if [ -z "$agent" ]; then
	agent=$(boot_config_get '.agents.yan' '')
	agent=${agent//$'\r'/}
fi
[ -n "$agent" ] || die "no main agent configured - set agents.yan in $(boot_config_path), or pass --agent" 2

# --- the directories this task's yan may see --------------------------------
#
# The working directory is $YAN_HOME, because yan runs things in bin/ and reads
# mem/. Each extra directory is a clone this task actually touches; anything
# not listed is invisible to it (td §5.2).
add_dirs=()
seen=' '
while IFS= read -r u; do
	[ -n "$u" ] || continue
	repo=$(task_unit_get "$id" "$u" repo 2>/dev/null) || continue
	[ -n "$repo" ] || continue
	case $seen in
	*" $repo "*) continue ;;
	esac
	seen="$seen$repo "
	if [ -d "$YAN_HOME/repos/$repo" ]; then
		add_dirs+=("$YAN_HOME/repos/$repo")
	fi
done < <(task_unit_names "$id")

# The harness mapping table (delivery.md §8.3: a small table, not an
# abstraction layer). yan itself runs on Claude Code or Codex and nothing else
# (td §5.6), so it has exactly two rows.
agent_args=()
case ${agent##*/} in
claude | claude.exe)
	for d in ${add_dirs[@]+"${add_dirs[@]}"}; do
		agent_args+=(--add-dir "$d")
	done
	;;
codex | codex.exe) ;;
*) ;;
esac

container_name=$(task_container_name "$id")

# --- the enter step, under the per-task lock --------------------------------

started=false
attached=false
container=
window=
pane=

enter() {
	local wid p label verdict rc=0

	container=$(term_container_create "$container_name") || return 1

	# Is a yan already running here? Ask the terminal - there is no file that
	# knows, and there must not be one. `|| [ -n "$wid" ]` because a backend
	# that prints its last row without a trailing newline would otherwise have
	# that row silently dropped.
	while IFS=$'\t' read -r wid p label || [ -n "$wid" ]; do
		[ -n "$wid" ] || continue
		if [ "$label" = "$YAN_AGENT_LABEL" ]; then
			window=$wid
			pane=$p
			break
		fi
	done < <(term_list "$container" || true)

	if [ -n "$window" ]; then
		# ONE argument, never two. term_agent_alive's optional expected-command
		# argument cannot mean the same thing on both runtimes: on Windows every
		# agent runs under winpty, so the pane's command is always `winpty` and
		# naming the CLI there could only ever turn `alive` into `unknown`
		# (lib-term, conventions §2.1).
		verdict=$(term_agent_alive "$pane") || rc=$?
		if [ "$rc" -ne 0 ]; then
			printf 'yan continue: cannot ask the terminal about %s\n' "$pane" >&2
			return 1
		fi
		case $verdict in
		alive)
			attached=true
			return 0
			;;
		unknown)
			printf 'yan continue: there is a window labelled %s in container %s and the terminal cannot say whether it is alive\n' "$YAN_AGENT_LABEL" "$container" >&2
			printf 'yan continue: refusing to start a second yan on task %s - attach with: tmux attach -t %s\n' "$id" "$pane" >&2
			return 1
			;;
		esac
		# dead: the pane is still there with its scrollback. Close exactly that
		# one window and start again - this is the restart path.
		term_agent_close "$window" >/dev/null 2>&1 || true
		window=
		pane=
	fi

	local ids
	ids=$(term_agent_start \
		-c "$YAN_HOME" \
		-e "YAN_HOME=$YAN_HOME" \
		-e "YAN_TASK=$id" \
		"$container" "$YAN_AGENT_LABEL" "$agent" ${agent_args[@]+"${agent_args[@]}"}) || return 1
	window=${ids%% *}
	pane=${ids##* }
	started=true
}

lockdir=$(task_dir "$id")/.enter.lock
rc=0
with_lock "$lockdir" "${YAN_ENTER_LOCK_TIMEOUT:-30}" enter || rc=$?
if [ "$rc" -ne 0 ]; then
	die "could not enter task $id (see the message above)" "$rc"
fi

# --- report -----------------------------------------------------------------

if [ "$as_json" -eq 1 ]; then
	jq -nc --arg task "$id" --arg agent "$agent" --arg container "$container" \
		--arg window "$window" --arg pane "$pane" --arg name "$container_name" \
		--argjson started "$started" --argjson attached "$attached" \
		'{version: 1, task: $task, agent: $agent, container: $container,
		  container_name: $name, window: $window, pane: $pane,
		  started: $started, attached: $attached}'
	exit 0
fi

if [ "$attached" = true ]; then
	printf 'yan is already running on task %s - a second yan on the same task is refused\n' "$id"
	printf 'attach   tmux attach -t %s\n' "$container"
	printf 'agent    %s %s in container %s\n' "$window" "$pane" "$container"
else
	printf 'task %s\n' "$id"
	printf 'agent    %s started (%s %s)\n' "$agent" "$window" "$pane"
	printf 'attach   tmux attach -t %s\n' "$container"
fi
