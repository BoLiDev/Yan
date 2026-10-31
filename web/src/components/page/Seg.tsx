import { cn } from '../../lib/utils';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

/** One of a few, as a row of toggles; the one picked stays picked. */
export function Seg<V extends string>({ options, current, onPick, wide }: { options: readonly (readonly [V, string])[]; current: V; onPick: (v: V) => void; wide?: boolean }) {
  return (
    <ToggleGroup value={[current]} onValueChange={(next) => {
      if (next[0] !== undefined) onPick(next[0] as V);
    }} spacing={1} className={cn('rounded-lg bg-muted p-[3px]', wide && 'flex w-auto')}>
      {options.map(([value, label]) => (
        <ToggleGroupItem key={value} value={value} size="sm"
          className={cn('h-7 px-3 text-[13px] font-normal text-ink-2 hover:bg-transparent data-[pressed]:bg-card data-[pressed]:font-bold data-[pressed]:text-foreground data-[pressed]:shadow-xs', wide && 'flex-1')}>
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
