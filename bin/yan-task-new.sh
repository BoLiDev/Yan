#!/usr/bin/env bash
#
# yan task new - the strong create path (td cli-ux.md §3, architecture.md §5.2).
#
# ---------------------------------------------------------------------------
# WHAT "STRONG" MEANS
# ---------------------------------------------------------------------------
#
# Create is not "mkdir plus an empty brief" (cli-ux.md §3). It is:
#
#   the contract          title and description, in brief.md
#   the involved repos    at least one, from mem/repos.json
#   a concrete scope      including monorepo packages when they were detected
#   at least one unit     with target, which is NEVER invented
#   and `user` inside it  the task's container, with agents.yan running
#
# THE LAST LINE IS THE ONE PEOPLE DROP. Create ends with `user` already inside
# the task; there is no separate start step, and there is no `yan start` in the
# inventory. That final step is not re-implemented here either - it is
# `yan continue --task <id>`, the one enter path, called as a subcommand
# (cli-ux.md §4). Two copies of "create or attach the container, refuse a
# second yan" would drift, and the second copy would be the one that forgets
# the lock.
#
# ---------------------------------------------------------------------------
# THE FLAG GRAMMAR IS ORDER SENSITIVE
# ---------------------------------------------------------------------------
#
# A task can involve several repositories, and each one can contribute several
# units, so the unit flags have to group somehow. They group by position:
#
#     --repo <name>              OPENS A UNIT
#     --unit --scope --target --mode --needs --branch --base
#                                belong to the --repo before them
#
#   yan task new --title 'unify the auth header' \
#       --repo monorepo-x --scope apps/auth  --target master \
#       --repo monorepo-x --scope apps/admin --target master \
#       --repo proto                         --target main
#
# Three units, two repositories, and no nesting syntax to learn. `--scope` is
# repeatable within a unit; leaving it out means the unit's scope is the repo
# root, which is the empty list - the prefix that matches every path is no
# prefix at all, and `yan scope-check` already reads an empty scope as "this
# unit restricts nothing".
#
# --target is required for EVERY unit and is never defaulted (branching.md
# §6.4): during a release the team merges into a shared branch, in quiet
# periods into master, and a tool that guessed would be wrong about half the
# time, silently, until the outbound MR.
#
# ---------------------------------------------------------------------------
# SOFT AND HARD
# ---------------------------------------------------------------------------
#
# cli-ux.md §1. A person with a terminal and missing values gets Clack; anyone
# else - an agent, a script, CI, a hook - gets a refusal that names the flags.
# The no-TTY case is checked first and always wins, because a prompt with
# nobody at the keyboard is a hang, and a hang inside a hook is invisible.
#
# Exit codes: 0 fine, 2 you called this wrongly, 1 it did not work.
#
set -euo pipefail

: "${YAN_HOME:?yan-task-new: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-task.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-task.sh"
# shellcheck source=bin/lib-lock.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-lock.sh"
# shellcheck source=bin/lib-ui.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-ui.sh"

YAN_BIN=${YAN_BIN:-$YAN_HOME/bin/yan}

die() {
	printf 'yan task new: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan task new --title <text> [--description <text>] [--id <id>]
                    --repo <name> [--unit <name>] [--scope <path>]...
                                  --target <branch> [--mode scout|branch|mr]
                                  [--needs <unit>]... [--branch <name>] [--base <ref>]
                    [--repo <name> ...]...
                    [--agent <cli>] [--json]

Creates the task, its brief and its unit(s), then ENTERS it: the task's
container is created and agents.yan is started inside it. There is no separate
start step.

The unit flags are order sensitive: each --repo opens a unit, and the flags
after it belong to that unit until the next --repo.

  --target  REQUIRED for every unit, and never guessed (branching.md §6.4).
  --scope   repeatable; omit it and the unit's scope is the repo root.
  --id      the task id; allocated as the next free t<NNN> when omitted.

With a terminal and missing values this asks with prompts (cli-ux.md §3).
Without one it refuses and names the flags, so nothing ever hangs waiting for
an answer that is not coming.
EOF
}

