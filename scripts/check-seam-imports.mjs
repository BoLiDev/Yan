#!/usr/bin/env node
//
// The dependency graph from td architecture.md §2, enforced by lint rather than
// by discipline (runtime.md §2).
//
// Two rules, and both of them exist because the failure they prevent is silent:
//
//   1. no module under src/seams/<a>/ imports from src/seams/<b>/. A seam maps
//      one outside authority into yan's vocabulary; a seam that reaches into
//      another seam has started making decisions, which is the one thing seams
//      exist not to do (td §4.3);
//
//   2. nothing under src/ imports src/ui/ except src/cli/. `ui/` is Clack and
//      people (cli-ux.md §2). A store or a seam that can prompt is a store or a
//      seam that can hang a hook forever with nobody to answer it.
//
// Usage: node scripts/check-seam-imports.mjs [src-root]
// Exit 0 clean, 1 violations found, 2 called wrongly.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolve(process.argv[2] ?? join(repoRoot, 'src'));

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

/** Which layer a path under src/ belongs to: 'seams/<name>', 'ui', or other. */
function layerOf(fileOrDir) {
  const rel = posix(relative(srcRoot, fileOrDir));
  if (rel.startsWith('..')) return null;
  const parts = rel.split('/');
  if (parts[0] === 'seams' && parts.length > 1) return `seams/${parts[1]}`;
  if (parts[0] === 'ui') return 'ui';
  if (parts[0]) return parts[0];
  return null;
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

    if (
      fromLayer?.startsWith('seams/') &&
      toLayer.startsWith('seams/') &&
      fromLayer !== toLayer
    ) {
      violations.push(`${where}\n    a seam may not import another seam (${fromLayer} → ${toLayer})`);
    }

    if (toLayer === 'ui' && fromLayer !== 'ui' && fromLayer !== 'cli') {
      violations.push(`${where}\n    only src/cli/ may import src/ui/ (${fromLayer ?? '?'} → ui)`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write('seam-import lint: forbidden edges\n');
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}

process.stdout.write(`seam-import lint: ok (${posix(relative(repoRoot, srcRoot)) || '.'})\n`);
