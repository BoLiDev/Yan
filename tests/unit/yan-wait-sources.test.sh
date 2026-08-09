#!/usr/bin/env bash
#
# Phase 8 Trace bullet 1 and 5: `yan wait` watches THREE sources - run/signal,
# term_agent_alive and the pane's content hash - and there is no fourth.
#
# The seam is swapped by dropping tests/stub/lib-term.sh into the throwaway
# home's own bin/, the way tests/unit/yan-state.test.sh does: YAN_LIB is
# directory-wide and this subcommand also sources lib-watch, lib-shift and
# lib-task, which the stub directory does not hold.
#
# Nothing here sleeps for 180 seconds. Every interval is injected: --interval
# 0.1, --stuck 1, --seconds 3. A stuck pane is a fixture whose line does not
# change; a moving pane is the same fixture with sixty different lines
# (YAN_STUB_TERM_READ_SEQ).
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
cp "$YAN_REPO_ROOT/tests/stub/lib-term.sh" "$home/bin/lib-term.sh"

YAN_HOME=$home
export YAN_HOME
export YAN_STUB_TERM_DIR=$tmp/term
export YAN_TASK=t1
yan=$home/bin/yan

# shellcheck source=bin/lib-task.sh
. "$YAN_REPO_ROOT/bin/lib-task.sh"

task_init t1 'supervision'

run=$home/tasks/t1/shifts/s1/run
mkdir -p "$run"
cat >"$run/meta.json" <<'JSON'
{ "version": 1, "sid": "s1", "unit": "u", "branch": "yan/t1/s1", "tree": "",
  "agent": "claude", "window": "@3", "pane": "%7", "mr": "" }
JSON

wake=$home/tasks/t1/run/wake

reset_run() {
	rm -f -- "$wake" "$run/signal"
	rm -rf -- "$tmp/term"
}

# --- the sources are enumerable, and there are three ------------------------
#
# Trace bullet 5, asserted structurally: `yan wait` prints its own list, and
# the list is the one td supervision.md gives. A fourth source cannot be added
# without either changing this assertion or leaving the list lying.

capture "$yan" wait --sources
assert_eq 0 "$rc"
assert_eq 'signal
agent-alive
pane-hash' "$out" 'yan wait watches exactly these three'
assert_eq 3 "$(printf '%s\n' "$out" | grep -c .)"

# And no fourth one has crept in under another name: td supervision.md rules
# out a source that polls pull requests or CI by name, so the forge must not be
# reachable from this file at all.
for forbidden in forge_ lib-forge ci_state mr_state 'gh pr' 'gh api' glab pull_request; do
	capture grep -n -- "$forbidden" "$YAN_REPO_ROOT/bin/yan-wait.sh"
	assert_ne 0 "$rc" "yan wait must not poll the forge: found '$forbidden'"
done

# --- source 1: run/signal ---------------------------------------------------

reset_run
touch "$run/signal"
capture "$yan" wait --seconds 5 --interval 0.1
assert_eq 0 "$rc" 'a reported shift is an actionable event'
assert_contains "$out" 'signal: s1'
assert_file_exists "$wake" 'the reason has to survive until the model drains'
assert_contains "$(cat "$wake")" 'signal: s1'

# The signal is an EDGE: consumed once the reason is written down, or every
# later watcher would fire on it again for ever.
assert_file_missing "$run/signal"

# --- source 2: term_agent_alive ---------------------------------------------

reset_run
capture env YAN_STUB_TERM_ALIVE=dead "$yan" wait --seconds 5 --interval 0.1
assert_eq 0 "$rc" 'an agent that died cannot report that itself'
assert_contains "$out" 'died: s1'
assert_contains "$(cat "$wake")" 'died: s1'

# A LEVEL, not an edge: the agent is still dead. With the reason still sitting
# undrained in the wake file, a rearmed watcher must not wake the model again.
capture env YAN_STUB_TERM_ALIVE=dead "$yan" wait --seconds 1 --interval 0.1
assert_eq 124 "$rc" 'an undrained reason must not be raised a second time'