# --- arguments --------------------------------------------------------------

title=
description=
id=
agent=
as_json=0
have_title=0
have_description=0

# The unit under construction, plus the finished ones as a JSON array.
units_json='[]'
cur_repo=
cur_unit=
cur_target=
cur_mode=
cur_branch=
cur_base=
cur_scope=()
cur_needs=()

# emit <jq args...> - jq output with the CRLF that jq.exe adds stripped
# (conventions §2.3). Single values survive $(...) untouched; this is here so
# the JSON we build is byte-identical on both runtimes.
emit() {
	local out
	out=$(jq "$@") || return $?
	[ -n "$out" ] || return 0
	printf '%s\n' "${out//$'\r'/}"
}

json_array() { # json_array [items...]
	if [ $# -eq 0 ]; then
		printf '[]\n'
		return 0
	fi
	printf '%s\n' "$@" | emit -Rnc '[inputs]'
}

flush_unit() {
	local scope_json needs_json
	[ -n "$cur_repo" ] || return 0
	scope_json=$(json_array ${cur_scope[@]+"${cur_scope[@]}"})
	needs_json=$(json_array ${cur_needs[@]+"${cur_needs[@]}"})
	units_json=$(printf '%s' "$units_json" | emit -c \
		--arg repo "$cur_repo" --arg unit "$cur_unit" --arg target "$cur_target" \
		--arg mode "$cur_mode" --arg branch "$cur_branch" --arg base "$cur_base" \
		--argjson scope "$scope_json" --argjson needs "$needs_json" \
		'. + [{repo: $repo, unit: $unit, target: $target, mode: $mode,
		       branch: $branch, base: $base, scope: $scope, needs: $needs}]')
	cur_repo=
	cur_unit=
	cur_target=
	cur_mode=
	cur_branch=
	cur_base=
	cur_scope=()
	cur_needs=()
}

need_value() { # need_value <flag> <remaining-argument-count>
	if [ "$2" -lt 2 ]; then
		die "$1 needs a value" 2
	fi
}

need_repo() { # need_repo <flag> - a unit flag with no --repo before it
	if [ -z "$cur_repo" ]; then
		usage >&2
		die "$1 belongs to a unit, so it has to come after a --repo" 2
	fi
}

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--title)
		need_value "$1" "$#"
		shift
		title=$1
		have_title=1
		;;
	--description)
		need_value "$1" "$#"
		shift
		description=$1
		have_description=1
		;;
	--id)
		need_value "$1" "$#"
		shift
		id=$1
		;;
	--agent)
		need_value "$1" "$#"
		shift
		agent=$1
		;;
	--repo)
		need_value "$1" "$#"
		shift
		flush_unit
		cur_repo=$1
		;;
	--unit)
		need_value "$1" "$#"
		shift
		need_repo --unit
		cur_unit=$1
		;;
	--target)
		need_value "$1" "$#"
		shift
		need_repo --target
		cur_target=$1
		;;
	--mode)
		need_value "$1" "$#"
		shift
		need_repo --mode
		cur_mode=$1
		;;
	--branch)
		need_value "$1" "$#"
		shift
		need_repo --branch
		cur_branch=$1
		;;
	--base)
		need_value "$1" "$#"
		shift
		need_repo --base
		cur_base=$1
		;;
	--scope)
		need_value "$1" "$#"
		shift
		need_repo --scope
		cur_scope+=("$1")
		;;
	--needs)
		need_value "$1" "$#"
		shift
		need_repo --needs
		cur_needs+=("$1")
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
		die "unexpected argument: $1 - every value belongs to a flag" 2
		;;
	esac
	shift
done
flush_unit

n_units=$(printf '%s' "$units_json" | emit 'length')

