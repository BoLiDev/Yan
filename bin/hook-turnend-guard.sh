#!/usr/bin/env bash
#
# hook-turnend-guard.sh --claude | --codex - the blocking Stop hook
# (td supervision.md, architecture.md §6).
#
# ---------------------------------------------------------------------------
# THIS FILE IS A STUB, AND THAT IS ALL IT IS
# ---------------------------------------------------------------------------
#
# The guard itself is `dist/hooks/turnend-guard.js` (Phase 6). What is left here
# is the dispatch and the node check, because a harness's hook entry is a path
# in a settings file and pointing it at a compiled artefact would break every
# tree that has not been built yet.
#
# It had a shell body until Phase 9, which asked lib-watch.sh the same questions
# the compiled guard asks. That library is gone, and with it the last reason to
# keep a second implementation of a decision this delicate in a second language.
#
# A GUARD THAT DIES BLOCKS THE TURN IT EXISTS TO PROTECT, which is the opposite
# of failing open - so every way out of this file that is not the compiled
# guard's own exit status is 0, and each says why on stderr.
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
