import type { ReactNode } from 'react';
import { canNotify, toggleNotify } from '../state/notify';
import { keepVaultLocal } from '../state/server';
import { setPref, useUI } from '../state/ui';
import { Seg } from './page';
import { UpdateCard } from './Update';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Switch } from './ui/switch';

/** One thing to set: what it is, a line on what it does, and what sets it, at the row's end or under it. */
function Row({ title, sub, children, under }: { title: string; sub?: string; children?: ReactNode; under?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 py-3.5">
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
 * task list: the theme the page is drawn in; how much the page says of
 * what arrived, what it tells of as it happens and the marks on what is
 * new since the last look, each on or off by itself, since being told and
 * being shown are different wants; whether the vault is kept on this
 * machine alone; and yan's own updates. All of it is this browser's, kept
 * in it, but the vault's keeping and the update, which are this machine's.
 */
export function SettingsModal() {
  const open = useUI((s) => s.settings);
  const prefs = useUI((s) => s.prefs);
  const status = useUI((s) => s.status);
  // A vault whose git names no origin is local whatever is set, so there is nothing to switch.
  const kept = status === null ? 'Whether the vault is kept on this machine alone.'
    : !status.origin ? 'The vault has no origin, so it is kept on this machine alone.'
      : status.local ? 'The vault is read from this machine alone: nothing is fetched from its origin or pushed to it.'
        : 'On, the vault is read from this machine alone: nothing is fetched from its origin or pushed to it.';
  // Chrome's own leave, which the switch cannot give: said, with where to give it.
  const blocked = canNotify() && Notification.permission === 'denied';
  const told = `An agent that finishes or needs you is told at the top right, ${
    !canNotify() ? 'on this page only: this browser has no notifications of its own.'
      : blocked ? 'on this page only: Chrome blocks notifications from it, allowed from the icon left of the address bar.'
        : 'and Chrome says when an agent pushes something, while this page is open in the background.'} Off, nothing pops up.`;
  return (
    <Dialog open={open} onOpenChange={(o) => useUI.setState({ settings: o })}>
      <DialogContent className="gap-0 sm:max-w-[460px]">
        <DialogHeader className="pb-1">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col divide-y divide-sunken">
          <Row title="Theme" under={
            <Seg wide options={[['system', 'As the browser'], ['light', 'Light'], ['dark', 'Dark']] as const} current={prefs.theme} onPick={(v) => setPref('theme', v)} />
          } />
          <Row title="Notifications" sub={told}>
            <Switch aria-label="Notifications" checked={prefs.notify} onCheckedChange={() => void toggleNotify()} />
          </Row>
          <Row title="Marks on what is new" sub="The counts beside a task and the dots on its files, its report and its log, for what changed since you last looked.">
            <Switch aria-label="Marks on what is new" checked={prefs.badges} onCheckedChange={(on) => setPref('badges', on)} />
          </Row>
          {status?.vaults === undefined ? (
            <Row title="Local vault" sub={kept}>
              <Switch aria-label="Local vault" checked={status?.local ?? false} disabled={!status?.origin} onCheckedChange={(on) => void keepVaultLocal(on)} />
            </Row>
          ) : (
            // Several vaults shown as one list, in the order a task id two of them have is settled: each kept local or not by itself.
            <Row title="Local vaults" sub="A local vault is read from this machine alone: nothing is fetched from its origin or pushed to it. One with no origin is local already." under={
              <div className="flex flex-col gap-2">
                {status.vaults.map((v) => (
                  <label key={v.name} className="flex items-center gap-3 text-[13px]">
                    <span className="min-w-0 flex-1 truncate" title={v.dir}>{v.name}</span>
                    <Switch aria-label={`Local vault ${v.name}`} checked={v.local} disabled={!v.origin} onCheckedChange={(on) => void keepVaultLocal(on, v.name)} />
                  </label>
                ))}
              </div>
            } />
          )}
          <Row title="Updates" sub="yan on this machine, pulled, built and started again."><UpdateCard small /></Row>
        </div>
      </DialogContent>
    </Dialog>
  );
}