# --- soft path, or a refusal that names the flags ---------------------------
#
# cli-ux.md §1's table, in the only order that is safe: is anything missing,
# and if so, is there a person who could answer? The soft path hands over with
# exec, so nothing below this block runs in that case - the ui collects the
# answers and starts a NEW `yan task new` with every flag filled in.

missing=()
[ "$have_title" -eq 1 ] || missing+=("--title")
[ "$n_units" -gt 0 ] || missing+=("--repo (with its --target)")

if [ "${#missing[@]}" -gt 0 ]; then
	if ui_soft_path_wanted; then
		soft=(task-new)
		[ "$have_title" -eq 1 ] && soft+=(--title "$title")
		[ "$have_description" -eq 1 ] && soft+=(--description "$description")
		[ -n "$id" ] && soft+=(--id "$id")
		[ -n "$agent" ] && soft+=(--agent "$agent")
		ui_run "${soft[@]}"
		die "the interactive prompts could not be started"
	fi

	why=$(ui_why_unavailable)
	if ui_is_tty && [ -n "$why" ]; then
		printf 'yan task new: the interactive path is unavailable: %s\n' "$why" >&2
	fi
	usage >&2
	die "missing: ${missing[*]} - pass them, or run this from a terminal to be asked" 2
fi

# Every unit needs a target, and the message has to say WHICH unit.
#
# A half-specified unit is NOT routed to the soft path: the prompts collect a
# whole task from the top and would silently drop the --repo flags that were
# typed. Losing what `user` already said is worse than saying what is missing.
while IFS=$'\t' read -r u_repo u_target; do
	[ -n "$u_repo" ] || continue
	[ -n "$u_target" ] ||
		die "--target is required for --repo $u_repo, and yan never guesses it: say which branch that unit delivers into (branching.md §6.4)" 2
done < <(printf '%s' "$units_json" | emit -r '.[] | [.repo, .target] | @tsv')

# --- the task id ------------------------------------------------------------
#
# scope.md §12's current leaning: plain numbers in the t042 style. The readable
# title lives in brief.md and log.md, not in the id, because the id also goes
# into branch names (branching.md §6.5) and short is worth something there.
#
# The next free number is DERIVED by scanning tasks/, never stored in a
# counter file - there is no registry in yan (INDEX.md §3).

