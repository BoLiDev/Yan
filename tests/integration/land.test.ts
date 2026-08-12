import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';
import { land, type Host, type LandOptions } from '../../src/cli/land.js';
import { Task } from '../../src/records/task/index.js';
import type { MergeStrategy, MrRef, MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan land`.
 *
 * Authority is the whole reason `yan mr` and `yan land` are two files:
 *
 *   open the outbound MR    yan, on its own - opening one is reversible
 *   merge it into target    `user` has to ask for it
 *
 * After this command runs, `target` contains the work and colleagues are
 * looking at it. So the authority is checked before anything is read, and it is
 * not softened by being on a terminal: `user` saying so is the input, and no
 * prompt can supply it on their behalf.
 *
 * The second thing this file guards is order. `needs` records the landing order,
 * so the units are topologically sorted and the run stops at the first one that
 * will not land — carrying on past a failure would land a unit before the one
 * it needs, which is exactly what `needs` exists to stop.
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;

const MR_WEB = 'https://forge.invalid/x/-/merge_requests/2';
const MR_API = 'https://forge.invalid/x/-/merge_requests/1';

class RecordingHost implements Host {
  public says: MrState = 'open';
  public refuseMerge = false;
  public readonly stateCalls: string[] = [];
  public readonly merges: { mr: string; strategy: MergeStrategy }[] = [];

  public mrState(ref: MrRef): MrState {
    this.stateCalls.push(ref.mr);
    return this.says;
  }

  public mergeMr(options: MrRef & { strategy: MergeStrategy }): void {
    if (this.refuseMerge) throw new Error('the host refused');
    this.merges.push({ mr: options.mr, strategy: options.strategy });
  }
}

let host: RecordingHost;

function run(options: LandOptions): { code: number; message: string; landed: string[] } {
  try {
    const r = land(options, host);
    return { code: 0, message: '', landed: r.landed.map((l) => `${l.unit}:${l.result}`) };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '', landed: [] };
  }
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir(), { withDist: true });
  process.env.YAN_HOME = home;
  mkdirSync(join(home, 'repos', 'monorepo-x'), { recursive: true });
  // A clone is where the registry says it is now, not where a convention put
  // it. The path does not change; only the reason yan
  // can find it.
  registerRepo(home, 'monorepo-x', join(home, 'repos', 'monorepo-x'));

  // `web` is declared first and needs `api`, so declaration order and landing
  // order disagree. If the sort did nothing, this test would still pass by
  // accident — which is why it is written the wrong way round.
  Task.create('t042', 'unify the auth header');
  const t = new Task('t042');
  t.addUnit('web', 'monorepo-x', 'master', { branch: 'feat/web', needs: ['api'] });
  t.addUnit('api', 'monorepo-x', 'master', { branch: 'feat/api' });
  t.unit('web').set('mr', MR_WEB);
  t.unit('api').set('mr', MR_API);

  host = new RecordingHost();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('without `user` asking, nothing happens at all', () => {
  it('refuses before the host is asked a single question', () => {
    const r = run({ task: 't042' });
    expect(r.code).toBe(2);
    expect(r.message).toContain("'user' has to ask");
    expect(r.message).toContain('--user-asked');
    expect(host.stateCalls, 'the host is not even asked a question').toEqual([]);
  });

  it('is not softened by a terminal, because no prompt can supply it', async () => {
    const r = await runYan(home, ['land', '--task', 't042']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--user-asked');
  });
});

describe('with `user` asking: topologically sorted by `needs`', () => {
  it('lands api before web, because web needs api', () => {
    const r = run({ task: 't042', userAsked: true });
    expect(r.code, r.message).toBe(0);
    expect(host.merges.map((m) => m.mr)).toEqual([MR_API, MR_WEB]);
    expect(host.merges.every((m) => m.strategy === 'merge')).toBe(true);
  });

  it('never deletes a branch: that decision is not this command to make', () => {
    run({ task: 't042', userAsked: true });
    // `deleteSource` is never passed, so it never reaches the host at all.
    const source = readFileSync(join(process.cwd(), 'src', 'cli', 'land.ts'), 'utf8');
    expect(source).not.toContain('deleteSource:');
  });

  it('says so in log.md, and says who asked', () => {
    run({ task: 't042', userAsked: true });
    const log = readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8');
    expect(log).toContain('api  landed');
    expect(log).toContain("'user' asked");
  });
});

describe('an MR that is already merged is skipped, not merged twice', () => {
  it('reports it and never calls merge', () => {
    host.says = 'merged';
    const r = run({ task: 't042', userAsked: true });
    expect(r.code, r.message).toBe(0);
    expect(r.landed).toEqual(['api:already merged', 'web:already merged']);
    expect(host.merges, 'whether it merged is the host answer, and it was already yes').toEqual([]);
  });
});

describe('anything but `open` stops the run before something lands out of order', () => {
  it('stops on a closed MR', () => {
    host.says = 'closed';
    const r = run({ task: 't042', userAsked: true });
    expect(r.code).not.toBe(0);
    expect(r.message).toContain('is closed, not merged');
    expect(host.merges).toEqual([]);
  });

  it('stops when the host cannot answer', () => {
    host.says = 'unknown';
    const r = run({ task: 't042', userAsked: true });
    expect(r.code).not.toBe(0);
    expect(r.message).toContain('cannot tell what state');
    expect(host.merges).toEqual([]);
  });

  it('stops at the first refusal rather than trying the next unit', () => {
    host.refuseMerge = true;
    const r = run({ task: 't042', userAsked: true });
    expect(r.code).not.toBe(0);
    expect(r.message).toContain('did not merge');
    expect(host.stateCalls, 'it never went on to the second unit').toEqual([MR_API]);
  });
});

describe('naming units explicitly', () => {
  it('lands only those', () => {
    const r = run({ task: 't042', unit: ['api'], userAsked: true });
    expect(r.code, r.message).toBe(0);
    expect(r.landed).toEqual(['api:merged']);
  });
});

describe('a cycle in `needs` is refused, and nothing is merged', () => {
  it('is a mistake only `user` can resolve, not an order yan may pick', () => {
    Task.create('t099', 'circular');
    const t = new Task('t099');
    t.addUnit('a', 'monorepo-x', 'master', { branch: 'feat/a', needs: ['b'] });
    t.addUnit('b', 'monorepo-x', 'master', { branch: 'feat/b', needs: ['a'] });
    t.unit('a').set('mr', 'https://forge.invalid/x/-/merge_requests/9');
    t.unit('b').set('mr', 'https://forge.invalid/x/-/merge_requests/10');

    const r = run({ task: 't099', userAsked: true });
    expect(r.code).toBe(2);
    expect(r.message).toContain('cycle');
    expect(host.stateCalls).toEqual([]);
  });
});

describe('nothing to land', () => {
  it('says so, and points at yan mr when a unit was named', () => {
    Task.create('t100', 'no mr yet');
    new Task('t100').addUnit('solo', 'monorepo-x', 'master', { branch: 'feat/solo' });

    expect(run({ task: 't100', userAsked: true }).message).toContain('nothing to land');
    expect(run({ task: 't100', unit: ['solo'], userAsked: true }).message).toContain(
      'yan mr --task t100 --unit solo',
    );
  });
});

describe('usage errors', () => {
  it('needs a task and a strategy it understands', async () => {
    expect((await runYan(home, ['land', '--user-asked'])).out).toContain('--task is required');
    const bad = await runYan(home, ['land', '--task', 't042', '--user-asked', '--strategy', 'nonsense']);
    expect(bad.code).toBe(2);
    expect(bad.out).toContain('--strategy');
  });
});
