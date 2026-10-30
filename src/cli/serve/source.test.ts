import { describe, expect, it } from 'vitest';
import { DEFAULT_SOURCE, sourceRules } from './source.js';

describe('source code rules', () => {
  it('are yan\'s own with no config, or one with no "source"', () => {
    expect(sourceRules(undefined)).toEqual(DEFAULT_SOURCE);
    expect(sourceRules({ cli: 'claude' })).toEqual(DEFAULT_SOURCE);
  });

  it('add the vault\'s patterns to yan\'s own', () => {
    const rules = sourceRules({ source: { include: ['*.go', ' ', 3], exclude: ['*_test.go'] } });
    expect(rules.include).toEqual([...DEFAULT_SOURCE.include, '*.go']);
    expect(rules.exclude).toEqual([...DEFAULT_SOURCE.exclude, '*_test.go']);
  });

  it('are the vault\'s alone when it says replace', () => {
    expect(sourceRules({ source: { include: ['*.py'], replace: true } })).toEqual({ include: ['*.py'], exclude: [] });
  });
});
