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
# fine), and will NAME it in comments and error messages. Neither makes them a
# writer.
#
# The rule has to be checked per LINE, not per file. "This file mentions
# repos.json somewhere and also calls a JSON writer somewhere" is far too
# coarse: lib-pool.sh writes lease files and merely explains in a comment why
# it does not read the registry, and a per-file check flags it for that comment
# - punishing the code for documenting its own compliance. Two narrower
# questions are the real rule:
#
#   1. no line that names repos.json may also call a JSON writer, and
#   2. no variable holding a repos.json path may be passed to a JSON writer.
#
# (2) is what makes this more than a spelling check: yan-repo-add.sh itself
# writes through `json_edit "$REGISTRY"`, so a copy of that pattern elsewhere
# is exactly the second writer we are trying to prevent.

writers='json_(write|edit|init)'

# 1. writer and registry on the same line.
while IFS= read -r hit; do
	[ -n "$hit" ] || continue
	case ${hit%%:*} in
	*/yan-repo-add.sh) continue ;;
	esac
	_assert_die "only yan repo-add may write mem/repos.json" "offending line: $hit"
done < <(grep -rnE "repos\.json" "$YAN_REPO_ROOT/bin" |
	grep -vE ':[0-9]+:[[:space:]]*#' |
	grep -E "$writers" || true)

# 2. a variable assigned a repos.json path, then handed to a writer.
while IFS= read -r f; do
	[ -n "$f" ] || continue
	case ${f##*/} in
	yan-repo-add.sh) continue ;;
	esac
	# Variables in this file that hold a repos.json path.
	vars=$(grep -oE '^[[:space:]]*(local[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=[^=]*repos\.json' "$f" |
		sed -E 's/^[[:space:]]*(local[[:space:]]+)?//; s/=.*//' | LC_ALL=C sort -u || true)
	[ -n "$vars" ] || continue
	while IFS= read -r v; do
		[ -n "$v" ] || continue
		if grep -qE "${writers}[[:space:]]+\"?\\\$\{?$v\b" "$f"; then
			_assert_die "only yan repo-add may write mem/repos.json" \
				"file:     ${f##*/}" "variable: \$$v holds a repos.json path and is passed to a JSON writer"
		fi
	done <<EOF
$vars
EOF
done < <(find "$YAN_REPO_ROOT/bin" -type f -name '*.sh' -o -type f -name 'yan' | LC_ALL=C sort || true)

# The check must have teeth: prove pattern (2) fires on the owner itself, which
# is the one file legitimately doing it.
assert_ne 0 "$(grep -cE "${writers}[[:space:]]+\"?\\\$\{?REGISTRY\b" "$owner")" \
	"the \$REGISTRY-to-writer pattern the check looks for must exist in the owner"

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
