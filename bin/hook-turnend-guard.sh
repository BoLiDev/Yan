#!/usr/bin/env bash
#
# hook-turnend-guard.sh --claude | --codex - the stub the blocking Stop hook is
# registered as. The guard itself is dist/hooks/turnend-guard.js; this finds
# $YAN_HOME, checks node is there, and execs it.
#
# Every way out of this file that is not the compiled guard's own exit status
# is 0: a guard that dies would block the turn it exists to protect.
#
set -euo pipefail

if [ -z "${YAN_HOME:-}" ] || [ ! -f "${YAN_HOME}/bin/yan" ]; then
	YAN_HOME=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
fi
export YAN_HOME

if [ ! -f "$YAN_HOME/dist/hooks/turnend-guard.js" ]; then
	printf 'yan guard: %s\n' "$YAN_HOME/dist/hooks/turnend-guard.js is missing - run 'npm run build'. This turn was not guarded" >&2
	exit 0
fi
if ! command -v node >/dev/null 2>&1; then
	printf 'yan guard: %s\n' "node is not on PATH, so the guard could not run - 'yan doctor' says where it should be. This turn was not guarded" >&2
	exit 0
fi

exec node "$YAN_HOME/dist/hooks/turnend-guard.js" "$@"
