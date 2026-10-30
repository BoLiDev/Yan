// Whether a file of a branch is its source code, by the vault's rules (src/cli/serve/source.ts).

const cache = new Map<string, RegExp>();

/** A pattern as a regular expression: `*` anything but a slash, `**` anything, `?` one character. */
function regex(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (re) return re;
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${out}$`, 'i');
  cache.set(pattern, re);
  return re;
}

/** A pattern with no slash is matched against a file's name, one with a slash against its path. */
const matches = (pattern: string, path: string): boolean => regex(pattern).test(pattern.includes('/') ? path : path.slice(path.lastIndexOf('/') + 1));

/** Whether `path` is source code: an include matches it and no exclude does. */
export function isSource(rules: { readonly include: readonly string[]; readonly exclude: readonly string[] }, path: string): boolean {
  return rules.include.some((p) => matches(p, path)) && !rules.exclude.some((p) => matches(p, path));
}

const kept = new WeakMap<object, { key: string; view: { readonly files: readonly { readonly path: string }[] } }>();
/** A branch with only its source code's files, worked out once per answer and rules, so its order is too. */
export function sourceView<F extends { readonly path: string }>(b: { readonly files: readonly F[] }, rules: { readonly include: readonly string[]; readonly exclude: readonly string[] }): { readonly files: readonly F[] } {
  const key = `${rules.include.join('\0')}\n${rules.exclude.join('\0')}`;
  const known = kept.get(b);
  if (known && known.key === key) return known.view as { readonly files: readonly F[] };
  const view = { files: b.files.filter((f) => isSource(rules, f.path)) };
  kept.set(b, { key, view });
  return view;
}
