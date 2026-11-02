import { describe, expect, it } from 'vitest';
import { isLink, listResources } from './resources';

describe('a task\'s resources', () => {
  const t = { agents: [['cloud', 'https://agent/1']] as const };
  const d = {
    resources: [['note', 'ask design'], ['WEB-1', 'https://t/1'], ['cloud', 'https://agent/1'], ['pr', 'https://g/mr/1'], ['try', 'https://p/1'], ['odd', 'https://o/1']] as const,
    resourceKinds: { note: 'general', 'WEB-1': 'spec', cloud: 'run', pr: 'mr', try: 'preview', odd: 'later' },
  };

  it('are listed by kind, its agents and its merge requests aside, a kind yan does not know as Other', () => {
    expect(listResources(t, d).map((r) => `${r.kind} ${r.name}`)).toEqual(['spec WEB-1', 'preview try', 'general note', 'general odd']);
  });


  it('open when they are a web link, and are words otherwise', () => {
    expect(isLink(' https://t/1 ')).toBe(true);
    expect(isLink('see https://t/1')).toBe(false);
    expect(isLink('ask design')).toBe(false);
  });
});
