import type { TaskState } from '../lib/api';

const STROKE = {
  latest: '<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M6.5 5h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  go: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  prev: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  overview: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  branch: '<circle cx="6" cy="6" r="2.25"/><circle cx="6" cy="18" r="2.25"/><circle cx="18" cy="6" r="2.25"/><path d="M6 8.25v7.5M18 8.25c0 4.5-4 5.5-9.5 7.5"/>',
  dark: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4.5 7h15M10 4h4M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12M10 11v6M14 11v6"/>',
  ban: '<circle cx="12" cy="12" r="8"/><path d="m6.5 17.5 11-11"/>',
  edit: '<path d="M14.5 5.5l4 4M4 20l1-4.5L15.5 5a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L8.5 19z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  wrap: '<path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0 2-2m-2 2 2 2M4 18h5"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  bellOff: '<path d="M8.5 6.3A6 6 0 0 1 18 11v5.5l1.5 2H9"/><path d="M6 11v5.5l-1.5 2h2"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="m4 4 16 16"/>',
} as const;

export type IconName = keyof typeof STROKE;

const STATES: Record<TaskState, string> = {
  open: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#0b7285" stroke-width="1.5"/><path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="#0b7285"/>',
  done: '<circle cx="8" cy="8" r="7" fill="#1f7a3d"/><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  abandoned: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#66655f" stroke-width="1.5"/><path d="m4.2 11.8 7.6-7.6" stroke="#66655f" stroke-width="1.5"/>',
  uat: '<circle cx="8" cy="8" r="6.25" fill="none" stroke="#a15c07" stroke-width="1.5"/><circle cx="8" cy="8" r="2.75" fill="#a15c07"/>',
};

export function Icon({ name, size = 16, width = 1.75 }: { name: IconName; size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={width}
      strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: STROKE[name] }} />
  );
}

export function StateIcon({ state, size = 16 }: { state: TaskState; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }} dangerouslySetInnerHTML={{ __html: STATES[state] ?? STATES.open }} />;
}
