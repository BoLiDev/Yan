/**
 * What `user` has typed into a harness's prompt box and not sent yet, read
 * off the screen `herdr agent read --format ansi` gives. `''` is a box that
 * is there and empty; `undefined` is no box this can make out — a dialog is
 * up, the transcript viewer is open, or a harness whose screen this does not
 * know — so the caller has nothing to wait for.
 *
 * One recogniser per harness, because each draws its input differently:
 *
 *   claude   the last stretch between two horizontal rules whose first line
 *            opens with `❯`; a long entry wraps onto the lines below it.
 *   codex    the last line opening with `›` (earlier ones are history), plus
 *            the two-space-indented lines under it up to the next blank one.
 *            An empty box shows a placeholder, "Ask Codex to do anything",
 *            drawn dim — which is why the screen is read with its styling.
 *   agy      not known: always `undefined`.
 */

/** Every CSI sequence: colours, cursor moves, the lot. */
const CSI = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;

export function stripAnsi(text: string): string {
  return text.replace(CSI, '');
}

/**
 * The characters of one line that are not drawn dim, escape codes removed.
 * Tracks SGR 2 / 22 / 0, stepping over the extended-colour forms `38;5;n`
 * and `38;2;r;g;b` whose parameters would otherwise read as a `2`.
 */
function undimmed(line: string): string {
  let dim = false;
  let out = '';
  let last = 0;
  for (const m of line.matchAll(CSI)) {
    if (!dim) out += line.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[3] !== 'm') continue;
    const params = (m[1] === '' ? '0' : m[1]).split(';');
    for (let i = 0; i < params.length; i += 1) {
      const p = params[i];
      if (p === '0' || p === '' || p === '22') dim = false;
      else if (p === '2') dim = true;
      else if (p === '38' || p === '48' || p === '58') {
        i += params[i + 1] === '5' ? 2 : params[i + 1] === '2' ? 4 : 0;
      }
    }
  }
  if (!dim) out += line.slice(last);
  return out;
}

function claudeTyped(screen: string): string | undefined {
  const lines = screen.split('\n').map(stripAnsi);
  const isRule = (line: string): boolean => /^\s*─{8,}\s*$/.test(line);

  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isRule(lines[i] ?? '')) {
      bottom = i;
      break;
    }
  }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i -= 1) {
    if (isRule(lines[i] ?? '')) {
      top = i;
      break;
    }
  }
  if (top < 0) return undefined;

  const body = lines.slice(top + 1, bottom);
  const first = (body[0] ?? '').trimStart();
  if (!first.startsWith('❯')) return undefined;
  return [first.slice(1), ...body.slice(1)]
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}

function codexTyped(screen: string): string | undefined {
  const raw = screen.split('\n');
  const plain = raw.map(stripAnsi);

  let marker = -1;
  for (let i = plain.length - 1; i >= 0; i -= 1) {
    if ((plain[i] ?? '').startsWith('›')) {
      marker = i;
      break;
    }
  }
  if (marker < 0) return undefined;

  // The placeholder is dim and the typed text is not, so only what is not
  // dim on the marker line counts. The wrapped lines under it carry no
  // placeholder and are read plain.
  const parts = [undimmed(raw[marker] ?? '').replace(/^›/, '').trim()];
  for (let i = marker + 1; i < plain.length; i += 1) {
    const line = plain[i] ?? '';
    if (line.trim() === '' || !line.startsWith('  ')) break;
    parts.push(line.trim());
  }
  return parts.filter((part) => part !== '').join(' ');
}

export function typedInput(kind: string, screen: string): string | undefined {
  switch (kind) {
    case 'claude':
      return claudeTyped(screen);
    case 'codex':
      return codexTyped(screen);
    default:
      return undefined;
  }
}
