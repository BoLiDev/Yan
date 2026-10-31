import { describe, expect, it } from 'vitest';
// yan's own rules, as serve keeps them and sends them to the page.
import { DEFAULT_SOURCE as RULES } from '../../../src/cli/serve/source';
import { isSource } from './source';

describe('source code', () => {
  it('is a front end\'s scripts, pages and styles', () => {
    for (const p of ['src/login/api.ts', 'src/login/LoginForm.tsx', 'index.html', 'src/styles/login.css', 'src/types/login.d.ts']) expect(isSource(RULES, p), p).toBe(true);
  });

  it('leaves out tests, stories, snapshots, what a build writes, and anything else', () => {
    for (const p of ['src/login/LoginForm.test.tsx', 'e2e/login.spec.ts', 'src/login/LoginForm.stories.tsx', 'src/login/__snapshots__/LoginForm.test.tsx.snap', 'src/__tests__/a.ts', 'packages/web/dist/app.js', 'vendor/x.min.js', 'package.json', 'package-lock.json', 'README.md']) {
      expect(isSource(RULES, p), p).toBe(false);
    }
  });

  it('reads a pattern with a slash against the path, from the root or, after **/, anywhere', () => {
    expect(isSource({ include: ['src/**'], exclude: [] }, 'src/a/b.go')).toBe(true);
    expect(isSource({ include: ['src/**'], exclude: [] }, 'lib/src/b.go')).toBe(false);
    expect(isSource({ include: ['*.go'], exclude: ['*_test.go'] }, 'pkg/a_test.go')).toBe(false);
  });
});
