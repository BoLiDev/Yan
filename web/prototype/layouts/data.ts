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
export interface MockStep { id: string; kind: StepKind; title: string; state: StepState; files: readonly string[]; on: readonly string[]; col: number; row: number }

/** Each step with the steps it relies on, and where the graph puts it: columns run toward the destination. */
export const STEPS: readonly MockStep[] = [
  { id: 'k3f9', kind: 'decision', title: 'What a pack holds', state: 'done', files: [], on: [], col: 0, row: 1 },
  { id: 'p7qa', kind: 'research', title: 'How tar treats long paths', state: 'done', files: ['findings.md'], on: ['k3f9'], col: 1, row: 0 },
  { id: 'h8wd', kind: 'prototype', title: "The pack's index page", state: 'done', files: [], on: ['k3f9'], col: 1, row: 1 },
  { id: 'x2mb', kind: 'decision', title: 'Encrypting a pack', state: 'dropped', files: [], on: ['k3f9'], col: 1, row: 2 },
  { id: 'c4tn', kind: 'spec', title: 'The spec for yan pack', state: 'done', files: ['spec.md'], on: ['p7qa', 'h8wd'], col: 2, row: 1 },
  { id: 'r6ye', kind: 'build', title: 'A pack holds the destination and every result', state: 'done', files: [], on: ['c4tn'], col: 3, row: 1 },
  { id: 'v1sz', kind: 'build', title: "A pack holds each step's materials", state: 'working', files: ['src/pack/write.ts', 'src/pack/write.test.ts'], on: ['r6ye'], col: 4, row: 0 },
  { id: 'j9lk', kind: 'build', title: 'yan pack --json says what it wrote', state: 'ready', files: [], on: ['r6ye'], col: 4, row: 2 },
  { id: 'n5ju', kind: 'build', title: 'A pack opens on another machine', state: 'waiting', files: [], on: ['v1sz'], col: 5, row: 0 },
];
/** The steps the destination is reached from. */
export const LAST: readonly string[] = ['n5ju', 'j9lk'];

/**
 * How the path came to be what it is: each moment something happened to it, in order. A moment adds steps, finishes
 * steps, or is a change, which drops steps and may move the destination (here, one outcome fewer).
 */
export interface Moment { when: string; what: string; adds?: readonly string[]; done?: readonly string[]; change?: { drops: readonly string[]; why: string; outcomes: number } }
export const HISTORY: readonly Moment[] = [
  { when: '3 Nov', what: 'Charted', adds: ['k3f9', 'p7qa', 'h8wd', 'x2mb', 'c4tn'] },
  { when: '4 Nov', what: 'What a pack holds, done', done: ['k3f9'] },
  { when: '6 Nov', what: 'Research done', done: ['p7qa'] },
  { when: '8 Nov', what: 'Prototype done', done: ['h8wd'] },
  { when: '12 Nov', what: 'Change', change: { drops: ['x2mb'], outcomes: 4, why: 'A pack is only ever handed to people already trusted with the task, so encrypting it protects nothing and costs every reader a password. The outcome "The archive cannot be read without its password" is taken off the destination, and the decision on how to encrypt is dropped. The spec no longer waits on it.' } },
  { when: '13 Nov', what: 'Spec done, 3 steps added', done: ['c4tn'], adds: ['r6ye', 'v1sz', 'n5ju'] },
  { when: '17 Nov', what: 'First build done', done: ['r6ye'] },
  { when: '19 Nov', what: '1 step added', adds: ['j9lk'] },
  { when: 'Now', what: 'As it is' },
];
/** What a step relied on only until a change: the spec waited on the encryption decision until that was dropped. */
export const ONCE: Readonly<Record<string, readonly string[]>> = { c4tn: ['x2mb'] };
/** How many outcomes the destination had before any change, and from which moment how many were met. */
export const OUTCOMES_AT_FIRST = 5;
export const MET_FROM: readonly (readonly [number, number])[] = [[6, 2]];

