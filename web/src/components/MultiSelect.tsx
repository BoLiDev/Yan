import { useState } from 'react';
import { matchText } from '../lib/find';
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from './ui/combobox';
import { Marked } from './Palette';

/**
 * A select of several, Base UI's combobox: what is picked as chips in the
 * field, with a search typed beside them, which narrows the list as ⌘K
 * narrows the tasks, best first, the letters matched marked. A click on an
 * option picks or drops it and keeps the list open; Enter picks the one the
 * keyboard is on, then the list closes and the search clears, so the next
 * Enter is the form's. Backspace in an empty search drops the last chip;
 * Escape closes the list before anything else.
 */
export function MultiSelect({ options, value, onChange, empty, label, autoFocus = false }: {
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** What the field says with nothing picked, when that means something. */
  empty?: string;
  label: string;
  autoFocus?: boolean;
}) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState('');
  // Taking the keyboard as its step comes, it shows what there is to pick at once.
  const [open, setOpen] = useState(autoFocus);
  const shown = query.trim() === ''
    ? options.map((o) => ({ value: o, marks: [] as readonly (readonly [number, number])[], score: 0 }))
    : options.flatMap((o) => {
      const m = matchText(o, query);
      return m === undefined ? [] : [{ value: o, marks: m.marks, score: m.score }];
    }).sort((a, b) => b.score - a.score);
  return (
    <Combobox multiple items={shown.map((o) => o.value)} filter={null} value={[...value]} autoHighlight open={open} onOpenChange={setOpen}
      inputValue={query} onInputValueChange={setQuery}
      onValueChange={(next, details) => {
        onChange([...next]);
        // Picked with Enter, the list has done its work; a click keeps it open for the next.
        if (details.event instanceof KeyboardEvent) {
          setQuery('');
          setOpen(false);
        }
      }}>
      <ComboboxChips ref={anchor} className="min-h-10 px-1.5">
        <ComboboxValue>
          {(picked: string[]) => picked.map((v) => <ComboboxChip key={v} aria-label={v}>{v}</ComboboxChip>)}
        </ComboboxValue>
        <ComboboxChipsInput aria-label={label} autoFocus={autoFocus} placeholder={value.length === 0 ? (empty ?? '') : ''} spellCheck={false} className="h-7 px-1" />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No match</ComboboxEmpty>
        <ComboboxList aria-label={label}>
          {shown.map((o) => (
            <ComboboxItem key={o.value} value={o.value} className="[&_mark]:bg-transparent [&_mark]:font-bold [&_mark]:text-brand-ink">
              <span className="min-w-0 flex-1 truncate"><Marked text={o.value} marks={o.marks} /></span>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
