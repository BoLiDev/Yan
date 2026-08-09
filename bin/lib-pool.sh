# shellcheck shell=bash
#
# lib-pool.sh - the worktree pool (td worktree.md §7, architecture.md §4.3).
#
# The pool exists for exactly one reason: warm reuse. On a large monorepo a
# handful of trees stay ready, and whichever one you lease needs no cold
# install. Everything else here - leases, backpressure, the orphan-commit
# guard - is the price of that one property, and the property itself is one
# letter wide:
#
#   RETURNING A TREE IS `git reset --hard` PLUS `git clean -fd`.
#   NEVER WITH -x.
#
# -x would delete the gitignored node_modules and build caches too, which turns
# every lease back into a cold install and nothing fails loudly when it
# happens. That is why the clean goes through lib-git's git_clean_fd, which
# hardcodes the flags, instead of being spelled out here.
#
# Layout (td INDEX.md §3):
#
#   <pool root>/<repo>-<hash>/         one pool per main clone
#     lock/                            lib-lock's directory lock
#     leases/<slot>.json               the runtime records - they belong to the
#                                      pool, NOT to a task, so they never live
#                                      under $YAN_HOME
#     <slot>/<repo>/                   the tree itself
#
# The pool root is ~/.yan-trees by default and YAN_POOL_ROOT overrides it. The
# tests point YAN_POOL_ROOT at a temporary directory so a test run never
# touches the real pool. (Whether the root should be configurable at all is
# still open - td scope.md §12 question 4; the environment variable is the
# smallest thing that makes this testable without answering that question.)
#
# PATHS. On Git Bash the shell says /tmp/x and git.exe says
# C:/Users/.../Temp/x for the same directory, so `git worktree list
# --porcelain` output never string-matches a path we built ourselves. Every
# comparison goes through _pool_key (cygpath -m, then lower case, because
# Windows paths are case-insensitive); identity on Linux.
#
# The same difference bites from the other side too, and much more quietly:
# when MSYS2 launches a NATIVE program it rewrites arguments that look like
# POSIX paths, so `jq --arg path /tmp/x` silently stores C:/Users/.../Temp/x.
# The path yan hands out is always the shell's own spelling, on both runtimes,
# so every jq call that carries a path goes through _pool_jq, which turns the
# rewriting off. Passing a path TO git is the opposite case: there the rewrite
# is exactly what makes git work, so it is left alone - and that is why the
# comparison in the paragraph above is needed at all.
#
# WHAT THIS IS NOT. A seam reports facts and decides nothing: pool_get hands
# out a tree or says the pool is full, and the subcommand decides what that
# means. It calls lib-git (a stateless utility - a normal downward dependency)
# and never another seam. There is no force flag anywhere in the MVP:
# boundaries.md §9.2 forbids it, and the orphan-commit guard is the last line
# of defence, so a refusal means stop and investigate.
#
# Exit codes: 2 you called this wrongly, 1 it did not work, 3 a conditional
# return was refused because the lease identity did not match. 3 is its own
# code on purpose - an automatic retry has to tell "someone else holds this
# tree now" apart from "the return failed", and that distinction is the whole
# point of --if-lease-id.

