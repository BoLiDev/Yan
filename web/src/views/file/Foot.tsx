import type { ReactNode } from 'react';
import type { ArtifactFile } from '../../lib/api';
import { short, when } from '../../lib/format';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { thumbUrl } from '../../state/server';
import { copyText } from '../../state/ui';

/**
 * The line at a file's foot: when it was added, the commit it came in, its
 * path on this machine to copy, and at its other end what goes with it.
 */
export function Foot({ file, path, local, children }: { file: ArtifactFile; path: string; local: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-none flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-sunken px-5 py-2 text-[12.5px] text-ink-3">
      {file.added ? <span title={file.changed !== file.added ? `changed ${when(file.changed)}` : ''}>{`Added ${when(file.added)}`}</span> : null}
      {file.commit ? <span className="font-mono text-[12px]" title={file.commit}>{short(file.commit)}</span> : null}
      <Button variant="ghost" size="xs" className="max-w-full min-w-0 justify-start font-mono text-xs font-normal text-ink-3" title="Copy the path on this machine" onClick={() => copyText(local, 'Path copied', 'The path')}><span className="truncate">{path}</span><Icon name="copy" size={13} /></Button>
      <span className="flex-auto" />
      {children}
    </div>
  );
}

/** The same screen taken another way, at another width or in another look: a pill with it small, to go to it. */
export function Pair({ href, sha, name, word }: { href: string; sha: string; name: string; word: string }) {
  return (
    <a className="inline-flex h-[30px] cursor-pointer items-center gap-2 rounded-full bg-sunken pr-3 pl-1 text-[12.5px] text-ink hover:bg-border hover:text-ink" href={href}>
      <img className="h-[22px] w-[34px] rounded-full bg-[var(--thumb-well)] object-cover" src={thumbUrl(sha, name, 'row')} alt="" decoding="async" />
      {/^\d+$/.test(word) ? `Same screen at ${word}` : `Same screen, ${word}`}
    </a>
  );
}
