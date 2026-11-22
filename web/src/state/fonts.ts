import { MONO } from '../views/terminal/look';
import { useUI } from './ui';

/**
 * The faces this browser was told to draw in (prefs.font, prefs.termFont):
 * a list of families by name with commas between, as an editor's setting
 * has it, each drawing what those before it have no glyph for, a Latin
 * face and then a Chinese one say. A list is all there is: the settings
 * show yan's own to start from, to be added to or changed, and a browser
 * that changed nothing keeps none, so it follows yan's own as that changes.
 */

/** The page's own list, as index.css has it: `Yan Round` is ChillRound, an installed copy before yan's. */
export const PAGE_FONTS = 'Yan Round, PingFang SC, Microsoft YaHei, system-ui, sans-serif';

/** A terminal's own list: `Yan Code` is 0xProto, likewise. */
export const TERM_FONTS = MONO;

/** The names CSS has for a kind of face, not a family, which are written as they are. */
const KINDS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded']);

/** The families of a list as it was typed, in order, each once: commas between them, quotes around one or not. */
export function families(list: string): string[] {
  const seen = new Set<string>();
  return list.split(',').map((f) => f.replace(/["'\\\n\r]/g, '').trim()).filter((f) => {
    const key = f.toLowerCase();
    if (f === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A list as CSS takes it. */
export const css = (list: string): string => families(list).map((f) => (KINDS.has(f.toLowerCase()) ? f.toLowerCase() : `"${f}"`)).join(', ');

/** What a terminal is drawn in now: the list kept, or its own. */
export const termFace = (list: string): string => css(families(list).length === 0 ? TERM_FONTS : list);

function apply(): void {
  const { font } = useUI.getState().prefs;
  const root = document.documentElement;
  if (families(font).length === 0) root.style.removeProperty('--font');
  else root.style.setProperty('--font', css(font));
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
