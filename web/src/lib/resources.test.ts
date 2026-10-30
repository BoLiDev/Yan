import { describe, expect, it } from 'vitest';
import { isLink, listResources } from './resources';

describe('a task\'s resources', () => {
  it('are listed by kind, its agents aside, a kind yan does not know as Other', () => {
    const listed = listResources({ agents: [['cloud', 'https://agent/1']] }, {
      resources: [['note', 'ask design'], ['WEB-1', 'https://t/1'], ['cloud', 'https://agent/1'], ['pr', 'https://g/mr/1'], ['try', 'https://p/1'], ['odd', 'https://o/1']],
      resourceKinds: { note: 'general', 'WEB-1': 'spec', cloud: 'run', pr: 'mr', try: 'preview', odd: 'later' },
    });
    expect(listed.map((r) => `${r.kind} ${r.name}`)).toEqual(['spec WEB-1', 'preview try', 'mr pr', 'general note', 'general odd']);
  });

  it('open when they are a web link, and are words otherwise', () => {
    expect(isLink(' https://t/1 ')).toBe(true);
    expect(isLink('see https://t/1')).toBe(false);
    expect(isLink('ask design')).toBe(false);
  });
});
