#!/usr/bin/env bash
#
# yan repo-add <url> - register a repository and clone it into repos/.
#
# THIS SCRIPT IS THE ONLY WRITER OF mem/repos.json (td Appendix A, Appendix B).
# Nothing else in bin/ may create, edit or delete that file; tests/unit greps
# for it. The registry has one owner because it has one point of truth for
# "which repositories does this machine know about", and design principle 2
# says one owner per piece of information.
#
# Registry shape (td Appendix D): the file is an object keyed by repository
# name, alongside the mandatory `version` field.
#
#   { "version": 1,
#     "monorepo-x": { "url": "...", "mode_default": "mr", "pool_size": 8 } }
#
# Two behaviours worth stating up front:
#
#   * Idempotent. Re-adding a repository never clobbers a `mode_default` or
#     `pool_size` that user has tuned. Only an explicit flag changes them.
#   * It never re-clones over an existing clone. If repos/<name> is already a
#     clone of the same URL the clone step is skipped; if it is anything else
#     the command refuses rather than deleting and retrying.
#
set -euo pipefail

: "${YAN_HOME:?yan-repo-add: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-json.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-json.sh"
# shellcheck source=bin/lib-git.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"

REGISTRY=$YAN_HOME/mem/repos.json
REPOS_DIR=$YAN_HOME/repos

MODE_DEFAULT=mr # td delivery.md §8.2
POOL_SIZE=8     # td worktree.md §7

die() {
	printf 'repo-add: %s\n' "$1" >&2
	exit "${2:-1}"
}

usage() {
	cat <<'EOF'
usage: yan repo-add <url> [--name <name>] [--mode-default scout|branch|mr]
                          [--pool-size <n>]

Registers a repository in mem/repos.json and clones it into repos/<name>.
The name is derived from the URL unless --name is given.
EOF
}

# repo_name_from_url <url>
#
# Handles both spellings user's forges hand out:
#   git@host:org/name.git      ssh://git@host:22/org/name.git
#   https://host/org/name.git  https://host/org/name/
repo_name_from_url() {
	local u=${1:-} name
	while [ "${u%/}" != "$u" ]; do
		u=${u%/}
	done
	u=${u%.git}
	name=${u##*/} # strip everything up to the last path separator
	name=${name##*:} # scp-style with no org: git@host:name
	printf '%s\n' "$name"
}

# same_url <a> <b>
#
# conventions §2.3: on Git Bash the shell says /tmp/x and git.exe says
# C:/Users/.../Temp/x for the same local path, so a URL we built and a URL git
# printed back cannot be compared as plain strings. Remote URLs (git@...,
# https://...) have no such problem and are compared verbatim.
same_url() {
	local a=${1-} b=${2-}
	[ "$a" = "$b" ] && return 0
	command -v cygpath >/dev/null 2>&1 || return 1
	case $a in
	/* | [A-Za-z]:[\\/]*) a=$(cygpath -m -- "$a" 2>/dev/null || printf '%s' "${1-}") ;;
	esac
	case $b in
	/* | [A-Za-z]:[\\/]*) b=$(cygpath -m -- "$b" 2>/dev/null || printf '%s' "${2-}") ;;
	esac
	[ "$a" = "$b" ]
}

url=
name=
mode_flag=
pool_flag=

while [ $# -gt 0 ]; do
	case $1 in
	-h | --help)
		usage
		exit 0
		;;
	--name)
		name=${2:-}
		shift 2 || die "--name needs a value" 2
		;;
	--mode-default)
		mode_flag=${2:-}
		shift 2 || die "--mode-default needs a value" 2
		;;
	--pool-size)
		pool_flag=${2:-}
		shift 2 || die "--pool-size needs a value" 2
		;;
	-*)
		usage >&2
		die "unknown option: $1" 2
		;;
	*)
		if [ -n "$url" ]; then
			usage >&2
			die "only one URL may be given" 2
		fi
		url=$1
		shift
		;;
	esac
done

[ -n "$url" ] || {
	usage >&2
	die "a clone URL is required" 2
}

if [ -z "$name" ]; then
	name=$(repo_name_from_url "$url")
fi

case $name in
'' | *[!A-Za-z0-9._-]*)
	die "cannot derive a usable repository name from '$url' - pass --name" 2
	;;
version)
	# The registry keeps repositories at the top level beside `version`
	# (td Appendix D), so that one name is not available.
	die "'version' is not a usable repository name - pass --name" 2
	;;
esac

if [ -n "$mode_flag" ]; then
	case $mode_flag in
	scout | branch | mr) ;;
	*) die "invalid --mode-default '$mode_flag' - one of: scout branch mr" 2 ;;
	esac
fi

if [ -n "$pool_flag" ]; then
	case $pool_flag in
	'' | *[!0-9]*) die "invalid --pool-size '$pool_flag' - a positive integer" 2 ;;
	esac
	[ "$pool_flag" -gt 0 ] || die "invalid --pool-size '$pool_flag' - a positive integer" 2
fi

mkdir -p -- "$REPOS_DIR" "$(dirname -- "$REGISTRY")"
json_init "$REGISTRY" '{"version": 1}' || die "cannot create $REGISTRY"

# Reading is plain jq; lib-json owns WRITING (tmp -> mv plus the version
# field), and json_read takes no jq arguments of its own.
registered_url=$(jq -r --arg n "$name" '.[$n].url // ""' "$REGISTRY") ||
	die "cannot read $REGISTRY"

if [ -n "$registered_url" ] && ! same_url "$registered_url" "$url"; then
	die "'$name' is already registered as $registered_url - pass --name to register $url under a different name"
fi

dest=$REPOS_DIR/$name

if [ -e "$dest" ]; then
	existing=$(git_remote_url "$dest" origin 2>/dev/null) || existing=
	if ! same_url "$existing" "$url"; then
		die "$dest already exists and is not a clone of $url (origin: ${existing:-none}) - move it aside first; repo-add never clones over an existing directory"
	fi
	printf 'repo-add: %s already exists, keeping it (no re-clone)\n' "$dest"
else
	printf 'repo-add: cloning %s into %s\n' "$url" "$dest"
	git_clone "$REPOS_DIR" "$url" "$name" || die "clone failed: $url"
fi

# Write the registry last, and only ever merge: an entry that is already there
# keeps every field it has unless a flag was passed for it.
json_edit "$REGISTRY" '
		.[$n] = (
			(.[$n] // {})
			| .url = $url
			| .mode_default = (if $mode == "" then (.mode_default // $dm) else $mode end)
			| .pool_size    = (if $pool == "" then (.pool_size // $dp) else ($pool | tonumber) end)
		)' \
	--arg n "$name" --arg url "$url" \
	--arg mode "$mode_flag" --arg pool "$pool_flag" \
	--arg dm "$MODE_DEFAULT" --argjson dp "$POOL_SIZE" ||
	die "cannot update $REGISTRY"

jq -r --arg n "$name" \
	'"repo-add: \($n)  url=\(.[$n].url)  mode_default=\(.[$n].mode_default)  pool_size=\(.[$n].pool_size)"' \
	"$REGISTRY"
