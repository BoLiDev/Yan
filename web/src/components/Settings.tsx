import type { ReactNode } from 'react';
import { canNotify, notifying, toggleNotify } from '../state/notify';
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
 * what arrived, a notification when a push comes and the marks on what is
 * new since the last look, each on or off by itself, since being told and
 * being shown are different wants; and yan's own updates. All of it is
 * this browser's, kept in it, but the update, which is this machine's.
 */
export function SettingsModal() {
  const open = useUI((s) => s.settings);
  const prefs = useUI((s) => s.prefs);
  // Chrome's own leave, which the switch cannot give: said, with where to give it.
  const blocked = canNotify() && Notification.permission === 'denied';
  const told = !canNotify() ? 'This browser has no notifications.'
    : blocked ? 'Chrome blocks notifications from this page: allow them from the icon left of the address bar.'
    : 'Chrome says when an agent pushes something, while this page is open in the background.';
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
            <Switch aria-label="Notifications" checked={notifying()} disabled={!canNotify() || blocked} onCheckedChange={() => void toggleNotify()} />
          </Row>
          <Row title="Marks on what is new" sub="The counts beside a task and the dots on its files, its report and its log, for what changed since you last looked.">
            <Switch aria-label="Marks on what is new" checked={prefs.badges} onCheckedChange={(on) => setPref('badges', on)} />
          </Row>
          <Row title="Updates" sub="yan on this machine, pulled, built and started again."><UpdateCard small /></Row>
        </div>
      </DialogContent>
    </Dialog>
  );
}
