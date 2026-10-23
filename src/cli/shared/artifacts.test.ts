import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTempDirs, fxGit, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { artifactLines, artifactLinker, listArtifacts, vaultFileLink } from './artifacts.js';
import { Task } from '../../records/task/index.js';

afterAll(cleanupTempDirs);

let vault = '';
let task: Task;

function put(path: string): void {
  const file = join(task.dir, 'artifacts', path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x');
}

beforeEach(() => {
  vault = mkYanHome(mkTempDir());
  task = Task.create('with artifacts');
});

describe('listArtifacts', () => {
  it('groups the files as design/, uat/ and the rest, and leaves dotfiles out', () => {
    expect(listArtifacts(task.dir)).toEqual([]);
    for (const p of ['notes.md', 'uat/d1-after.png', 'design/flow/a.html', 'uat/d1-before.png', 'tools/x.mjs', 'design/flow/b.html', '.DS_Store', 'uat/d2.webm']) put(p);
    expect(listArtifacts(task.dir).map((a) => `${a.group} ${a.path}`)).toEqual([
      'design design/flow/a.html',
      'design design/flow/b.html',
      'uat uat/d1-after.png',
      'uat uat/d1-before.png',
      'uat uat/d2.webm',
      'other notes.md',
      'other tools/x.mjs',
    ]);
    expect(artifactLines(listArtifacts(task.dir))).toEqual([
      '  design/  flow/  2 files',
      '  uat/     d1-after.png',
      '           d1-before.png',
      '           d2.webm',
      '  other    notes.md',
      '           tools/  1 file',
    ]);
  });

  it('says how many more a long group has', () => {
    for (let i = 0; i < 5; i += 1) put(`uat/d${i}.png`);
    expect(artifactLines(listArtifacts(task.dir), 3).at(-1)).toBe('           … and 2 more');
  });
});

describe('artifactLinker', () => {
  it('links into the vault on github.com, on a gitlab host, or as config.json says, and not otherwise', async () => {
    expect(artifactLinker(task.dir), 'not a git repository').toBeUndefined();
    await fxGit(['init', '--initial-branch=main', vault]);
    await fxGit(['-C', vault, 'commit', '--allow-empty', '-m', 'a vault']);
    const at = (url: string) => fxGit(['-C', vault, 'remote', 'set-url', 'origin', url]);
    await fxGit(['-C', vault, 'remote', 'add', 'origin', 'git@github.com:me/vault.git']);
    expect(artifactLinker(task.dir)?.('uat/d1 after.png')).toBe('https://github.com/me/vault/blob/main/tasks/t001/artifacts/uat/d1%20after.png');
    await at('https://gitlab.corp.example/team/vault.git');
    expect(artifactLinker(task.dir)?.('uat/d1.webm')).toBe('https://gitlab.corp.example/team/vault/-/blob/main/tasks/t001/artifacts/uat/d1.webm');
    await at('https://git.corp.example/team/vault.git');
    expect(artifactLinker(task.dir)).toBeUndefined();
    writeFileSync(join(vault, 'config.json'), JSON.stringify({ artifactLinks: 'https://git.corp.example/team/vault/src/{branch}/{path}' }));
    expect(artifactLinker(task.dir)?.('uat/d1.webm')).toBe('https://git.corp.example/team/vault/src/main/tasks/t001/artifacts/uat/d1.webm');
    writeFileSync(join(vault, 'config.json'), JSON.stringify({ artifactLinks: 'javascript:alert(1)//{path}' }));
    expect(artifactLinker(task.dir), 'only a web address is a link').toBeUndefined();
  });
});

describe('vaultFileLink', () => {
  it('gives any file of the vault its page on the forge, naming the forge, with only the path to fill in', async () => {
    expect(vaultFileLink(vault), 'not a git repository').toBeUndefined();
    await fxGit(['init', '--initial-branch=main', vault]);
    await fxGit(['-C', vault, 'commit', '--allow-empty', '-m', 'a vault']);
    await fxGit(['-C', vault, 'remote', 'add', 'origin', 'git@gitlab.corp.example:team/vault.git']);
    expect(vaultFileLink(vault)).toEqual({ forge: 'GitLab', template: 'https://gitlab.corp.example/team/vault/-/blob/main/{path}' });
    await fxGit(['-C', vault, 'remote', 'set-url', 'origin', 'git@github.com:me/vault.git']);
    expect(vaultFileLink(vault)).toEqual({ forge: 'GitHub', template: 'https://github.com/me/vault/blob/main/{path}' });
    writeFileSync(join(vault, 'config.json'), JSON.stringify({ artifactLinks: 'https://git.corp.example/v/src/{branch}/{path}' }));
    expect(vaultFileLink(vault), 'a forge config.json names is not one yan can name').toEqual({ forge: null, template: 'https://git.corp.example/v/src/main/{path}' });
  });
});
