# shellcheck shell=bash
#
# Stand-in for bin/lib-pool.sh: it HANDS OUT A TEMPORARY DIRECTORY AND RECORDS
# CALLS (architecture.md §7). Phase 2 deliberately left its shape to whoever
# first needed it, and that is Phase 7's ordering tests.
#
# What it has to make provable, and therefore what it records:
#
#   1. THE ORDER. Every call is appended to $YAN_STUB_POOL_DIR/calls in
#      lib-pool vocabulary. Point YAN_STUB_POOL_DIR, YAN_STUB_TERM_DIR and
#      YAN_STUB_FORGE_DIR at the SAME directory and the three stubs share one
#      `calls` file, so a test can read the sequence of pool, terminal and forge
#      calls as one list. That is how `yan shift done`'s order - MR merged,
#      outcome, rm -rf run/, return the tree, then delete the branch - is
#      checked without a real pool.
#
#   2. THE LEASE IDENTITY. pool_get hands out a lease id and pool_return
#      records the id and holder it was CALLED with. `yan tree return
#      --if-lease-id` is only safe on a retry if the caller carried the id
#      across, so the test has to be able to see that it did.
#      pool_stub_lease_id prints the id that was handed out.
#
#   3. WHAT HAD ALREADY HAPPENED. Set YAN_STUB_POOL_WITNESS to a path and every
#      recorded line carries `witness=present` or `witness=absent` for it. That
#      turns "run/ was deleted before the tree was returned" - a step no seam
#      can see - into an assertion about one recorded line.
#
# Programming it:
#
#   YAN_STUB_POOL_DIR        where trees, leases and calls live
#                            (default ${TMPDIR:-/tmp}/yan-stub-pool)
#   YAN_STUB_POOL_PATH       hand out exactly this path instead of a fresh
#                            directory. This is how the working-directory
#                            assertion is tested: point it at the main clone
#                            and `yan shift new` must refuse to start
#   YAN_STUB_POOL_LEASE_ID   the lease id to hand out (default lease-<slot>)
#   YAN_STUB_POOL_FULL=1     pool_get fails with lib-pool's own backpressure
#                            wording, which `yan sync` matches on
#   YAN_STUB_POOL_GET_RC     any other pool_get failure (default 0)
#   YAN_STUB_POOL_RETURN_RC  make pool_return fail (default 0)
#   YAN_STUB_POOL_WITNESS    a path whose presence is recorded on every line
#
# Helpers for tests: pool_stub_reset, pool_stub_calls, pool_stub_call_count,
# pool_stub_lease_id, pool_stub_leases.
#
# Like the real library it decides nothing, it writes nothing under $YAN_HOME,
# and it never touches the network. Unlike the real library it runs no git at
# all: a stub tree is a directory with a .git FILE in it, which is enough for
# every caller that only asks "is this a directory and is it the one you gave
# me".

if [ -n "${_YAN_LIB_POOL_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_POOL_SOURCED=1

# The identity check refused the return. Nothing was touched. Same value as the
# real library, because callers compare against it by name.
POOL_RC_MISMATCH=3

_pool_err() {
	printf 'lib-pool: %s\n' "$1" >&2
}

_pool_stub_dir() {
	printf '%s\n' "${YAN_STUB_POOL_DIR:-${TMPDIR:-/tmp}/yan-stub-pool}"
}

# _pool_stub_jq - the same guard the real library's _pool_jq carries.
#
# jq on Windows is a NATIVE program, so MSYS2 rewrites arguments that look like
# POSIX paths on the way in: `jq --arg path /tmp/x` quietly stores
# C:/Users/.../Temp/x, and a stub that handed out a path spelled differently
# from the one it was given would fail tests for a reason that has nothing to
# do with the code under test. jq.exe also writes CRLF. Both are ignored on
# Linux. Input never arrives as a file name, only on stdin or -n, because a
# file name would be a POSIX path jq.exe could not then open.
_pool_stub_jq() {
	local out rc=0
	out=$(MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 jq "$@") || rc=$?
	if [ "$rc" -ne 0 ]; then
		return "$rc"
	fi
	printf '%s\n' "${out//$'\r'/}"
}

pool_stub_reset() {
	local dir
	dir=$(_pool_stub_dir)
	rm -rf -- "$dir"
	mkdir -p -- "$dir/leases"
}

pool_stub_calls() {
	local dir
	dir=$(_pool_stub_dir)
	if [ -f "$dir/calls" ]; then
		cat -- "$dir/calls"
	fi
}

pool_stub_call_count() {
	local n
	n=$(pool_stub_calls | grep -c . || true)
	printf '%s\n' "${n:-0}"
}

# pool_stub_lease_id [slot] - the lease id this stub handed out.
pool_stub_lease_id() {
	local dir slot=${1:-1}
	dir=$(_pool_stub_dir)
	if [ -f "$dir/leases/$slot.id" ]; then
		tr -d ' \t\r\n' <"$dir/leases/$slot.id"
	fi
}

# pool_stub_leases - the slots still leased, one per line.
pool_stub_leases() {
	local dir f
	dir=$(_pool_stub_dir)
	(
		shopt -s nullglob
		for f in "$dir"/leases/*.id; do
			f=${f##*/}
			printf '%s\n' "${f%.id}"
		done
	) | LC_ALL=C sort
}

