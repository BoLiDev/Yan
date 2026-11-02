// A task's resources as yan serve lists them: by kind, its agents and its merge requests aside.

import type { TaskDetail, TaskSummary } from './api';

/**
 * How each kind the Resources page lists is named, in its order: a
 * preview, the link to check the result on, is UAT's. A merge request is
 * the MR page's, beside the branches it is opened from.
 */
export const KIND_WORD: Readonly<Record<string, string>> = { spec: 'Spec', preview: 'UAT', general: 'Other' };

export interface Listed {
  readonly kind: string;
  readonly name: string;
  readonly where: string;
}

type Kept = { readonly t: Pick<TaskSummary, 'agents'>; readonly d: Pick<TaskDetail, 'resources' | 'resourceKinds'> };

/** The task's resources of `kind`, its agents aside, as task.json keeps them; a kind yan does not know is general's. */
function ofKind({ t, d }: Kept, kind: string): Listed[] {
  const agents = new Set(t.agents.map(([name]) => name));
  const kindOf = (name: string): string => {
    const k = d.resourceKinds[name] ?? 'general';
    return k === 'mr' || k in KIND_WORD ? k : 'general';
  };
  return d.resources.filter(([name]) => !agents.has(name) && kindOf(name) === kind).map(([name, where]) => ({ kind, name, where }));
}

/**
 * The task's resources but its agents and its merge requests, which have
 * rows of their own, by kind in KIND_WORD's order; a kind yan does not know
 * is listed as Other.
 */
export function listResources(t: Pick<TaskSummary, 'agents'>, d: Pick<TaskDetail, 'resources' | 'resourceKinds'>): Listed[] {
  return Object.keys(KIND_WORD).flatMap((kind) => ofKind({ t, d }, kind));
}

/** The task's merge requests: its `mr` resources, which the MR page lists over its branches. */
export function mergeRequests(t: Pick<TaskSummary, 'agents'>, d: Pick<TaskDetail, 'resources' | 'resourceKinds'>): Listed[] {
  return ofKind({ t, d }, 'mr');
}

/** Whether a resource is a web link, which opens, rather than words. */
export const isLink = (where: string): boolean => /^https?:\/\/\S+$/i.test(where.trim());