if [ -n "${_YAN_LIB_POOL_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_POOL_SOURCED=1

# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"
# shellcheck source=bin/lib-json.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-json.sh"
# shellcheck source=bin/lib-lock.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-lock.sh"

# The identity check refused the return. Nothing was touched.
POOL_RC_MISMATCH=3

_pool_err() {
	printf 'lib-pool: %s\n' "$1" >&2
}

_pool_need() { # _pool_need <value> <message>
	if [ -z "${1:-}" ]; then
		_pool_err "${2:-a required argument is missing}"
		return 2
	fi
}

# _pool_jq <args...> - the only jq this library calls.
#
# jq on Windows is a native program, which makes it silently wrong twice:
#
#   1. MSYS2 rewrites arguments that look like POSIX paths on the way in, so
#      `jq --arg path /tmp/x` stores C:/Users/.../Temp/x and the pool hands
#      out a path spelled differently from the one it built.
#   2. jq.exe writes CRLF. A single value survives, because bash drops the
#      trailing CR along with the newline, but in a multi-line result every
#      line except the last keeps one and then nothing compares equal again.
#
# Turning (1) off means jq can no longer be given a FILE to read - it would
# receive a POSIX path it cannot open. So this library never passes jq a file
# name: input always arrives on stdin, where bash does the opening and the
# question does not arise.
#
# Both variables are ignored on Linux, where nothing rewrites anything.
_pool_jq() {
	local out rc=0
	out=$(MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 jq "$@") || rc=$?
	if [ "$rc" -ne 0 ]; then
		return "$rc"
	fi
	printf '%s\n' "${out//$'\r'/}"
}

# --- paths -----------------------------------------------------------------

_POOL_CYGPATH=

_pool_have_cygpath() {
	if [ -z "$_POOL_CYGPATH" ]; then
		if command -v cygpath >/dev/null 2>&1; then
			_POOL_CYGPATH=yes
		else
			_POOL_CYGPATH=no
		fi
	fi
	[ "$_POOL_CYGPATH" = yes ]
}

# _pool_native <path> - the spelling a native tool (git.exe) prints.
_pool_native() {
	if _pool_have_cygpath; then
		cygpath -m -- "${1-}" 2>/dev/null || printf '%s\n' "${1-}"
	else
		printf '%s\n' "${1-}"
	fi
}

# _pool_key <path> - the comparable form of a path.
#
# Purely lexical, so it works for paths that do not exist yet. Lower case on
# Windows only: two spellings that differ in case are the same directory there
# and the same comparison would be wrong on Linux.
_pool_key() {
	local p
	p=$(_pool_native "${1-}")
	while [ -n "$p" ] && [ "${p%/}" != "$p" ]; do
		p=${p%/}
	done
	if _pool_have_cygpath; then
		printf '%s\n' "$p" | tr '[:upper:]' '[:lower:]'
	else
		printf '%s\n' "$p"
	fi
}

# _pool_abs <path> - absolute, symlinks resolved when the directory exists.
_pool_abs() {
	local p=${1-} r
	if [ -d "$p" ] && r=$(cd -P -- "$p" >/dev/null 2>&1 && pwd) && [ -n "$r" ]; then
		printf '%s\n' "$r"
		return 0
	fi
	case $p in
	/* | ?:[/\\]*) printf '%s\n' "$p" ;;
	*) printf '%s/%s\n' "$PWD" "$p" ;;
	esac
}

# _pool_hash <string> [length=8] - a short, stable disambiguator.
#
# Not a security boundary: it only keeps two clones with the same basename in
# different pools.
_pool_hash() {
	local s=${1-} len=${2:-8} h=
	if command -v sha1sum >/dev/null 2>&1; then
		h=$(printf '%s' "$s" | sha1sum 2>/dev/null) || h=
	fi
	if [ -z "$h" ] && command -v shasum >/dev/null 2>&1; then
		h=$(printf '%s' "$s" | shasum 2>/dev/null) || h=
	fi
	if [ -z "$h" ]; then
		h=$(printf '%s' "$s" | cksum 2>/dev/null) || h=
	fi
	h=${h%% *}
	printf '%s\n' "${h:0:$len}"
}

# _pool_repo_name <clone> - the directory name, without a .git suffix.
_pool_repo_name() {
	local n=${1-}
	n=${n%/}
	n=${n##*/}
	n=${n%.git}
	printf '%s\n' "$n"
}

# pool_root - the directory every repository's pool lives under.
pool_root() {
	local root=${YAN_POOL_ROOT:-${HOME:-.}/.yan-trees}
	if ! mkdir -p -- "$root" 2>/dev/null; then
		_pool_err "cannot create the pool root: $root - set YAN_POOL_ROOT to a writable directory"
		return 1
	fi
	_pool_abs "$root"
}

