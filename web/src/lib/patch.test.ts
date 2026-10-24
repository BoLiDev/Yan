import { describe, expect, it } from 'vitest';
import { colourPatch, parsePatch, splitPairs } from './patch';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 export { a, b };
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

describe('a patch', () => {
  it('reads each file, its hunks and its lines with their numbers on each side', () => {
    const [ts, png] = parsePatch(PATCH);
    expect(ts?.path).toBe('src/a.ts');
    expect(ts?.hunks[0]?.lines.map((l) => `${l.k} ${l.a ?? '-'} ${l.b ?? '-'} ${l.t}`)).toEqual([
      'ctx 1 1 const a = 1;',
      'del 2 - const b = 2;',
      'add - 2 const b = 3;',
      'ctx 3 3 export { a, b };',
    ]);
    expect(png?.binary).toBe(true);
  });

  it('sets each removed line beside the line added in its place', () => {
    const lines = parsePatch(PATCH)[0]?.hunks[0]?.lines ?? [];
    expect(splitPairs(lines).map(([l, r]) => `${l?.t ?? '·'} | ${r?.t ?? '·'}`)).toEqual([
      'const a = 1; | const a = 1;',
      'const b = 2; | const b = 3;',
      'export { a, b }; | export { a, b };',
    ]);
  });

  it('colours each side of a hunk in its language, and leaves a language not known here plain', () => {
    const [ts] = parsePatch(PATCH);
    if (!ts) throw new Error('no file');
    colourPatch(ts, 'typescript');
    expect(ts.hunks[0]?.lines[1]?.h).toContain('hljs-keyword');
    const [plain] = parsePatch(PATCH);
    if (!plain) throw new Error('no file');
    colourPatch(plain, null);
    expect(plain.hunks[0]?.lines[1]?.h).toBeUndefined();
  });
});
