/**
 * Telling Herdr what it is looking at (display.md §4).
 *
 * ---------------------------------------------------------------------------
 * THESE CALLS ARE NEVER FATAL
 * ---------------------------------------------------------------------------
 *
 * Herdr receives presentation, never truth. `task.json` remains the only record
 * of which unit is on which branch; a token or a title is a copy for human
 * eyes, and a copy that goes stale is a cosmetic bug rather than a correctness
 * one.
 *
 * So every call goes through here, and here swallows the failure into one line
 * on stderr. An orchestrator that will not dispatch a shift because a title did
 * not stick is a worse orchestrator (orchestration.md §3), and the way to make
 * sure nobody writes that by accident is to give the calls one door that cannot
 * throw.
 */
export function display(what: string, call: () => void): void {
  try {
    call();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`yan: ${what} (display only, carrying on): ${message}\n`);
  }
}
