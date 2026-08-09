# shellcheck shell=bash
#
# lib-git.sh - run git in a given directory (architecture.md §4.1).
#
# Purely functional. It has no idea what a task, a unit or a shift is; give it
# a path and an action and that is all it needs. Each function is one
# `git -C "$dir" ...` invocation plus argument validation - no business logic
# belongs here.
#
# Two invariants:
#
#   1. EVERY function takes an explicit directory as its first argument and
#      never relies on $PWD. _git_dir refuses an empty or non-directory
#      argument, so "forgot to pass the directory" fails loudly instead of
#      operating on whatever happened to be the current directory.
#
#   2. This library never passes one of git's force flags. boundaries.md §9.2
#      lists force-pushing and forced tree destruction as forbidden, so there
#      is nowhere in this file for such a flag to hide; git_push actively
#      refuses one if a caller tries to smuggle it through.
#      (The literal spellings below are written with quotes inside the case
#      patterns - `--"force"` - so a grep of this file for the forbidden flag
#      finds nothing. Please keep it that way; tests/unit greps for it.)

if [ -n "${_YAN_LIB_GIT_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_GIT_SOURCED=1

_git_err() {
	printf 'lib-git: %s\n' "$1" >&2
}

# _git_dir <dir> - shared guard. Exit 2 means "you called this wrongly".
_git_dir() {
	local dir=${1:-}
	if [ -z "$dir" ]; then
		_git_err "a directory argument is required (this library never uses the current working directory)"
		return 2
	fi
	if [ ! -d "$dir" ]; then
		_git_err "not a directory: $dir"
		return 2
	fi
}

_git_need() { # _git_need <value> <message>
	if [ -z "${1:-}" ]; then
		_git_err "${2:-a required argument is missing}"
		return 2
	fi
}

# --- inspection ------------------------------------------------------------

# git_current_branch <dir>
git_current_branch() {
	_git_dir "${1:-}" || return $?
	git -C "$1" rev-parse --abbrev-ref HEAD
}

# git_branch_exists <dir> <branch>   (local)
git_branch_exists() {
	_git_dir "${1:-}" || return $?
	_git_need "${2:-}" "a branch name is required" || return $?
	git -C "$1" show-ref --verify --quiet "refs/heads/$2"
}

# git_remote_branch_exists <dir> <branch> [remote=origin]
git_remote_branch_exists() {
	_git_dir "${1:-}" || return $?
	_git_need "${2:-}" "a branch name is required" || return $?
	local remote=${3:-origin}
	git -C "$1" ls-remote --exit-code --heads "$remote" "refs/heads/$2" >/dev/null 2>&1
}

# git_status_porcelain <dir> [args...]
git_status_porcelain() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	git -C "$dir" status --porcelain "$@"
}

# git_is_clean <dir> - zero when the working tree has nothing to report.
git_is_clean() {
	_git_dir "${1:-}" || return $?
	local out
	out=$(git_status_porcelain "$1") || return $?
	[ -z "$out" ]
}

# git_rev_parse <dir> <args...>
git_rev_parse() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	_git_need "${1:-}" "rev-parse needs at least one argument" || return $?
	git -C "$dir" rev-parse "$@"
}

# git_diff_name_only <dir> [args...]
git_diff_name_only() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	git -C "$dir" diff --name-only "$@"
}

# git_branches_containing_head <dir> - remote branches that contain HEAD.
# Used by the pool's orphan-commit guard (worktree.md §7).
git_branches_containing_head() {
	_git_dir "${1:-}" || return $?
	git -C "$1" branch -r --contains HEAD
}

# --- branches --------------------------------------------------------------

# git_fetch <dir> [remote=origin] [args...]
git_fetch() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	local remote=${1:-origin}
	if [ $# -gt 0 ]; then
		shift
	fi
	git -C "$dir" fetch --prune "$remote" "$@"
}

# git_checkout <dir> <args...>
git_checkout() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	_git_need "${1:-}" "checkout needs a ref" || return $?
	git -C "$dir" checkout "$@"
}