# _pool_stub_record <text> - one call, plus the witness when one is named.
_pool_stub_record() {
	local dir line=$*
	dir=$(_pool_stub_dir)
	mkdir -p -- "$dir"
	if [ -n "${YAN_STUB_POOL_WITNESS:-}" ]; then
		if [ -e "$YAN_STUB_POOL_WITNESS" ]; then
			line="$line witness=present"
		else
			line="$line witness=absent"
		fi
	fi
	printf '%s\n' "$line" >>"$dir/calls"
}

_pool_stub_repo_name() {
	local n=${1-}
	n=${n%/}
	n=${n##*/}
	n=${n%.git}
	printf '%s\n' "$n"
}

# --- the same shape as the real seam ----------------------------------------

pool_root() {
	local dir
	dir=$(_pool_stub_dir)
	mkdir -p -- "$dir/trees"
	printf '%s\n' "$dir/trees"
}

pool_dir() {
	local dir
	dir=$(_pool_stub_dir)
	printf '%s/%s\n' "$dir/trees" "$(_pool_stub_repo_name "${1-}")"
}

# pool_get <clone> <pool-size> <base> <branch> <holder>
pool_get() {
	local clone=${1:-} size=${2:-} base=${3:-} branch=${4:-} holder=${5:-}
	local dir slot=1 tree lease_id

	if [ -z "$clone" ] || [ -z "$size" ] || [ -z "$base" ] || [ -z "$branch" ] || [ -z "$holder" ]; then
		_pool_err "usage: pool_get <clone> <pool-size> <base> <branch> <holder>"
		return 2
	fi
	_pool_stub_record "pool_get clone=$clone size=$size base=$base branch=$branch holder=$holder"

	if [ "${YAN_STUB_POOL_FULL:-0}" != 0 ]; then
		# lib-pool's own wording, because `yan sync` recognises the pool being
		# full by matching on it (yan-sync.sh says so and pins it in its tests).
		_pool_err "the pool is full - all $size trees are leased, cannot start a new shift"
		return 1
	fi
	if [ "${YAN_STUB_POOL_GET_RC:-0}" -ne 0 ]; then
		_pool_err "stub: pool_get was programmed to fail"
		return "${YAN_STUB_POOL_GET_RC}"
	fi

	dir=$(_pool_stub_dir)
	mkdir -p -- "$dir/leases"
	while [ -f "$dir/leases/$slot.id" ]; do
		slot=$((slot + 1))
	done

	if [ -n "${YAN_STUB_POOL_PATH:-}" ]; then
		tree=$YAN_STUB_POOL_PATH
	else
		tree=$dir/trees/$slot/$(_pool_stub_repo_name "$clone")
		mkdir -p -- "$tree"
		printf 'gitdir: stub\n' >"$tree/.git"
	fi

	lease_id=${YAN_STUB_POOL_LEASE_ID:-lease-$slot}
	printf '%s\n' "$lease_id" >"$dir/leases/$slot.id"
	printf '%s\n' "$tree" >"$dir/leases/$slot.path"
	printf '%s\n' "$holder" >"$dir/leases/$slot.holder"
	printf '%s\n' "$branch" >"$dir/leases/$slot.branch"

	_pool_stub_jq -nc --arg path "$tree" --arg lease_id "$lease_id" --arg holder "$holder" \
		'{path: $path, lease_id: $lease_id, holder: $holder}'
}

# pool_return <clone> <path-or-slot> [expect-lease-id] [expect-holder]
#
# The identity comparison happens BEFORE anything is undone and answers with
# POOL_RC_MISMATCH, exactly as the real seam does - that is what a caller's
# retry logic is written against.
pool_return() {
	local clone=${1:-} target=${2:-} want_id=${3-} want_holder=${4-}
	local dir slot='' f have_id have_holder tree

	if [ -z "$clone" ] || [ -z "$target" ]; then
		_pool_err "usage: pool_return <clone> <path-or-slot> [lease-id] [holder]"
		return 2
	fi
	_pool_stub_record "pool_return clone=$clone target=$target lease_id=$want_id holder=$want_holder"

	dir=$(_pool_stub_dir)
	case $target in
	*[!0-9]*)
		for f in "$dir"/leases/*.path; do
			[ -f "$f" ] || continue
			if [ "$(tr -d ' \t\r\n' <"$f")" = "$target" ]; then
				slot=${f##*/}
				slot=${slot%.path}
				break
			fi
		done
		;;
	*)
		if [ -f "$dir/leases/$target.id" ]; then
			slot=$target
		fi
		;;
	esac

	if [ -z "$slot" ]; then
		_pool_err "no lease matches '$target'"
		return 1
	fi

	have_id=$(tr -d ' \t\r\n' <"$dir/leases/$slot.id")
	have_holder=$(tr -d ' \t\r\n' <"$dir/leases/$slot.holder")
	tree=$(tr -d ' \t\r\n' <"$dir/leases/$slot.path")

	if [ -n "$want_id" ] && [ "$want_id" != "$have_id" ]; then
		_pool_err "lease id does not match: slot $slot is held under '$have_id', not '$want_id' - nothing was touched"
		return "$POOL_RC_MISMATCH"
	fi
	if [ -n "$want_holder" ] && [ "$want_holder" != "$have_holder" ]; then
		_pool_err "holder does not match: slot $slot is held by '$have_holder', not '$want_holder' - nothing was touched"
		return "$POOL_RC_MISMATCH"
	fi

	if [ "${YAN_STUB_POOL_RETURN_RC:-0}" -ne 0 ]; then
		_pool_err "stub: pool_return was programmed to fail"
		return "${YAN_STUB_POOL_RETURN_RC}"
	fi

	rm -f -- "$dir/leases/$slot.id" "$dir/leases/$slot.path" \
		"$dir/leases/$slot.holder" "$dir/leases/$slot.branch"
	printf '%s\n' "$tree"
}

