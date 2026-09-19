import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectSlug, lastSpoke } from './harness.js';
import type { HarnessEnv } from './types.js';

/**
 * When an agent last wrote to its session file, per harness, against a fake
 * home. Every file is dated by hand, so "newest" is a fact of the fixture.
 */

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yan-harness-'));
  made.push(dir);
  return dir;
}

function file(path: string, at: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{}\n');
  utimesSync(path, at / 1000, at / 1000);
}

function env(dir: string, processes: Record<number, number> = {}): HarnessEnv {
  return { home: dir, processes: () => new Map(Object.entries(processes).map(([k, v]) => [Number(k), v])) };
}

const T = Date.parse('2026-09-18T10:00:00Z');
const SID = '5d2a9fba-71a5-4b73-a72a-d7f4bb3e7b46';

describe('the Claude project slug', () => {
  it('turns every slash and dot into a dash', () => {
    expect(claudeProjectSlug('/Users/user/.yan-trees/Yan-Dev-1a6d5c27/1/Yan-Dev'))
      .toBe('-Users-user--yan-trees-Yan-Dev-1a6d5c27-1-Yan-Dev');
  });
});

describe('claude', () => {
  const cwd = '/work/trees/1/app';

  it('reads the session file a known id names', () => {
    const h = home();
    file(join(h, '.claude', 'projects', claudeProjectSlug(cwd), `${SID}.jsonl`), T);
    expect(lastSpoke({ kind: 'claude', sessionId: SID, cwd }, env(h))?.at).toBe(T);
  });

  it('takes the newest of the session file and its sub-agents', () => {
    const h = home();
    const dir = join(h, '.claude', 'projects', claudeProjectSlug(cwd));
    file(join(dir, `${SID}.jsonl`), T);
    file(join(dir, SID, 'subagents', 'agent-a1.jsonl'), T + 90_000);
    file(join(dir, SID, 'subagents', 'agent-a1.meta.json'), T + 500_000);
    const spoke = lastSpoke({ kind: 'claude', sessionId: SID, cwd }, env(h));
    expect(spoke?.at).toBe(T + 90_000);
    expect(spoke?.file).toContain('agent-a1.jsonl');
  });

  it('finds the file in another project when the directory is not where the slug says', () => {
    const h = home();
    file(join(h, '.claude', 'projects', '-somewhere-else', `${SID}.jsonl`), T);
    expect(lastSpoke({ kind: 'claude', sessionId: SID, cwd }, env(h))?.at).toBe(T);
  });

  it('without an id, finds the session in the registry by directory and start time', () => {
    const h = home();
    const sessions = join(h, '.claude', 'sessions');
    mkdirSync(sessions, { recursive: true });
    // An older session in the same tree, from an earlier lease, and ours.
    writeFileSync(join(sessions, '100.json'), JSON.stringify({ pid: 100, sessionId: 'old-one', cwd, startedAt: T - 86_400_000 }));
    writeFileSync(join(sessions, '200.json'), JSON.stringify({ pid: 200, sessionId: SID, cwd, startedAt: T + 1000 }));
    const dir = join(h, '.claude', 'projects', claudeProjectSlug(cwd));
    file(join(dir, 'old-one.jsonl'), T + 999_000);
    file(join(dir, `${SID}.jsonl`), T + 60_000);
    expect(lastSpoke({ kind: 'claude', cwd, startedAt: T }, env(h))?.at).toBe(T + 60_000);
  });

  it('without an id, finds the main agent as the child of the process that started it', () => {
    const h = home();
    const sessions = join(h, '.claude', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, '301.json'), JSON.stringify({ pid: 301, sessionId: 'someone-else', cwd: '/yan', startedAt: T }));
    writeFileSync(join(sessions, '302.json'), JSON.stringify({ pid: 302, sessionId: SID, cwd: '/yan', startedAt: T }));
    file(join(h, '.claude', 'projects', claudeProjectSlug('/yan'), `${SID}.jsonl`), T + 5000);
    file(join(h, '.claude', 'projects', claudeProjectSlug('/yan'), 'someone-else.jsonl'), T + 9000);
    expect(lastSpoke({ kind: 'claude', parentPid: 42 }, env(h, { 301: 1, 302: 42 }))?.at).toBe(T + 5000);
  });

  it('answers nothing when there is no id, no registry entry, or no file', () => {
    const h = home();
    expect(lastSpoke({ kind: 'claude', cwd }, env(h))).toBeUndefined();
    expect(lastSpoke({ kind: 'claude', sessionId: SID, cwd }, env(h))).toBeUndefined();
    expect(lastSpoke({ kind: 'claude', parentPid: 42 }, env(h))).toBeUndefined();
    expect(lastSpoke({ kind: 'claude', sessionId: '../../etc', cwd }, env(h))).toBeUndefined();
  });
});

describe('agy', () => {
  it('reads the conversation transcript, the newest of the two', () => {
    const h = home();
    const logs = join(h, '.gemini', 'antigravity-cli', 'brain', SID, '.system_generated', 'logs');
    file(join(logs, 'transcript.jsonl'), T);
    file(join(logs, 'transcript_full.jsonl'), T + 3000);
    expect(lastSpoke({ kind: 'agy', sessionId: SID }, env(h))?.at).toBe(T + 3000);
  });

  it('answers nothing without a conversation id, since nothing maps a workspace to one', () => {
    const h = home();
    file(join(h, '.gemini', 'antigravity-cli', 'brain', SID, '.system_generated', 'logs', 'transcript.jsonl'), T);
    expect(lastSpoke({ kind: 'agy', cwd: '/work' }, env(h))).toBeUndefined();
  });
});

describe('codex and the rest', () => {
  it('answer nothing, and never throw', () => {
    const h = home();
    expect(lastSpoke({ kind: 'codex', sessionId: SID }, env(h))).toBeUndefined();
    expect(lastSpoke({ kind: 'nano', sessionId: SID }, env(h))).toBeUndefined();
    expect(lastSpoke({ kind: 'claude', sessionId: SID }, { home: '/nonexistent', processes: () => { throw new Error('no ps'); } })).toBeUndefined();
  });
});
