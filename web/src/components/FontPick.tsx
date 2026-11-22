import { Autocomplete } from '@base-ui/react';
import { useRef, useState } from 'react';
import { matchText } from '../lib/find';
import { css, families, installedFonts } from '../state/fonts';
import { ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxList } from './ui/combobox';

/** As many families as the list draws at once, each in its own face: the rest are a few letters away. */
const MOST = 100;

/**
 * A list of fonts by their families' names, with commas between as an
 * editor's setting has it, each drawing what those before it cannot. The
 * field holds the list in use, yan's `own` until it is changed, so a
 * reader adds to what is there; emptied, or reset by its ✕, it is yan's own
 * again, and `value`, what the browser keeps, is empty.
 *
 * A name is typed, or taken from the list of fonts installed on this
 * computer, each drawn in itself, which Chrome gives once allowed. Opened
 * and not typed in, a family picked goes to the front. Typed in, the list
 * is narrowed by the letters before the caret, back to the last comma, and
 * a family picked takes their place, a comma put after it where a name
 * follows: so letters typed at the very front, or anywhere between two
 * names, find a font and add it there. What is typed is taken once the field is left or Enter is
 * pressed, not at each letter, so nothing is redrawn in half a name.
 */
export function FontPick({ label, value, own, onPick }: { label: string; value: string; own: string; onPick: (list: string) => void }) {
  const used = value === '' ? own : value;
  const [text, setText] = useState(used);
  const [caret, setCaret] = useState(0);
  // Undefined until asked for, which is when the field is first opened; null when this browser has none to give.
  const [fonts, setFonts] = useState<readonly string[] | null | undefined>(undefined);
  const lit = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const all = fonts ?? [];
  // The name being typed: what is between the comma before the caret and the caret. What follows the caret up to the
  // next comma is a name already there when letters are typed in front of it, with no comma yet between the two.
  const from = text.lastIndexOf(',', Math.max(0, caret - 1)) + 1;
  const comma = text.indexOf(',', caret);
  const to = comma === -1 ? text.length : comma;
  const query = text.slice(from, caret).trim();
  const after = text.slice(caret, to).trim() === '' ? text.slice(to) : `, ${text.slice(caret)}`;
  const typing = text !== used;
  const found = query === '' || !typing
    ? all
    : all.flatMap((f) => {
      const m = matchText(f, query);
      return m === undefined ? [] : [{ f, score: m.score }];
    }).sort((a, b) => b.score - a.score).map((m) => m.f);
  const shown = found.slice(0, MOST);
  const take = (typed: string): void => {
    const list = families(typed).join(', ') || own;
    setText(list);
    const keep = list === own ? '' : list;
    if (keep !== value) onPick(keep);
  };
  return (
    <Autocomplete.Root items={shown} filter={null} value={text} openOnInputClick
      onItemHighlighted={(item) => { lit.current = item !== undefined; }}
      onOpenChange={(open) => {
        if (open && fonts === undefined) void installedFonts().then(setFonts);
      }}
      onValueChange={(next, details) => {
        if (details.reason === 'input-change') {
          setText(next);
          setCaret(input.current?.selectionStart ?? next.length);
        } else if (details.reason === 'item-press') take(typing ? `${text.slice(0, from)}${next}${after}` : `${next}, ${text}`);
        else take(next);
      }}>
      <ComboboxInput ref={input} aria-label={label} title={used} spellCheck={false} showTrigger={false} showClear={used !== own} className="w-full"
        style={{ fontFamily: css(used) }}
        onBlur={() => take(text)}
        onKeyDown={(e) => {
          // Enter on a family in the list picks it, which the list does itself; on none, takes what is typed.
          if (e.key === 'Enter' && !lit.current) take(text);
        }} />
      <ComboboxContent>
        <ComboboxEmpty>{fonts === null ? 'This browser does not list its fonts: type their names' : fonts === undefined ? 'Looking' : 'None by that name here'}</ComboboxEmpty>
        <ComboboxList aria-label={label}>
          {shown.map((f) => (
            <Autocomplete.Item key={f} value={f} style={{ fontFamily: css(f) }}
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