# pool_dir <clone> - this clone's pool: <root>/<repo>-<hash>.
pool_dir() {
	local clone=${1:-} root abs name
	_pool_need "$clone" "usage: pool_dir <main-clone-directory>" || return $?
	root=$(pool_root) || return 1
	abs=$(_pool_abs "$clone")
	name=$(_pool_repo_name "$abs")
	printf '%s/%s-%s\n' "$root" "$name" "$(_pool_hash "$(_pool_key "$abs")")"
}

_pool_lock_timeout() {
	local t=${YAN_POOL_LOCK_TIMEOUT:-60}
	case $t in
	'' | *[!0-9]*) t=60 ;;
	esac
	printf '%s\n' "$t"
}

# _pool_lease_id - a random identity for one acquisition.
_pool_lease_id() {
	local id=
	if [ -r /dev/urandom ]; then
		# tr is closed early by head; `|| true` keeps pipefail from turning
		# that into a failure and throwing away a perfectly good id.
		id=$({ LC_ALL=C tr -dc 'a-f0-9' </dev/urandom || true; } 2>/dev/null | head -c 16) || id=
	fi
	if [ "${#id}" -lt 12 ]; then
		id=$(_pool_hash "$$-$(date +%s)-${RANDOM:-0}${RANDOM:-0}${RANDOM:-0}" 16)
	fi
	printf '%s\n' "$id"
}

# --- git facts -------------------------------------------------------------

# _pool_registered <clone> <path> - zero when git knows <path> as a worktree.
#
# This is the comparison the path note at the top of the file is about.
_pool_registered() {
	local clone=$1 want line p
	want=$(_pool_key "$2")
	while IFS= read -r line; do
		line=${line%$'\r'}
		case $line in
		'worktree '*)
			p=$(_pool_key "${line#worktree }")
			if [ "$p" = "$want" ]; then
				return 0
			fi
			;;
		esac
	done < <(git_worktree_list "$clone" 2>/dev/null || true)
	return 1
}

# _pool_base_ref <clone> <base> - the ref a new shift branch is cut from.
#
# A local branch wins, then origin/<base>, then anything git can resolve. The
# pool never fetches: keeping the integration branch up to date is `yan sync`'s
# job, and a seam does not decide when to talk to the remote.
_pool_base_ref() {
	local clone=$1 base=$2
	if git_branch_exists "$clone" "$base"; then
		printf '%s\n' "$base"
		return 0
	fi
	if git_rev_parse "$clone" --verify --quiet "refs/remotes/origin/$base" >/dev/null 2>&1; then
		printf 'origin/%s\n' "$base"
		return 0
	fi
	if git_rev_parse "$clone" --verify --quiet "$base^{commit}" >/dev/null 2>&1; then
		printf '%s\n' "$base"
		return 0
	fi
	_pool_err "cannot resolve the base '$base' in $clone - fetch it first, or pass a base that exists"
	return 1
}

# --- leases ----------------------------------------------------------------

_pool_lease_field() { # _pool_lease_field <file> <field>
	[ -f "$1" ] || return 0
	_pool_jq -r --arg f "$2" '.[$f] // empty' <"$1" 2>/dev/null || printf '\n'
}

