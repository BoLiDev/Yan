import { Autocomplete } from '@base-ui/react';
import { useRef, useState } from 'react';
import { matchText } from '../lib/find';
import { before, families, installedFonts } from '../state/fonts';
import { ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxList } from './ui/combobox';

/** As many families as the list draws at once, each in its own face: the rest are a few letters away. */
const MOST = 100;

/**
 * Fonts picked by their families' names, with commas between as an editor's
 * setting has them, each drawing what those before it cannot: typed, or
 * taken from the list of those installed on this computer, each drawn in
 * itself, which Chrome gives once allowed. The list is narrowed by the name
 * being typed, the one after the last comma, and a family picked from it
 * takes that name's place, those before it kept. What is typed is taken
 * once the field is left or Enter is pressed, not at each letter, so
 * nothing is redrawn in half a name; emptied, the font is yan's own again.
 */
export function FontPick({ label, value, onPick }: { label: string; value: string; onPick: (family: string) => void }) {
  const [text, setText] = useState(value);
  // Undefined until asked for, which is when the field is first opened; null when this browser has none to give.
  const [fonts, setFonts] = useState<readonly string[] | null | undefined>(undefined);
  const lit = useRef(false);
  const all = fonts ?? [];
  // What is before the name being typed, kept as a family is picked in that name's place.
  const cut = text.lastIndexOf(',') + 1;
  const query = text.slice(cut).trim();
  const found = query === '' || text === value
    ? all
    : all.flatMap((f) => {
      const m = matchText(f, query);
      return m === undefined ? [] : [{ f, score: m.score }];
    }).sort((a, b) => b.score - a.score).map((m) => m.f);
  const shown = found.slice(0, MOST);
  const take = (typed: string): void => {
    const list = families(typed).join(', ');
    setText(list);
    if (list !== value) onPick(list);
  };
  return (
    <Autocomplete.Root items={shown} filter={null} value={text} openOnInputClick
      onItemHighlighted={(item) => { lit.current = item !== undefined; }}
      onOpenChange={(open) => {
        if (open && fonts === undefined) void installedFonts().then(setFonts);
      }}
      onValueChange={(next, details) => {
        if (details.reason === 'input-change') setText(next);
        else if (details.reason === 'item-press') take(`${text.slice(0, cut)}${next}`);
        else take(next);
      }}>
      <ComboboxInput aria-label={label} placeholder="yan's own" spellCheck={false} showTrigger={false} showClear={text !== ''} className="w-[210px] flex-none"
        style={{ fontFamily: before(value, 'inherit') }}
        onBlur={() => take(text)}
        onKeyDown={(e) => {
          // Enter on a family in the list picks it, which the list does itself; on none, takes what is typed.
          if (e.key === 'Enter' && !lit.current) take(text);
        }} />
      <ComboboxContent>
        <ComboboxEmpty>{fonts === null ? 'This browser does not list its fonts: type their names' : fonts === undefined ? 'Looking' : 'None by that name here'}</ComboboxEmpty>
        <ComboboxList aria-label={label}>
          {shown.map((f) => (
            <Autocomplete.Item key={f} value={f} style={{ fontFamily: before(f, 'inherit') }}
              className="flex w-full cursor-default items-center rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground">
              <span className="min-w-0 flex-1 truncate">{f}</span>
            </Autocomplete.Item>
          ))}
        </ComboboxList>
        {found.length > shown.length ? <div className="border-t px-2.5 py-1.5 text-xs text-ink-3">{found.length - shown.length} more, a few letters away</div> : null}
      </ComboboxContent>
    </Autocomplete.Root>
  );
}
