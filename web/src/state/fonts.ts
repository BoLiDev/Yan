import { MONO } from '../views/terminal/look';
import { useUI } from './ui';

/**
 * The faces this browser was told to draw in (prefs.font, prefs.termFont):
 * any family installed on the computer the browser runs on, by its name,
 * put before yan's own, which still draw what the picked one has no glyph
 * for, Chinese in a Latin face say, and all of it when no such family is
 * installed. Unset, yan's own alone.
 */

/** The page's own face, as index.css has it, which a picked one goes before. */
const OWN = '"Yan Round", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

/** A family's name as CSS takes it, whatever was typed. */
const quoted = (family: string): string => `"${family.replace(/["\\\n\r]/g, '')}"`;

/** `family` before `rest`, or `rest` alone when none was picked. */
export const before = (family: string, rest: string): string => (family.trim() === '' ? rest : `${quoted(family.trim())}, ${rest}`);

/** What a terminal is drawn in now. */
export const termFace = (family: string): string => before(family, MONO);

function apply(): void {
  const { font } = useUI.getState().prefs;
  const root = document.documentElement;
  if (font.trim() === '') root.style.removeProperty('--font');
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
    const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    return families.length === 0 ? null : families;
  } catch {
    return null;
  }
}
