# shellcheck shell=bash
#
# tests/fixtures.sh - build a throwaway git universe on the local filesystem.
#
# Everything goes through fx_git, which pins an identity and the default branch
# name with `git -c`, so these helpers work on a machine with no global git
# config at all (a CI container, a fresh WSL install).
#
# Nothing here touches the network.

if [ -n "${_YAN_TEST_FIXTURES_SOURCED:-}" ]; then
	return 0
fi
_YAN_TEST_FIXTURES_SOURCED=1

_YAN_FIXTURES_DIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
_YAN_FIXTURES_ROOT=$(dirname "$_YAN_FIXTURES_DIR")

# fx_git <args...> - git with a self-contained identity.
fx_git() {
	git \
		-c user.name='yan tests' \
		-c user.email='yan-tests@localhost' \
		-c init.defaultBranch=main \
		-c commit.gpgsign=false \
		-c tag.gpgsign=false \
		-c advice.detachedHead=false \
		-c protocol.file.allow=always \
		"$@"
}

# mk_bare_remote <dir> - a bare repo with one commit on main.
mk_bare_remote() {
	local bare=${1:?mk_bare_remote needs a directory} seed
	mkdir -p "$bare"
	fx_git init --bare --initial-branch=main "$bare" >/dev/null

	seed=$(mktemp -d)
	fx_git init --initial-branch=main "$seed" >/dev/null
	printf 'fixture repository\n' >"$seed/README.md"
	fx_git -C "$seed" add README.md
	fx_git -C "$seed" commit -m 'initial commit' >/dev/null
	fx_git -C "$seed" remote add origin "$bare"
	fx_git -C "$seed" push -u origin main >/dev/null 2>&1
	rm -rf "$seed"
}

# mk_clone <bare> <dir> - a working clone with a local identity configured.
mk_clone() {
	local bare=${1:?mk_clone needs a source} dir=${2:?mk_clone needs a destination}
	fx_git clone "$bare" "$dir" >/dev/null 2>&1
	fx_git -C "$dir" config user.name 'yan tests'
	fx_git -C "$dir" config user.email 'yan-tests@localhost'
	fx_git -C "$dir" config commit.gpgsign false
}

# mk_commit <dir> <relative-path> <content> [message]
mk_commit() {
	local dir=${1:?mk_commit needs a directory} rel=${2:?mk_commit needs a path} body=${3-}
	local msg="${4:-add $2}"
	mkdir -p "$dir/$(dirname "$rel")"
	printf '%s\n' "$body" >"$dir/$rel"
	fx_git -C "$dir" add -- "$rel"
	fx_git -C "$dir" commit -m "$msg" >/dev/null
}

# mk_yan_home <dir> - the runtime skeleton plus a valid conf/config.json.
#
# bin/ is copied in from the repository so the result is a complete, standalone
# $YAN_HOME: bin/yan resolves YAN_HOME from its own location, and a test can
# drop extra bin/yan-*.sh files in without touching the working tree.
mk_yan_home() {
	local dest=${1:?mk_yan_home needs a directory}
	mkdir -p "$dest/mem/learnings" "$dest/tasks" "$dest/repos" "$dest/conf"

	if [ -d "$_YAN_FIXTURES_ROOT/bin" ]; then
		mkdir -p "$dest/bin"
		cp -R "$_YAN_FIXTURES_ROOT/bin/." "$dest/bin/"
		chmod +x "$dest/bin/yan" 2>/dev/null || true
		local f
		for f in "$dest"/bin/yan-*.sh; do
			if [ -f "$f" ]; then
				chmod +x "$f" 2>/dev/null || true
			fi
		done
	fi

	cat >"$dest/conf/config.json" <<'JSON'
{
  "version": 1,
  "agents": { "yan": "claude", "shift": "claude" },
  "forge": { "kind": "github" },
  "backend": "tmux"
}
JSON

	printf '{\n  "version": 1\n}\n' >"$dest/mem/repos.json"
}

# mk_config <yan-home> <json> - overwrite conf/config.json wholesale.
mk_config() {
	local dest=${1:?mk_config needs a yan home}
	mkdir -p "$dest/conf"
	printf '%s\n' "${2:?mk_config needs JSON}" >"$dest/conf/config.json"
}

# mk_yan_dist <yan-home> - make the compiled half reachable from a bash test.
#
# mk_yan_home copies bin/ only, which is the ordinary state of a fresh clone and
# is what proves the shell fallback works. A test that USES a command already
# ported to TypeScript needs the other half as well (plan/INDEX.md rule 6: a
# ported command loses its shell twin). node_modules is linked rather than
# copied - copying it would dominate the runtime of every test that calls this.
mk_yan_dist() {
	local dest=${1:?mk_yan_dist needs a yan home}
	if [ ! -f "$_YAN_FIXTURES_ROOT/dist/cli/yan.js" ]; then
		printf 'mk_yan_dist: dist/ is not built - run `npm run build` first\n' >&2
		return 1
	fi
	mkdir -p "$dest/dist"
	cp -R "$_YAN_FIXTURES_ROOT/dist/." "$dest/dist/"
	cp "$_YAN_FIXTURES_ROOT/package.json" "$dest/package.json"
	if [ ! -e "$dest/node_modules" ]; then
		ln -s "$_YAN_FIXTURES_ROOT/node_modules" "$dest/node_modules" 2>/dev/null ||
			cmd //c mklink //J "$(cygpath -w "$dest/node_modules")" "$(cygpath -w "$_YAN_FIXTURES_ROOT/node_modules")" >/dev/null 2>&1 ||
			return 1
	fi
}
