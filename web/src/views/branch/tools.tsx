import type { ReactNode } from 'react';
import type { BranchView as Branch } from '../../lib/api';
import { enc } from '../../lib/files';
import { Seg, Tool } from '../../components/page';
import { setPref, useUI } from '../../state/ui';

export function LayoutTools() {
  const layout = useUI((s) => s.prefs.layout);
  return <Seg options={[['unified', 'Unified'], ['split', 'Split']] as const} current={layout} onPick={(v) => setPref('layout', v)} />;
}

export function forgeTools(b: Branch) {
  // GitHub or GitLab, each with its own way to a commit and a file; none for a forge yan cannot tell.
  const forge = b.links.forge;
  return {
    commit: (sha: string): ReactNode => (forge ? <Tool name="external" label={`Open the commit on ${forge.name}`} href={forge.commit.replaceAll('{sha}', sha)} /> : null),
    file: (path: string): ReactNode => (forge ? <Tool name="external" label={`Open the file on ${forge.name}`} href={forge.blob.replaceAll('{ref}', encodeURIComponent(b.head)).replaceAll('{path}', enc(path))} /> : null),
  };
}
