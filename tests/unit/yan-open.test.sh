#!/usr/bin/env bash
#
# `yan open <id> [--artifacts]` prints the absolute path, hands it to an
# opener when there is one, and treats "there is no opener on this machine" as
# success rather than failure.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

home=$tmp/home
mk_yan_home "$home"
YAN_HOME=$home
export YAN_HOME
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t042 'unify the auth header'

# A recorder standing in for explorer.exe / xdg-open.
opener=$tmp/opener.sh
cat >"$opener" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$1" >>"$tmp/opened"
EOF
chmod +x "$opener"

# --- the task directory ----------------------------------------------------

capture env YAN_OPENER="$opener" bash "$yan" open t042
assert_eq 0 "$rc"
assert_eq "$home/tasks/t042" "$out" "the absolute path is always printed"
assert_eq "$home/tasks/t042" "$(tail -n 1 "$tmp/opened")"

# --- artifacts -------------------------------------------------------------

assert_file_missing "$home/tasks/t042/artifacts"
capture env YAN_OPENER="$opener" bash "$yan" open t042 --artifacts
assert_eq 0 "$rc"
assert_eq "$home/tasks/t042/artifacts" "$out"
assert_file_exists "$home/tasks/t042/artifacts"

# --- no opener at all is still success ------------------------------------
#
# The fallback is the whole point: printing the path must never be treated as
# a failure. An opener that does not exist is the closest a test can get to a
# machine with none.
capture env YAN_OPENER="$tmp/definitely-not-a-command" bash "$yan" open t042
assert_eq 0 "$rc"
assert_eq "$home/tasks/t042" "$out"

# --- errors ---------------------------------------------------------------

assert_fail bash "$yan" open
assert_fail bash "$yan" open nosuchtask
assert_fail bash "$yan" open t042 --nope
assert_fail bash "$yan" open t042 t007

printf 'ok\n'
