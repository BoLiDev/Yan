import type { ReactNode } from 'react';
import { canNotify, toggleNotify } from '../state/notify';
import { keepVaultLocal } from '../state/server';
import { setPref, useUI } from '../state/ui';
import { FontPick } from './FontPick';
import { Seg } from './page';
import { UpdateCard } from './Update';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';

/** One thing to set: what it is, a line on what it does, and what sets it, at the row's end or under it. */
function Row({ title, sub, children, under }: { title: string; sub?: string; children?: ReactNode; under?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5 py-3.5">
      <div className="flex items-center gap-4">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <b className="text-[13.5px]">{title}</b>
          {sub ? <span className="text-[12.5px] leading-[18px] text-ink-3">{sub}</span> : null}
        </span>
        {children}
      </div>
      {under}
    </div>
  );
}

/**
 * What this browser is set to, in one box, opened from the cog over the
 * task list: the theme the page is drawn in, and the fonts of the page and
 * of a terminal; how much the page says of
 * what arrived, what it tells of as it happens and the marks on what is
 * new since the last look, each on or off by itself, since being told and
 * being shown are different wants; this machine's vaults, each kept in
 * step with its remote or not; and yan's own updates. All of it is this browser's, kept
 * in it, but the vault's keeping and the update, which are this machine's.
 */
export function SettingsModal() {
  const open = useUI((s) => s.settings);
  const prefs = useUI((s) => s.prefs);
  const status = useUI((s) => s.status);
  // Chrome's own leave, which the switch cannot give: said, with where to give it.
  const blocked = canNotify() && Notification.permission === 'denied';
  const told = !canNotify() ? 'When an agent finishes or needs you. This browser has none of its own, so on this page only.'
    : blocked ? 'When an agent finishes or needs you. Chrome blocks them here: allow them from the icon left of the address bar.'
      : 'When an agent finishes or needs you, from Chrome too while the page is in the background.';
  return (
    <Dialog open={open} onOpenChange={(o) => useUI.setState({ settings: o })}>
      <DialogContent className="gap-0 sm:max-w-[600px]">
        <DialogHeader className="pb-1">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col divide-y divide-sunken">
          <Row title="Theme" under={
            <Seg wide options={[['system', 'As the browser'], ['light', 'Light'], ['dark', 'Dark']] as const} current={prefs.theme} onPick={(v) => setPref('theme', v)} />
          } />
          <Row title="Font" sub="Fonts on this computer, with commas between, tried in order. Empty, yan's own.">
            <FontPick label="Font" value={prefs.font} onPick={(f) => setPref('font', f)} />
          </Row>
          <Row title="Terminal font" sub="Likewise, for terminals.">
            <FontPick label="Terminal font" value={prefs.termFont} onPick={(f) => setPref('termFont', f)} />
          </Row>
          <Row title="Notifications" sub={told}>
            <Switch aria-label="Notifications" checked={prefs.notify} onCheckedChange={() => void toggleNotify()} />
          </Row>
          <Row title="Marks on what is new" sub="Counts and dots on what changed since you last looked.">
            <Switch aria-label="Marks on what is new" checked={prefs.badges} onCheckedChange={(on) => setPref('badges', on)} />
          </Row>
          {status?.vaults === undefined ? null : (
            // This machine's vaults as its config.json lists them, in the order a task id two of them have is settled: each local or remote by itself.
            <Row title="Vaults" sub="The first is the default for a new task. A switch on keeps a vault in step with its remote; off, it stays on this machine." under={
              <div className="flex min-w-0 flex-col gap-1.5" role="list" aria-label="Vaults">
                {status.vaults.map((v, i) => (
                  <div key={v.name} role="listitem" className="flex min-w-0 items-center gap-3 rounded-lg bg-muted px-3 py-2 text-[13px]">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2"><b>{v.name}</b>{i === 0 && status.vaults !== undefined && status.vaults.length > 1 ? <Badge variant="secondary">default</Badge> : null}</span>
                      <span className="truncate font-mono text-xs text-ink-3" title={v.dir}>{v.dir}</span>
                    </span>
                    <span className="flex-none text-xs text-ink-3" title={v.origin ? undefined : 'It has no remote to sync with, so it is local'}>{v.local ? 'Local' : 'Remote'}</span>
                    {/* On is in step with its remote, as a switch reads; what serve keeps is the other way round, whether it is local. */}
                    <Switch aria-label={`Sync ${v.name} with its remote`} checked={!v.local} disabled={!v.origin} onCheckedChange={(on) => void keepVaultLocal(!on, status.vaults !== undefined && status.vaults.length > 1 ? v.name : undefined)} />
                  </div>
                ))}
              </div>
            } />
          )}
          <Row title="Updates" sub="yan on this machine."><UpdateCard small /></Row>
        </div>
      </DialogContent>
    </Dialog>
  );
}
