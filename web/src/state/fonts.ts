import { MONO } from '../views/terminal/look';
import { useUI } from './ui';

/**
 * The faces this browser was told to draw in (prefs.font, prefs.termFont):
 * families installed on the computer the browser runs on, by name, several
 * with commas between as an editor's setting has them, each drawing what
 * those before it have no glyph for, a Latin face and then a Chinese one
 * say. They are put before yan's own, which draw what none of them has,
 * and all of it when no such family is installed. Unset, yan's own alone.
 */

/** The page's own face, as index.css has it, which a picked one goes before. */
const OWN = '"Yan Round", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** The names CSS has for a kind of face, not a family, which are written as they are. */
const KINDS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded']);

/** The families of a list as it was typed, in order: commas between them, quotes around one or not. */
export const families = (list: string): string[] => list.split(',').map((f) => f.replace(/["'\\\n\r]/g, '').trim()).filter((f) => f !== '');

/** A family's name as CSS takes it. */
const quoted = (family: string): string => (KINDS.has(family.toLowerCase()) ? family.toLowerCase() : `"${family}"`);

/** The families of `list` before `rest`, or `rest` alone when none was picked. */
export const before = (list: string, rest: string): string => [...families(list).map(quoted), rest].join(', ');

/** What a terminal is drawn in now. */
export const termFace = (list: string): string => before(list, MONO);

function apply(): void {
  const { font } = useUI.getState().prefs;
  const root = document.documentElement;
  if (families(font).length === 0) root.style.removeProperty('--font');
  else root.style.setProperty('--font', before(font, OWN));
}

/** Draw the page in the face asked for, and keep doing so as it is changed. */
export function followFonts(): void {
  apply();
  useUI.subscribe((s, was) => {
    if (s.prefs.font !== was.prefs.font) apply();
  });
}

interface LocalFont { readonly family: string }

/**
 * The families installed on this computer, by name, as Chrome lists them
 * once it is allowed to (it asks the first time); null where the browser
 * has no such list or was told no, and a name is typed instead.
 */
export async function installedFonts(): Promise<readonly string[] | null> {
  const query = (window as { queryLocalFonts?: () => Promise<readonly LocalFont[]> }).queryLocalFonts;
  if (typeof query !== 'function') return null;
  try {
    const fonts = await query.call(window);
    const names = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    return names.length === 0 ? null : names;
  } catch {
    return null;
  }
}
