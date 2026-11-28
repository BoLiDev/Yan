/** PROTOTYPE: everything the variants show, made up. One task, its path, what its steps left, and its code. */

export type TaskState = 'open' | 'uat' | 'done' | 'paused';
export interface MockTask { id: string; title: string; state: TaskState; working?: boolean; dot?: 'blocked' | 'finished' }

export const TASKS: readonly MockTask[] = [
  { id: 't152', title: 'Hand a task over as a pack', state: 'open', working: true },
  { id: 't149', title: 'A returned tree lets go of its branch', state: 'open', dot: 'blocked' },
  { id: 't151', title: 'Drafts find by pinyin', state: 'open', dot: 'finished' },
  { id: 't147', title: 'Thumbnails without sharp', state: 'uat' },
  { id: 't140', title: 'Serve starts in under a second', state: 'paused' },
];
export const TASK = TASKS[0] as MockTask;

export type StepKind = 'decision' | 'research' | 'prototype' | 'spec' | 'build';
export type StepState = 'done' | 'working' | 'ready' | 'waiting' | 'dropped';
export interface MockStep { id: string; kind: StepKind; title: string; state: StepState; files: readonly string[] }

export const STEPS: readonly MockStep[] = [
  { id: 'k3f9', kind: 'decision', title: 'What a pack holds', state: 'done', files: [] },
  { id: 'p7qa', kind: 'research', title: 'How tar treats long paths', state: 'done', files: ['findings.md'] },
  { id: 'x2mb', kind: 'decision', title: 'Encrypting a pack', state: 'dropped', files: [] },
  { id: 'h8wd', kind: 'prototype', title: "The pack's index page", state: 'done', files: [] },
  { id: 'c4tn', kind: 'spec', title: 'The spec for yan pack', state: 'done', files: ['spec.md'] },
  { id: 'r6ye', kind: 'build', title: 'A pack holds the destination and every result', state: 'done', files: [] },
  { id: 'v1sz', kind: 'build', title: "A pack holds each step's materials", state: 'working', files: ['src/pack/write.ts', 'src/pack/write.test.ts'] },
  { id: 'n5ju', kind: 'build', title: 'A pack opens on another machine', state: 'waiting', files: [] },
];

export const DESTINATION = 'yan pack writes one archive that someone without Yan can open and read: where the task was going, what each step concluded, and what it left.';
export const OUTCOMES: readonly (readonly [string, boolean])[] = [
  ['The archive opens with nothing but a browser', true],
  ['Every done step shows its result', true],
  ["A step's materials sit beside its result", false],
  ['Unpacking on a second machine gives the same files', false],
];

export const LINKS: readonly (readonly [string, string])[] = [['Merge request', '!48 · yan'], ['Pipeline', '#2291 · passed']];

export interface MockFile { path: string; root: 'materials' | 'code'; step: string; mark?: 'M' | 'A'; text: string }

export const FILES: readonly MockFile[] = [
  {
    path: 'spec.md', root: 'materials', step: 'c4tn', text: `# The spec for yan pack

A pack is one archive of a task, written for a reader who has no Yan: a colleague, a reviewer, the user a year from now.

## What it holds

- The **destination** and its outcomes, with which are met.
- Every done step's **result**, in the order the path was walked.
- Each step's **materials**, in a folder named for the step.
- An \`index.html\` at the root that lists all of it and needs no server.

Dropped steps are listed with the reason they were dropped, and their materials are left out.

## The command

\`\`\`sh
yan pack t152 --out ~/Desktop
\`\`\`

It prints the path of the archive and nothing else. With \`--json\` it prints \`{ "path": "…", "steps": 6, "bytes": 48213 }\`.

## Build steps

| Slice | What works when it is done |
| --- | --- |
| The destination and every result | The archive opens and reads top to bottom |
| Each step's materials | A result links to the files its step left |
| Opening on another machine | \`yan unpack\` restores the same files |

## Not in this spec

Encrypting a pack was decided against: whoever is handed one is trusted with it.
`,
  },
  {
    path: 'findings.md', root: 'materials', step: 'p7qa', text: `# How tar treats long paths

**ustar** cuts a path at 100 bytes for the name and 155 for the prefix. A material nested under a step folder passes that easily once its name is Chinese.

## What was found

1. \`pax\` headers carry a path of any length and every tar since 2001 reads them.
2. Node's \`tar\` writes pax by default and falls back to nothing.
3. macOS Archive Utility reads pax; Windows Explorer does since 2023.

## So

Write pax, and test with a 300-byte path.
`,
  },
  {
    path: 'src/pack/write.ts', root: 'code', step: 'v1sz', mark: 'M', text: `import { create } from 'tar';
import { readPath, type Step } from '../path/read.js';
import { resultOf } from '../path/result.js';
import { indexPage } from './index-page.js';

export interface Packed {
  readonly path: string;
  readonly steps: number;
  readonly bytes: number;
}

/**
 * One archive of a task, for a reader with no Yan: the destination, every
 * done step's result, and what each step left, under a folder of its own.
 */
export async function writePack(task: string, out: string): Promise<Packed> {
  const path = await readPath(task);
  const done = path.steps.filter((s) => s.state === 'done');
  const entries: string[] = ['index.html', 'destination.md'];

  for (const step of done) {
    entries.push(\`\${step.id}/result.md\`);
    for (const material of step.materials) {
      entries.push(\`\${step.id}/\${material.name}\`);
    }
  }

  await stage(task, path.destination, done.map(resultOf), indexPage(path, done));
  const file = \`\${out}/\${task}.tar\`;
  await create({ file, cwd: stagingDir(task), portable: true }, entries);
  return { path: file, steps: done.length, bytes: await sizeOf(file) };
}

function folderOf(step: Step): string {
  return step.id;
}
`,
  },
  {
    path: 'src/pack/write.test.ts', root: 'code', step: 'v1sz', mark: 'A', text: `import { expect, test } from 'vitest';
import { listing, vaultWith } from '../testing/vault.js';
import { writePack } from './write.js';

test("a pack holds each done step's materials beside its result", async () => {
  const vault = await vaultWith({ steps: [{ id: 'c4tn', state: 'done', materials: ['spec.md'] }] });
  const packed = await writePack(vault.task, vault.out);
  expect(await listing(packed.path)).toContain('c4tn/spec.md');
});

test('a dropped step leaves nothing in the pack', async () => {
  const vault = await vaultWith({ steps: [{ id: 'x2mb', state: 'dropped', materials: ['notes.md'] }] });
  const packed = await writePack(vault.task, vault.out);
  expect(await listing(packed.path)).not.toContain('x2mb/notes.md');
});
`,
  },
];

export const fileAt = (path: string): MockFile | undefined => FILES.find((f) => f.path === path);
export const stepOf = (id: string): MockStep | undefined => STEPS.find((s) => s.id === id);
export const WORKING = STEPS.find((s) => s.state === 'working') as MockStep;
