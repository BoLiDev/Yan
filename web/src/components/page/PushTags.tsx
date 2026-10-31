import type { PushFile } from '../../lib/api';
import { Badge } from '../ui/badge';

/** `+2 ~1 −1`: what a push added, changed and deleted, as tags. */
export function PushTags({ files }: { files: readonly PushFile[] }) {
  const n = (st: string): number => files.filter((f) => f.status === st).length;
  const tags = ([['A', 'success', '+', 'added'], ['M', 'brand', '~', 'changed'], ['D', 'destructive', '−', 'deleted']] as const).filter(([st]) => n(st) > 0);
  return <>{tags.map(([st, variant, sign, word]) => <Badge key={st} variant={variant} className="h-[18px] rounded-md px-1.5 tabular-nums" title={`${n(st)} ${word}`}>{`${sign}${n(st)}`}</Badge>)}</>;
}
