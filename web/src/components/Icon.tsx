import {
  ArrowRight, ArrowUp, Ban, Bell, BellOff, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsDownUp,
  ChevronsUpDown, Cloud, Contrast, Copy, Download, ExternalLink, FileText, Folder, GitBranch, GripVertical, Inbox, LayoutGrid,
  Link, List, Maximize, Maximize2, PanelLeft, Pencil, Plus, RefreshCw, RotateCw, Search, SquareCheck, SquareTerminal,
  StickyNote, Trash2, WrapText, X, type LucideIcon,
} from 'lucide-react';
import { stateOf } from '../lib/api';
import { cn } from '../lib/utils';

/** The page's icons, all of them lucide's, by what each is for. */
const ICONS = {
  latest: Inbox,
  panel: PanelLeft,
  refresh: RefreshCw,
  reload: RotateCw,
  search: Search,
  chev: ChevronRight,
  down: ChevronDown,
  up: ChevronUp,
  go: ArrowRight,
  arrowUp: ArrowUp,
  grip: GripVertical,
  terminal: SquareTerminal,
  prev: ChevronLeft,
  next: ChevronRight,
  folder: Folder,
  overview: FileText,
  log: List,
  branch: GitBranch,
  dark: Contrast,
  external: ExternalLink,
  download: Download,
  full: Maximize,
  cloud: Cloud,
  link: Link,
  note: StickyNote,
  unfold: ChevronsUpDown,
  fold: ChevronsDownUp,
  expand: Maximize2,
  close: X,
  trash: Trash2,
  ban: Ban,
  edit: Pencil,
  copy: Copy,
  wrap: WrapText,
  check: SquareCheck,
  tick: Check,
  plus: Plus,
  grid: LayoutGrid,
  bell: Bell,
  bellOff: BellOff,
} as const satisfies Readonly<Record<string, LucideIcon>>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, width = 1.75, className }: { name: IconName; size?: number; width?: number; className?: string }) {
  const Drawn = ICONS[name];
  return <Drawn size={size} strokeWidth={width} aria-hidden="true" className={cn('shrink-0', className)} />;
}

/**
 * A task's state as a mark, in the state's own colour: open half filled,
 * in UAT a dot in a ring, done a tick, given up struck through. One this
 * page does not know is drawn as open.
 */
const STATES = {
  open: { colour: 'text-brand', marks: <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" /></> },
  uat: { colour: 'text-warning', marks: <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="2.75" fill="currentColor" /></> },
  done: { colour: 'text-success', marks: <><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--card)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></> },
  abandoned: { colour: 'text-ink-3', marks: <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m4.2 11.8 7.6-7.6" stroke="currentColor" strokeWidth="1.5" /></> },
} as const;

export function StateIcon({ state, size = 16 }: { state: string; size?: number }) {
  const { colour, marks } = STATES[stateOf(state)];
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={cn('shrink-0', colour)}>{marks}</svg>;
}