# _pool_reclaim <pooldir> - drop leases whose tree no longer exists.
#
# Only that case. A lease whose owning process died is NOT reclaimed: the tree
# may still hold work, and "no process is running but this tree is still taken"
# is precisely what a lease is for (td §7).
_pool_reclaim() {
	local dir=$1 f p
	for f in "$dir"/leases/*.json; do
		[ -f "$f" ] || continue
		p=$(_pool_lease_field "$f" path)
		if [ -z "$p" ] || [ ! -d "$p" ]; then
			rm -f -- "$f"
		fi
	done
}

# _pool_slot_of <pooldir> <path-or-slot> - the slot holding a lease.
_pool_slot_of() {
	local dir=$1 target=$2 f p tkey akey
	case $target in
	'') return 1 ;;
	*[!0-9]*) ;;
	*)
		if [ -f "$dir/leases/$target.json" ]; then
			printf '%s\n' "$target"
			return 0
		fi
		return 1
		;;
	esac

	tkey=$(_pool_key "$target")
	akey=$(_pool_key "$(_pool_abs "$target")")
	for f in "$dir"/leases/*.json; do
		[ -f "$f" ] || continue
		p=$(_pool_lease_field "$f" path)
		[ -n "$p" ] || continue
		if [ "$(_pool_key "$p")" = "$tkey" ] || [ "$(_pool_key "$(_pool_abs "$p")")" = "$akey" ]; then
			_pool_lease_field "$f" slot
			return 0
		fi
	done
	return 1
}

# --- get -------------------------------------------------------------------

# pool_get <clone> <pool-size> <base> <branch> <holder>
#
# Leases a tree, cuts <branch> from <base> in it, and prints
# {path, lease_id, holder} on stdout. The pool size is passed in rather than
# read here: it lives in mem/repos.json, which is yan's own bookkeeping, and a
# seam does not read (or write) that.
pool_get() {
	local clone=${1:-} size=${2:-} base=${3:-} branch=${4:-} holder=${5:-} dir timeout
	_pool_need "$clone" "usage: pool_get <clone> <pool-size> <base> <branch> <holder>" || return $?
	_pool_need "$size" "a pool size is required (mem/repos.json pool_size, default 8)" || return $?
	_pool_need "$base" "a base ref is required - a tree is always cut from an explicit base" || return $?
	_pool_need "$branch" "a branch name is required - a leased tree is never left on a detached HEAD" || return $?
	_pool_need "$holder" "a holder is required, in the form <task>/<unit>/<sid>" || return $?

	case $size in
	*[!0-9]* | 0)
		_pool_err "the pool size must be a positive whole number, got: $size"
		return 2
		;;
	esac
	case $branch$holder in
	*[[:space:]]*)
		_pool_err "a branch name and a holder may not contain whitespace"
		return 2
		;;
	esac
	if [ ! -d "$clone" ]; then
		_pool_err "not a directory: $clone"
		return 2
	fi

	dir=$(pool_dir "$clone") || return 1
	if ! mkdir -p -- "$dir/leases"; then
		_pool_err "cannot create the pool directory: $dir"
		return 1
	fi
	timeout=$(_pool_lock_timeout)
	with_lock "$dir/lock" "$timeout" _pool_get_locked "$clone" "$size" "$base" "$branch" "$holder" "$dir"
}

_pool_get_locked() {
	local clone=$1 size=$2 base=$3 branch=$4 holder=$5 dir=$6
	local name tree slot='' n base_ref cur lease lease_id doc out now

	name=$(_pool_repo_name "$(_pool_abs "$clone")")

	# A tree somebody deleted by hand leaves an administrative record behind
	# that would make `worktree add` refuse the path. Pruning removes only
	# records whose directory is already gone.
	git_worktree_prune "$clone" >/dev/null 2>&1 || true
	_pool_reclaim "$dir"

	# A free slot that already holds a tree first: that is warm reuse.
	for ((n = 1; n <= size; n++)); do
		if [ -f "$dir/leases/$n.json" ]; then
			continue
		fi
		if [ -e "$dir/$n/$name/.git" ]; then
			slot=$n
			break
		fi
	done
	if [ -z "$slot" ]; then
		for ((n = 1; n <= size; n++)); do
			if [ -f "$dir/leases/$n.json" ] || [ -e "$dir/$n/$name" ]; then
				continue
			fi
			slot=$n
			break
		done
	fi
	if [ -z "$slot" ]; then
		# Backpressure. A full pool fails instead of growing: an extra tree
		# would be a cold one, which is the same as having no pool (td §7).
		_pool_err "the pool is full - all $size trees are leased, cannot start a new shift. 'yan tree status' shows who holds them; raise pool_size in mem/repos.json only if this machine can afford another tree"
		return 1
	fi

	tree=$dir/$slot/$name
	if ! mkdir -p -- "$dir/$slot"; then
		_pool_err "cannot create the slot directory: $dir/$slot"
		return 1
	fi
	base_ref=$(_pool_base_ref "$clone" "$base") || return 1

	if _pool_registered "$clone" "$tree"; then
		if ! git_is_clean "$tree"; then
			_pool_err "the tree in slot $slot still has changes: $tree - it was not returned properly, so investigate before it is leased again"
			return 1
		fi
		if git_branch_exists "$clone" "$branch"; then
			if ! out=$(git_checkout "$tree" "$branch" 2>&1); then
				_pool_err "cannot check out '$branch' in $tree (it may be checked out in another tree): $out"
				return 1
			fi
		else
			if ! out=$(git_checkout "$tree" -b "$branch" "$base_ref" 2>&1); then
				_pool_err "cannot cut '$branch' from '$base_ref' in $tree: $out"
				return 1
			fi
		fi
	else
		if [ -e "$tree" ]; then
			_pool_err "$tree exists but git does not know it as a worktree - move it aside; the pool never deletes a directory it cannot account for"
			return 1
		fi
		if git_branch_exists "$clone" "$branch"; then
			if ! out=$(git_worktree_add "$clone" "$tree" "$branch" 2>&1); then
				_pool_err "cannot add a worktree at $tree on '$branch': $out"
				return 1
			fi
		else
			if ! out=$(git_worktree_add "$clone" -b "$branch" "$tree" "$base_ref" 2>&1); then
				_pool_err "cannot add a worktree at $tree cutting '$branch' from '$base_ref': $out"
				return 1
			fi
		fi
	fi

	# The tree must end up on a real branch. treehouse keeps a detached HEAD
	# and calls it a feature; yan's shift branches have to be pushed and turned
	# into MRs, so a detached HEAD here is a bug, not a state (td §7).
	cur=$(git_current_branch "$tree" 2>/dev/null) || cur=
	if [ "$cur" != "$branch" ]; then
		_pool_err "the tree is on '${cur:-an unknown ref}', not '$branch' - refusing to hand out a tree that is not on its shift branch"
		return 1
	fi

	lease=$dir/leases/$slot.json
	lease_id=$(_pool_lease_id)
	now=$(date +%s)
	if ! doc=$(_pool_jq -nc \
		--argjson slot "$slot" \
		--arg path "$tree" \
		--arg branch "$branch" \
		--arg base "$base" \
		--arg holder "$holder" \
		--arg lease_id "$lease_id" \
		--argjson at "$now" \
		--argjson pid "$$" \
		'{version: 1, slot: $slot, path: $path, branch: $branch, base: $base, holder: $holder, lease_id: $lease_id, at: $at, pid: $pid}'); then
		_pool_err "cannot build the lease record for slot $slot"
		return 1
	fi
	json_write "$lease" "$doc" || return 1

	_pool_jq -nc --arg path "$tree" --arg lease_id "$lease_id" --arg holder "$holder" \
		'{path: $path, lease_id: $lease_id, holder: $holder}'
}

# --- return ----------------------------------------------------------------

# pool_return <clone> <path-or-slot> [expect-lease-id] [expect-holder]
#
# Prints the path of the tree it returned. An empty expectation means "do not
# compare that field".
pool_return() {
	local clone=${1:-} target=${2:-} want_id=${3-} want_holder=${4-} dir timeout
	_pool_need "$clone" "usage: pool_return <clone> <path-or-slot> [lease-id] [holder]" || return $?
	_pool_need "$target" "which tree? pass the path 'yan tree get' printed, or its slot number" || return $?
	if [ ! -d "$clone" ]; then
		_pool_err "not a directory: $clone"
		return 2
	fi

	dir=$(pool_dir "$clone") || return 1
	timeout=$(_pool_lock_timeout)
	with_lock "$dir/lock" "$timeout" _pool_return_locked "$target" "$want_id" "$want_holder" "$dir"
}

_pool_return_locked() {
	local target=$1 want_id=$2 want_holder=$3 dir=$4
	local slot lease have_id have_holder tree dirty contained

	if ! slot=$(_pool_slot_of "$dir" "$target"); then
		_pool_err "no lease matches '$target' - 'yan tree status' lists what the pool is holding"
		return 1
	fi
	lease=$dir/leases/$slot.json
	have_id=$(_pool_lease_field "$lease" lease_id)
	have_holder=$(_pool_lease_field "$lease" holder)
	tree=$(_pool_lease_field "$lease" path)

	# Identity is compared while the lock is held and BEFORE anything
	# destructive happens - no reset, no clean, no lease cleared. That is what
	# makes an automatic retry safe (td §7).
	if [ -n "$want_id" ] && [ "$want_id" != "$have_id" ]; then
		_pool_err "lease id does not match: slot $slot is held under '$have_id', not '$want_id' - nothing was touched"
		return "$POOL_RC_MISMATCH"
	fi
	if [ -n "$want_holder" ] && [ "$want_holder" != "$have_holder" ]; then
		_pool_err "holder does not match: slot $slot is held by '$have_holder', not '$want_holder' - nothing was touched"
		return "$POOL_RC_MISMATCH"
	fi

	if [ -z "$tree" ] || [ ! -d "$tree" ]; then
		_pool_err "the leased tree is gone: ${tree:-<unknown>} - releasing the lease on slot $slot"
		rm -f -- "$lease"
		printf '%s\n' "${tree:-}"
		return 0
	fi

	# The orphan-commit guard. Returning destroys what is in the tree, so
	# there is exactly one question: would that lose anything? Two commands
	# answer it (td §7), and a refusal means stop and investigate - there is
	# deliberately no way to override it.
	if ! dirty=$(git_status_porcelain "$tree"); then
		_pool_err "cannot read the state of $tree"
		return 1
	fi
	if [ -n "$dirty" ]; then
		_pool_err "refusing to return $tree: it has uncommitted changes and returning it would destroy them permanently - commit and push them first"
		return 1
	fi
	contained=$(git_branches_containing_head "$tree" 2>/dev/null) || contained=
	if [ -z "$(printf '%s' "$contained" | tr -d '[:space:]')" ]; then
		_pool_err "refusing to return $tree: no remote branch contains HEAD, so these commits exist nowhere else - push the branch first"
		return 1
	fi

	if ! git_reset_hard "$tree" >/dev/null 2>&1; then
		_pool_err "cannot reset $tree"
		return 1
	fi
	# -fd and never -x: gitignored dependencies and build caches survive from
	# one shift to the next. git_clean_fd hardcodes the flags.
	if ! git_clean_fd "$tree" >/dev/null 2>&1; then
		_pool_err "cannot clean $tree"
		return 1
	fi

	rm -f -- "$lease"
	printf '%s\n' "$tree"
}

# --- status ----------------------------------------------------------------

# pool_status <clone> - the leases, as a JSON array sorted by slot.
#
# No lock: every lease file is written through lib-json's tmp -> mv, so a
# reader never sees a half-written record, and status should never block on
# whoever is busy creating a worktree.
pool_status() {
	local clone=${1:-} dir f
	local files=()
	_pool_need "$clone" "usage: pool_status <clone>" || return $?
	if [ ! -d "$clone" ]; then
		_pool_err "not a directory: $clone"
		return 2
	fi
	dir=$(pool_dir "$clone") || return 1

	for f in "$dir"/leases/*.json; do
		if [ -f "$f" ]; then
			files+=("$f")
		fi
	done
	if [ "${#files[@]}" -eq 0 ]; then
		printf '[]\n'
		return 0
	fi
	# cat, not `jq <files>`: see _pool_jq for why jq is never handed a path.
	cat -- "${files[@]}" |
		_pool_jq -s -c '[.[] | {slot, path, branch, base, holder, lease_id, at}] | sort_by(.slot)'
}