# pool_status <clone> - the leases, as the real seam's JSON array.
pool_status() {
	local clone=${1:-} dir slot
	local rows=()
	if [ -z "$clone" ]; then
		_pool_err "usage: pool_status <clone>"
		return 2
	fi
	_pool_stub_record "pool_status clone=$clone"

	if [ "${YAN_STUB_POOL_STATUS_RC:-0}" -ne 0 ]; then
		_pool_err "stub: pool_status was programmed to fail"
		return "${YAN_STUB_POOL_STATUS_RC}"
	fi

	dir=$(_pool_stub_dir)
	while IFS= read -r slot; do
		[ -n "$slot" ] || continue
		rows+=("$(_pool_stub_jq -nc \
			--argjson slot "$slot" \
			--arg path "$(tr -d ' \t\r\n' <"$dir/leases/$slot.path")" \
			--arg branch "$(tr -d ' \t\r\n' <"$dir/leases/$slot.branch")" \
			--arg holder "$(tr -d ' \t\r\n' <"$dir/leases/$slot.holder")" \
			--arg lease_id "$(tr -d ' \t\r\n' <"$dir/leases/$slot.id")" \
			'{slot: $slot, path: $path, branch: $branch, base: "", holder: $holder, lease_id: $lease_id, at: 0}')")
	done < <(pool_stub_leases)

	if [ "${#rows[@]}" -eq 0 ]; then
		printf '[]\n'
		return 0
	fi
	printf '%s\n' "${rows[@]}" | _pool_stub_jq -sc .
}