next_id() {
	local t n max=0
	while IFS= read -r t; do
		case $t in
		t[0-9]*)
			n=${t#t}
			case $n in
			'' | *[!0-9]*) continue ;;
			esac
			# 10# so that t008 is eight and not an invalid octal literal.
			n=$((10#$n))
			[ "$n" -gt "$max" ] && max=$n
			;;
		esac
	done < <(task_list)
	printf 't%03d\n' "$((max + 1))"
}

if [ -n "$id" ] && task_exists "$id"; then
	die "task $id already exists - 'yan ls' lists them" 2
fi

create() {
	if [ -z "$id" ]; then
		id=$(next_id)
	fi
	if task_exists "$id"; then
		printf 'yan task new: task %s already exists\n' "$id" >&2
		return 1
	fi
	task_init "$id" "$title"
}

lockdir=$YAN_HOME/tasks/.new.lock
mkdir -p -- "$YAN_HOME/tasks"
rc=0
with_lock "$lockdir" "${YAN_TASK_NEW_LOCK_TIMEOUT:-30}" create || rc=$?
[ "$rc" -eq 0 ] || die "could not allocate a task id (see the message above)" "$rc"

dir=$(task_dir "$id")

# --- the brief --------------------------------------------------------------
#
# task_init writes the heading; the description is this command's to add,
# because it is the contract `user` just typed. An empty description is allowed
# (cli-ux.md §3 step 2) and simply leaves the heading standing.

if [ -n "$description" ]; then
	printf '# %s %s\n\n%s\n' "$id" "$title" "$description" >"$dir/brief.md" ||
		die "task $id was created but its brief could not be written"
fi

# --- the units --------------------------------------------------------------
#
# `yan unit add` does this, and it is called as a subcommand rather than
# re-implemented: it owns the branch-name hook, the "stop if the hook refuses"
# rule, and making the branch exist. Duplicating any of that here would give
# those rules two homes.

unit_name_from() { # unit_name_from <repo> <first-scope>
	local repo=$1 path=${2-} base
	if [ -n "$path" ]; then
		base=${path%/}
		base=${base##*/}
	else
		base=$repo
	fi
	base=${base//[^A-Za-z0-9._-]/-}
	base=${base##-}
	base=${base%%-}
	printf '%s\n' "${base:-unit}"
}

added=()
while IFS= read -r spec; do
	[ -n "$spec" ] || continue

	u_repo=$(printf '%s' "$spec" | emit -r '.repo')
	u_unit=$(printf '%s' "$spec" | emit -r '.unit')
	u_target=$(printf '%s' "$spec" | emit -r '.target')
	u_mode=$(printf '%s' "$spec" | emit -r '.mode')
	u_branch=$(printf '%s' "$spec" | emit -r '.branch')
	u_base=$(printf '%s' "$spec" | emit -r '.base')

	if [ -z "$u_unit" ]; then
		first_scope=$(printf '%s' "$spec" | emit -r '.scope[0] // ""')
		u_unit=$(unit_name_from "$u_repo" "$first_scope")
		# One sub-application is one unit, so two packages under one repo must
		# not collide on a name. The suffix is a naming convenience only; it
		# never invents a scope or a target.
		suffix=2
		while task_unit_json "$id" "$u_unit" >/dev/null 2>&1; do
			u_unit="$(unit_name_from "$u_repo" "$first_scope")-$suffix"
			suffix=$((suffix + 1))
		done
	fi

	args=(unit add --task "$id" --unit "$u_unit" --repo "$u_repo" --target "$u_target")
	[ -n "$u_mode" ] && args+=(--mode "$u_mode")
	[ -n "$u_branch" ] && args+=(--branch "$u_branch")
	[ -n "$u_base" ] && args+=(--base "$u_base")
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		args+=(--scope "$p")
	done < <(printf '%s' "$spec" | emit -r '.scope[]?')
	while IFS= read -r n; do
		[ -n "$n" ] || continue
		args+=(--needs "$n")
	done < <(printf '%s' "$spec" | emit -r '.needs[]?')

	if ! "${BASH:-bash}" "$YAN_BIN" "${args[@]}" >/dev/null; then
		die "task $id was created, but unit '$u_unit' could not be added (see the message above). Fix it, then finish with 'yan unit add' and enter with 'yan continue --task $id'"
	fi
	added+=("$u_unit")
done < <(printf '%s' "$units_json" | emit -c '.[]')

log_append "$id" "task created: ${#added[@]} unit(s) - ${added[*]}" || true

# --- enter ------------------------------------------------------------------
#
# cli-ux.md §3 step 7. Create ends with `user` inside the task, and this is the
# same enter step `yan continue` performs - the same file, not a copy of it.

enter_args=(continue --task "$id")
[ -n "$agent" ] && enter_args+=(--agent "$agent")
[ "$as_json" -eq 1 ] && enter_args+=(--json)

if [ "$as_json" -eq 1 ]; then
	entered=$("${BASH:-bash}" "$YAN_BIN" "${enter_args[@]}") || die "task $id and its units exist, but entering it failed (see the message above) - run 'yan continue --task $id'"
	printf '%s' "$entered" | emit -c --arg id "$id" --arg title "$title" \
		--argjson units "$(json_array "${added[@]}")" \
		'{version: 1, task: $id, title: $title, units: $units, entered: .}'
	exit 0
fi

printf 'task %s  %s\n' "$id" "$title"
printf 'units    %s\n' "${added[*]}"
printf 'dir      %s\n' "$dir"
printf '\n'
"${BASH:-bash}" "$YAN_BIN" "${enter_args[@]}" ||
	die "task $id and its units exist, but entering it failed (see the message above) - run 'yan continue --task $id'"
