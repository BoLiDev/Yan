#!/usr/bin/env bash
#
# Phase 1 Trace bullet 1, the static half: `yan repo-add` is the ONLY writer of
# mem/repos.json. The cloning half is in tests/integration/yan-repo-add.test.sh,
# because it needs real git.
#
# Also covers URL -> repository name derivation, which is pure string logic and
# belongs in a unit test rather than behind a clone.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"

# --- one owner for mem/repos.json ------------------------------------------
#
# design principle 2 (one owner per piece of information) and td Appendix A
# ("only through yan repo-add"). Anything else in bin/ that so much as names
# the file is a second writer waiting to happen.

owner=$YAN_REPO_ROOT/bin/yan-repo-add.sh
assert_contains "$(head -n 20 "$owner")" 'ONLY WRITER' "the header must say so out loud"
assert_ne 0 "$(grep -c 'json_edit "\$REGISTRY"' "$owner")" "and it must actually be one"

# Later phases will READ the registry (lib-pool wants pool_size, and that is
# fine). What none of them may do is write it, so the rule is checked as
# "names repos.json AND calls a lib-json writer", not as a file allowlist that
# a parallel phase would trip over for merely reading.
while IFS= read -r f; do
	[ -n "$f" ] || continue
	case ${f##*/} in
	yan-repo-add.sh) continue ;;
	esac
	assert_eq 0 "$(grep -c -E 'json_(write|edit|init)' "$f")" \
		"only yan repo-add may write mem/repos.json - ${f##*/} names it and calls a JSON writer"
done < <(grep -rn 'repos\.json' "$YAN_REPO_ROOT/bin" | grep -v ':[0-9]*:[[:space:]]*#' | cut -d: -f1 | LC_ALL=C sort -u || true)

# --- URL -> name -----------------------------------------------------------
#
# The function is lifted out of the script rather than duplicated here: the
# script is an executable that would otherwise run its whole body on source,
# and a copy of the logic in the test would prove nothing about the script.
eval "$(sed -n '/^repo_name_from_url() {/,/^}/p' "$YAN_REPO_ROOT/bin/yan-repo-add.sh")"

assert_eq monorepo-x "$(repo_name_from_url 'git@gitlab.company.internal:team/monorepo-x.git')"
assert_eq service-y "$(repo_name_from_url 'git@github.com:org/service-y.git')"
assert_eq solo "$(repo_name_from_url 'git@github.com:solo.git')"
assert_eq solo "$(repo_name_from_url 'git@github.com:solo')"
assert_eq name "$(repo_name_from_url 'https://github.com/org/name.git')"
assert_eq name "$(repo_name_from_url 'https://github.com/org/name')"
assert_eq name "$(repo_name_from_url 'https://github.com/org/name/')"
assert_eq name "$(repo_name_from_url 'https://github.com/org/name.git/')"
assert_eq name "$(repo_name_from_url 'ssh://git@host:22/org/name.git')"
assert_eq name "$(repo_name_from_url 'https://user:token@host.example/deep/org/name.git')"
assert_eq remote "$(repo_name_from_url '/srv/mirrors/remote.git')"

printf 'ok\n'
