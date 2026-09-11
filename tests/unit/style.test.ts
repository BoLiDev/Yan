import { describe, expect, it } from 'vitest';
import { fit } from '../../src/cli/shared/style.js';

describe('fit', () => {
  it('leaves text that fits alone', () => {
    expect(fit('short', 10)).toBe('short');
    expect(fit('exactly10!', 10)).toBe('exactly10!');
  });

  it('cuts to the width, the ellipsis included', () => {
    expect(fit('abcdefghijkl', 8)).toBe('abcdefg…');
  });

  it('counts a wide character as two columns', () => {
    expect(fit('进度页原型设计', 8)).toBe('进度页…');
    expect(fit('ab进度', 6)).toBe('ab进度');
  });
});
