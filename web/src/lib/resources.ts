// A task's resources as yan serve lists them: by kind, its agents aside.

import type { TaskDetail, TaskSummary } from './api';

/** How each kind is named, in the order they are listed: a preview, the link to check the result on, is UAT's. */
export const KIND_WORD: Readonly<Record<string, string>> = { spec: 'Spec', preview: 'UAT', mr: 'MR', general: 'Other' };

export interface Listed {
  readonly kind: string;
  readonly name: string;
  readonly where: string;
}

/**
 * The task's resources but its agents, which have a row of their own, by
 * kind in KIND_WORD's order and as task.json keeps them within one; a kind
 * yan does not know is listed as Other.
 */
export function listResources(t: Pick<TaskSummary, 'agents'>, d: Pick<TaskDetail, 'resources' | 'resourceKinds'>): Listed[] {
  const agents = new Set(t.agents.map(([name]) => name));
  const kindOf = (name: string): string => {
    const kind = d.resourceKinds[name] ?? 'general';
    return kind in KIND_WORD ? kind : 'general';
  };
  return Object.keys(KIND_WORD).flatMap((kind) => d.resources.filter(([name]) => !agents.has(name) && kindOf(name) === kind).map(([name, where]) => ({ kind, name, where })));
}

/** Whether a resource is a web link, which opens, rather than words. */
export const isLink = (where: string): boolean => /^https?:\/\/\S+$/i.test(where.trim());
