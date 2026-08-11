#!/usr/bin/env bash
#
# hook-autoarm.sh - Claude's Stop autoarm (td supervision.md, architecture.md
# §6). Registered in .claude/settings.json with `asyncRewake: true` and a long
# timeout. NOT registered for Codex, which parses `async` but does not run
# asynchronous command hooks and therefore cannot hold a multi-hour watcher.
#
# ---------------------------------------------------------------------------
# THIS FILE IS A STUB, AND THAT IS ALL IT IS
# ---------------------------------------------------------------------------
#
# The hook itself is `dist/hooks/autoarm.js` (Phase 6). What is left here is the
# dual dispatch and the node check, because a harness's hook entry is a path in
# a settings file and pointing it at a compiled artefact would break every tree
# that has not been built yet.
#
# It had a shell body until Phase 8, which armed supervision by running
# `bin/yan wait`. Phase 8 emptied `bin/` of command implementations, so that
# body's one dependency stopped existing: it could only ever have reported that
# it could not arm anything. A fallback that cannot do the job is worse than no
# fallback, because it looks like one.
#
# ---------------------------------------------------------------------------
# NEVER `&`. NEVER BACKGROUND. NEVER nohup / setsid / disown.
# ---------------------------------------------------------------------------
#
# The watcher runs in this hook's foreground so that THE HARNESS OWNS THE
# PROCESS GROUP. A backgrounded watcher outlives the session that armed it,
# survives the harness being killed, and is then a second watcher nobody can
# see - the failure the single-flight lock exists to prevent, made permanent.
#
# It does not read stdin. Nothing it decides depends on the harness's payload.
#
# A Stop hook that fails is a Stop hook that blocks a turn, so every way out of
# this file that is not the compiled hook's own exit status is 0.
#
set -euo pipefail

# The harness starts hooks with whatever environment the yan process had, and
# `yan continue` exports YAN_HOME and YAN_TASK into the pane it starts yan in.
# When YAN_HOME is missing or points somewhere else, this file's own location
# is the answer: hooks ship inside $YAN_HOME/bin.
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
