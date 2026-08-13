#!/usr/bin/env bash
#
# hook-autoarm.sh - the stub Claude's Stop autoarm hook is registered as.
# The hook itself is dist/hooks/autoarm.js; this finds $YAN_HOME, checks node
# is there, and execs it.
#
# NEVER `&`, never background, never nohup / setsid / disown: the watcher runs
# in this hook's foreground so the harness owns its process group.
#
# Every way out of this file that is not the compiled hook's own exit status
# is 0, because a Stop hook that fails blocks a turn.
#
set -euo pipefail

# An exported YAN_HOME wins, but only when it really is a yan home; this
# file's own location is the fallback.
if [ -z "${YAN_HOME:-}" ] || [ ! -f "${YAN_HOME}/bin/yan" ]; then
	YAN_HOME=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
fi
export YAN_HOME

if [ ! -f "$YAN_HOME/dist/hooks/autoarm.js" ]; then
	printf 'yan autoarm: %s\n' "$YAN_HOME/dist/hooks/autoarm.js is missing - run 'npm run build'. Supervision was not armed for this turn" >&2
	exit 0
fi
if ! command -v node >/dev/null 2>&1; then
	printf 'yan autoarm: %s\n' "node is not on PATH, so the hook could not run - 'yan doctor' says where it should be. Supervision was not armed for this turn" >&2
	exit 0
fi

exec node "$YAN_HOME/dist/hooks/autoarm.js" "$@"
