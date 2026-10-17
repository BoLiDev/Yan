import { cells, padEnd } from './style.js';
import { RESOURCE_KINDS, type ResourceKind, type TaskData } from '../../records/task/index.js';

/**
 * What `user` sees a kind called. The agent reads and writes the kinds
 * themselves; these are only for the screens that are `user`'s.
 */
export const KIND_LABELS: Readonly<Record<ResourceKind, string>> = {
  spec: '需求',
  mr: 'MR',
  preview: '测试链接',
  run: '子任务',
  general: '其他',
};

/** One resource, with its kind. */
export interface KindedResource {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly where: string;
}

/** The resources in the order of RESOURCE_KINDS, each kind's in the order they were kept. */
export function byKind(data: Pick<TaskData, 'resources' | 'resourceKinds'>): KindedResource[] {
  const all = Object.entries(data.resources).map(([name, where]) => ({ kind: data.resourceKinds[name] ?? 'general', name, where }));
  return RESOURCE_KINDS.flatMap((kind) => all.filter((r) => r.kind === kind));
}

/** One line per resource, `  <kind>  <name>  <where>`, the kinds and names padded to a column each. */
export function resourceLines(data: Pick<TaskData, 'resources' | 'resourceKinds'>): string[] {
  const rows = byKind(data);
  const kindWidth = Math.max(0, ...rows.map((r) => r.kind.length));
  const nameWidth = Math.max(0, ...rows.map((r) => cells(r.name)));
  return rows.map((r) => `  ${r.kind.padEnd(kindWidth)}  ${padEnd(r.name, nameWidth)}  ${r.where}`);
}