export const DESTINATION = 'yan pack writes one archive that someone without Yan can open and read: where the task was going, what each step concluded, and what it left.';
export const OUTCOMES: readonly (readonly [string, boolean])[] = [
  ['The archive opens with nothing but a browser', true],
  ['Every done step shows its result', true],
  ["A step's materials sit beside its result", false],
  ['Unpacking on a second machine gives the same files', false],
];

export const LINKS: readonly (readonly [string, string])[] = [['Merge request', '!48'], ['Pipeline', '#2291']];

export interface MockFile { path: string; root: 'materials' | 'code' | 'companion'; step: string; mark?: 'M' | 'A'; text: string }

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
    path: 'evidence.md', root: 'materials', step: 'v1sz', mark: 'A', text: `# Evidence: a step's materials sit beside its result

Packed t152 and listed the archive:

\`\`\`
index.html
destination.md
c4tn/result.md
c4tn/spec.md
p7qa/result.md
p7qa/findings.md
\`\`\`

Each material is in the folder of the step that made it.
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
  {
    path: 'companion/GLOSSARY.md', root: 'companion', step: '', text: `# yan

The words of this repository, kept beside it and not committed to it.

## Language

**Pack**:
One archive of a task, written for a reader who has no Yan.
_Avoid_: Export, bundle, dump

**Index page**:
The page at the root of a pack that lists everything in it and needs no server.
_Avoid_: Home, readme
`,
  },
  {
    path: 'companion/adr/0007-packs-are-not-encrypted.md', root: 'companion', step: '', mark: 'A', text: `# Packs are not encrypted

A pack is only ever handed to people already trusted with the task. Encrypting it would protect nothing and cost every reader a password.

Decided on 12 Nov, in the task "Hand a task over as a pack".
`,
  },
];

export const fileAt = (path: string): MockFile | undefined => FILES.find((f) => f.path === path);
export const stepOf = (id: string): MockStep | undefined => STEPS.find((s) => s.id === id);
export const WORKING = STEPS.find((s) => s.state === 'working') as MockStep;

/** What each step is about, and what it concluded once done: what a step's details show. */
export const ABOUT: Readonly<Record<string, { about: string; result?: string; sessions: number }>> = {
  k3f9: { sessions: 1, about: 'Which parts of a task go into a pack, and which stay behind: the destination, results, materials, code, the conversation?', result: 'The destination with its outcomes, every done step\'s result, and each step\'s materials. No code (the merge request has it) and no conversations.' },
  p7qa: { sessions: 1, about: 'Whether a tar archive can carry the long, non-Latin paths a step\'s materials have, on every system a reader may open it with.', result: 'Write pax headers. Every tar since 2001 reads them; ustar would cut a nested Chinese file name.' },
  h8wd: { sessions: 2, about: 'What the page at the root of a pack looks like, opened from a file with no server behind it.', result: 'One page: the destination at the top, then each step as a card with its result and the files it left. The plain list won over the drawn path.' },
  x2mb: { sessions: 0, about: 'Whether a pack is encrypted, and if so how its reader gets the key.' },
  c4tn: { sessions: 1, about: 'The brief for building yan pack, gathered from the results before it, for a builder with no memory of them.', result: 'Three slices: the destination and every result; each step\'s materials; opening a pack on another machine.' },
  r6ye: { sessions: 2, about: 'The first slice: a pack that opens and reads top to bottom.', result: 'yan pack writes index.html, destination.md and a result.md per done step. Reviewed; 2 outcomes met.' },
  v1sz: { sessions: 1, about: 'The second slice: a result links to the files its step left, each in the step\'s own folder.' },
  j9lk: { sessions: 0, about: 'With --json, yan pack prints the archive\'s path, how many steps it holds and its size, for a script to read.' },
  n5ju: { sessions: 0, about: 'The third slice: yan unpack restores the same files on a second machine.' },
};