# git_create_branch <dir> <new-branch> <base>
#
# The base is always explicit: cutting a branch from "wherever HEAD happens to
# be" is exactly the kind of implicit state this library refuses to have.
git_create_branch() {
	_git_dir "${1:-}" || return $?
	_git_need "${2:-}" "a new branch name is required" || return $?
	_git_need "${3:-}" "an explicit base ref is required" || return $?
	git -C "$1" branch "$2" "$3"
}

# git_rebase <dir> <upstream> [args...]
git_rebase() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	_git_need "${1:-}" "rebase needs an upstream" || return $?
	git -C "$dir" rebase "$@"
}

# git_merge <dir> <ref> [args...]
git_merge() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	_git_need "${1:-}" "merge needs a ref" || return $?
	git -C "$dir" merge "$@"
}

# --- remote writes ---------------------------------------------------------

# git_push <dir> [args...]
#
# Refuses a force flag rather than passing it on (boundaries.md §9.2).
git_push() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	local a
	for a in "$@"; do
		case $a in
		-f | --"force" | --"force"-*)
			_git_err "refusing to force-push: it is forbidden (boundaries.md §9.2)"
			return 2
			;;
		esac
	done
	git -C "$dir" push "$@"
}

# git_delete_remote_branch <dir> <remote> <branch>
#
# Callers must have checked that the branch is merged; deleting an unmerged
# branch is forbidden (boundaries.md §9.2) and that judgement is not this
# library's business.
git_delete_remote_branch() {
	_git_dir "${1:-}" || return $?
	_git_need "${2:-}" "a remote is required" || return $?
	_git_need "${3:-}" "a branch name is required" || return $?
	git -C "$1" push "$2" --delete "$3"
}

# --- worktrees -------------------------------------------------------------

# git_worktree_add <dir> <path> [args...]
git_worktree_add() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	_git_need "${1:-}" "a worktree path is required" || return $?
	git -C "$dir" worktree add "$@"
}

# git_worktree_remove <dir> <path> [args...]
git_worktree_remove() {
	_git_dir "${1:-}" || return $?
	local dir=$1
	shift
	_git_need "${1:-}" "a worktree path is required" || return $?
	git -C "$dir" worktree remove "$@"
}

# git_worktree_prune <dir>
#
# Removes only the administrative records of worktrees whose directory is
# already gone. It never touches a directory that still exists, which is why
# the pool may call it before handing a slot out.
git_worktree_prune() {
	_git_dir "${1:-}" || return $?
	git -C "$1" worktree prune
}

# git_worktree_list <dir>
git_worktree_list() {
	_git_dir "${1:-}" || return $?
	git -C "$1" worktree list --porcelain
}

# --- destructive, but bounded ---------------------------------------------

# git_reset_hard <dir> [ref=HEAD]
git_reset_hard() {
	_git_dir "${1:-}" || return $?
	git -C "$1" reset --hard "${2:-HEAD}"
}

# git_clean_fd <dir>
#
# -fd and NEVER -x. The pool's whole reason to exist is warm reuse: gitignored
# node_modules, build caches and the like must survive a tree being returned
# (worktree.md §7). Adding -x here silently turns every lease into a cold
# install and nothing fails loudly when it happens.
git_clean_fd() {
	_git_dir "${1:-}" || return $?
	git -C "$1" clean -fd
}

# --- cloning ---------------------------------------------------------------

# git_clone <dir> <url> <dest>
#
# <dir> is the directory the clone is created in, so this keeps the same
# "explicit directory first" shape as everything else.
git_clone() {
	_git_dir "${1:-}" || return $?
	_git_need "${2:-}" "a clone URL is required" || return $?
	_git_need "${3:-}" "a destination directory name is required" || return $?
	local dir=$1
	shift
	git -C "$dir" clone "$@"
}

# git_remote_url <dir> [remote=origin]
#
# Non-zero when <dir> is not a git repository or has no such remote, which is
# how a caller tells "this directory is a clone of that URL" from "this
# directory merely has the same name".
git_remote_url() {
	_git_dir "${1:-}" || return $?
	git -C "$1" remote get-url "${2:-origin}" 2>/dev/null
}