# Once it has been drained, the fact is news again.
capture "$yan" drain t1
assert_eq 0 "$rc"
assert_contains "$out" 'died: s1'
capture env YAN_STUB_TERM_ALIVE=dead "$yan" wait --seconds 5 --interval 0.1
assert_eq 0 "$rc"
assert_contains "$out" 'died: s1'

# `unknown` is never rounded up to `dead`: where the terminal cannot tell, yan
# says so and keeps watching.
reset_run
capture env YAN_STUB_TERM_ALIVE=unknown "$yan" wait --seconds 1 --interval 0.1
assert_eq 124 "$rc" "'unknown' is not an event"

# --- source 3: the pane's content hash --------------------------------------

reset_run
printf 'the agent is sitting at a dialog\n' >"$tmp/frozen"
capture env YAN_STUB_TERM_ALIVE=alive YAN_STUB_TERM_READ_SEQ=$tmp/frozen \
	"$yan" wait --seconds 8 --interval 0.1 --stuck 1
assert_eq 0 "$rc" 'a pane that stops changing is the third source'
assert_contains "$out" 'stuck: s1'
assert_contains "$(cat "$wake")" 'stuck: s1'

# A pane that keeps moving is not stuck, however long the wait runs.
reset_run
: >"$tmp/moving"
i=0
while [ "$i" -lt 60 ]; do
	printf 'frame %s\n' "$i" >>"$tmp/moving"
	i=$((i + 1))
done
capture env YAN_STUB_TERM_ALIVE=alive YAN_STUB_TERM_READ_SEQ=$tmp/moving \
	"$yan" wait --seconds 2 --interval 0.1 --stuck 1
assert_eq 124 "$rc" 'a moving pane must not be reported as stuck'
assert_file_missing "$wake"

# --- the quiet ends ---------------------------------------------------------

# Bounded and still responsible: exit 124, and nothing is written, so the model
# drains, finds nothing and starts another slice.
reset_run
capture env YAN_STUB_TERM_ALIVE=alive "$yan" wait --seconds 1 --interval 0.1 --stuck 3600
assert_eq 124 "$rc"
assert_file_missing "$wake"

# --- the checkpoint slice's default length ----------------------------------
#
# `--seconds` with no value is the Codex checkpoint: 180 seconds, overridable
# through $YAN_CODEX_CHECKPOINT (td supervision.md). Proven with a one-second
# checkpoint, because a test that proved it with the real default would be the
# three-minute sleep this suite must not contain.

reset_run
capture env YAN_CODEX_CHECKPOINT=7 "$yan" wait --help
assert_eq 0 "$rc"
assert_contains "$out" 'currently 7'

capture env YAN_CODEX_CHECKPOINT=1 YAN_STUB_TERM_ALIVE=alive \
	"$yan" wait --seconds --interval 0.1 --stuck 3600
assert_eq 124 "$rc" '$YAN_CODEX_CHECKPOINT sets how long a slice lasts'

# Nothing left to supervise. The unbounded shape is SILENT - no stdout, no wake
# file, no model wake (td supervision.md).
reset_run
rm -rf -- "$run"
capture "$yan" wait --interval 0.1
assert_eq 3 "$rc"
assert_eq '' "$out" 'a quiet end without --seconds wakes nobody'
assert_file_missing "$wake"

# The bounded shape says so, because the Codex model is the caller and has to
# know to stop slicing.
capture "$yan" wait --seconds 2 --interval 0.1
assert_eq 3 "$rc"
assert_contains "$out" 'nothing to supervise'

# --- arguments --------------------------------------------------------------

capture "$yan" wait --seconds 0
assert_eq 2 "$rc"
capture env -u YAN_TASK "$yan" wait
assert_eq 2 "$rc"
assert_contains "$out" 'cannot tell which task'
capture "$yan" wait --nonsense
assert_eq 2 "$rc"

printf 'ok\n'
