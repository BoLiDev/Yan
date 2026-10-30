import { asRecord } from '../../util/narrow.js';

/**
 * Which files of a branch are its source code, for the switch in yan serve
 * that shows them alone: a web front end's by default, its scripts, pages
 * and styles, less its tests, stories, snapshots and what a build writes.
 * The vault's config.json adds to them, or with "replace" takes their
 * place:
 *
 *   "source": { "include": ["*.go"], "exclude": ["*_test.go"], "replace": false }
 *
 * A pattern with no slash is matched against a file's name, one with a
 * slash against its path from the repository's root; `*` stands for
 * anything but a slash and `**` for anything. A file is source code when
 * an include matches it and no exclude does. The page matches them
 * (web/src/lib/source.ts); the vault says them.
 */
export interface SourceRules {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

export const DEFAULT_SOURCE: SourceRules = {
  include: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.vue', '*.svelte', '*.html', '*.css', '*.scss', '*.less'],
  exclude: ['*.test.*', '*.spec.*', '*.stories.*', '*.min.*', '**/__tests__/**', '**/__mocks__/**', '**/__snapshots__/**', '**/e2e/**', '**/dist/**', '**/build/**'],
};

const patterns = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim()) : []);

/** The rules a vault's config.json makes, from its "source", over yan's own. */
export function sourceRules(config: unknown): SourceRules {
  const source = asRecord(asRecord(config).source);
  const [include, exclude] = [patterns(source.include), patterns(source.exclude)];
  if (source.replace === true) return { include, exclude };
  return { include: [...DEFAULT_SOURCE.include, ...include], exclude: [...DEFAULT_SOURCE.exclude, ...exclude] };
}
