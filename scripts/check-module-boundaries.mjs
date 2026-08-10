#!/usr/bin/env node
//
// The dependency graph from td architecture.md §2, enforced by lint rather than
// by discipline (runtime.md §2).
//
// Three rules, and all three exist because the failure they prevent is silent:
//
//   1. ENTRY POINT. Nothing outside src/externals/<m>/ may import a file inside
//      it other than its index.ts. That is what makes index.ts worth reading:
//      it is the module's whole public surface, not a suggestion. Without this
//      rule a test — or a command in a hurry — reaches for an internal helper,
//      the helper becomes public by accident, and nobody can say what the
//      module offers any more.
//
//   2. NO SIDEWAYS EDGES. No module under src/externals/<a>/ imports
//      src/externals/<b>/. An external maps one outside authority into yan's
//      vocabulary; one that reaches into another has started making decisions,
//      which is the one thing they exist not to do (td §4.3).
//
//   3. PROMPTS STAY IN THE CLI. Nothing under src/ imports src/ui/ except
//      src/cli/. `ui/` is Clack and people (cli-ux.md §2). A store or an
//      external that can prompt is one that can hang a hook forever with
//      nobody there to answer it.
//
// A module's own test (src/externals/<m>/*.test.ts) is inside the module, so
// rule 1 does not apply to it. That is the point: colocating the test is what
// lets the internals stay internal.
//
// Usage: node scripts/check-module-boundaries.mjs [src-root]
// Exit 0 clean, 1 violations found, 2 called wrongly.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolve(process.argv[2] ?? join(repoRoot, 'src'));

// Directories whose children are each one module with one entry point.
// `seams` is still listed while the rename is in flight; it goes when the last
// module has moved out of it.
const MODULE_ROOTS = ['externals', 'seams'];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.mjs')) {
      files.push(full);
    }
  }
  return files;
}

// `import … from 'x'`, `export … from 'x'`, and `import('x')`. Deliberately a
// regex and not a parser: the rule is about module specifiers, which are the
// one part of the syntax a regex reads correctly.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function posix(p) {
  return p.split(sep).join('/');
}

/** Path parts of `p` relative to src/, or null when it is outside src/. */
function partsOf(p) {
  const rel = posix(relative(srcRoot, p));
  if (rel === '' || rel.startsWith('..')) return null;
  return rel.split('/');
}

/** Which module a path belongs to: `externals/worktree`, `ui`, `cli`, … */
function layerOf(p) {
  const parts = partsOf(p);
  if (parts === null) return null;
  if (MODULE_ROOTS.includes(parts[0]) && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? null;
}

/** True when the import specifier resolves to the module's declared entry. */
function isEntry(target, layer) {
  const entryDir = join(srcRoot, ...layer.split('/'));
  // `./index.js` compiles from `index.ts`; a bare directory import is the same
  // entry by another spelling.
  if (resolve(target) === resolve(entryDir)) return true;
  for (const name of ['index.ts', 'index.js']) {
    if (resolve(target) === resolve(join(entryDir, name))) return true;
  }
  // `from './index.js'` inside the module resolves to <dir>/index.js already
  // handled above; anything else under the directory is an internal file.
  return false;
}

const violations = [];

for (const file of walk(srcRoot)) {
  const source = readFileSync(file, 'utf8');
  const fromLayer = layerOf(file);
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue; // a package, not one of ours
    const target = resolve(dirname(file), spec);
    const toLayer = layerOf(target);
    if (toLayer === null) continue;

    const where = `${posix(relative(repoRoot, file))} → ${spec}`;
    const toIsModule = MODULE_ROOTS.includes(toLayer.split('/')[0]);
    const fromIsModule = fromLayer !== null && MODULE_ROOTS.includes(fromLayer.split('/')[0]);

    // 1. entry point
    if (toIsModule && fromLayer !== toLayer && !isEntry(target, toLayer)) {
      violations.push(
        `${where}\n    only ${toLayer}/index.ts may be imported from outside ${toLayer}`,
      );
    }

    // 2. no sideways edges
    if (fromIsModule && toIsModule && fromLayer !== toLayer) {
      violations.push(`${where}\n    ${fromLayer} may not import ${toLayer}`);
    }

    // 3. prompts stay in the cli
    if (toLayer === 'ui' && fromLayer !== 'ui' && fromLayer !== 'cli') {
      violations.push(`${where}\n    only src/cli/ may import src/ui/ (${fromLayer ?? '?'} → ui)`);
    }
  }
}

// A module without an index.ts has no declared surface at all.
for (const root of MODULE_ROOTS) {
  const dir = join(srcRoot, root);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const moduleDir = join(dir, name);
    if (!statSync(moduleDir).isDirectory()) continue;
    if (!existsSync(join(moduleDir, 'index.ts'))) {
      violations.push(`${root}/${name}\n    has no index.ts, so it declares no public surface`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write('module boundaries: forbidden edges\n');
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}

process.stdout.write(`module boundaries: ok (${posix(relative(repoRoot, srcRoot)) || '.'})\n`);
