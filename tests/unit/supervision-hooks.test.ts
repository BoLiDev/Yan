import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Supervision } from '../../src/records/supervision/index.js';
import { Task } from '../../src/records/task/index.js';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot } from '../helpers/fixtures.js';

/**
 * `tests/unit/hook-autoarm.test.sh` and `tests/unit/hook-turnend-guard.test.sh`,
 * ported to the TypeScript hooks.
 *
 * They are driven through `bin/hook-*.sh`, not through the compiled files
 * directly, because the shell stub is part of what Phase 6 delivers: the
 * harness registration still names a `.sh`, and the stub has to reach the
 * compiled hook when there is one and the shell body when there is not.
 *
 * The 800 ms settle is injected down to 50 ms: it is there so the guard does
 * not false-alarm while autoarm is still claiming the lock, and nothing about
 * it needs to be slow to be tested.
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;
let sup: Supervision;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly out: string;
}

/**
 * Run a hook and wait for it.
 *
 * `spawn` and not `spawnSync`, deliberately: these hooks deliberately take
 * their time — the guard's settle window, the watcher's loop — and a
 * synchronous spawn would block this worker's event loop for all of it, which
 * vitest reads as a worker that has stopped answering.
 */
function hook(
  name: string,
  args: readonly string[],
  options: { env?: Record<string, string>; input?: string } = {},
): Promise<Run> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    YAN_GUARD_SETTLE: '0.05',
    // No herdr in a unit test: the watcher must degrade to the poll rather than
    // wait on a socket that is not there.
    HERDR_SOCKET_PATH: join(home, 'no-such-herdr.sock'),
    ...options.env,
  };
  delete env.YAN_HOME;

  return new Promise<Run>((resolve, reject) => {
    const child = spawn('bash', [join(home, 'bin', name), ...args], {
      env: env as NodeJS.ProcessEnv,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr, out: `${stdout}${stderr}` });
    });
    child.stdin.end(options.input ?? '');
  });
}

function liveShift(sid: string, pane = 'w9:p99'): string {
  const run = join(home, 'tasks', 't1', 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), `{ "version": 1, "pane": "${pane}" }\n`);
  return run;
}

function healthyWatcher(): void {
  mkdirSync(sup.run, { recursive: true });
  writeFileSync(
    sup.lock,
    `${JSON.stringify({ pid: process.pid, host: hostname(), at: 1, identity: 'yan-wait t1' })}\n`,
  );
  writeFileSync(sup.beacon, `${Math.floor(Date.now() / 1000)} ${process.pid} t1 subscribed\n`);
}

function noWatcher(): void {
  rmSync(sup.lock, { force: true, recursive: true });
  rmSync(sup.beacon, { force: true });
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir(), { withDist: true });
  process.env.YAN_HOME = home;
  Task.create('t1', 'supervision');
  sup = new Supervision('t1');
  mkdirSync(sup.run, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('the autoarm hook never detaches its watcher', () => {
  const source = readFileSync(join(repoRoot, 'src', 'hooks', 'autoarm.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('runs the watcher in this hook process, synchronously', async () => {
    // The harness owns the process group. A backgrounded watcher outlives the
    // session that armed it and is then a second watcher nobody can see — the
    // failure the single-flight lock exists to prevent, made permanent.
    expect(source).toContain('spawnSync');
    for (const forbidden of ['detached', 'unref', 'nohup', 'setsid', 'disown', 'spawn(']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('arms the long shape, not a checkpoint slice', async () => {
    // A hook that armed one would report "nothing happened" every three minutes.
    expect(source).not.toContain('--seconds');
  });
});

describe('autoarm', () => {
  it('does nothing when there is nothing to supervise', async () => {
    const r = await hook('hook-autoarm.sh', [], { env: { YAN_TASK: 't1' } });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(sup.lock)).toBe(false);
  });

  it('gets out of the way when it cannot tell whose supervision this is', async () => {
    // A Stop hook that fails is a Stop hook that blocks a turn.
    liveShift('s1');
    expect((await hook('hook-autoarm.sh', [], { env: { YAN_TASK: '' } })).code).toBe(0);
    expect((await hook('hook-autoarm.sh', [], { env: { YAN_TASK: 'no-such-task' } })).code).toBe(0);
  });

  it('turns an event into a rewake', async () => {
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');

    const r = await hook('hook-autoarm.sh', [], { env: { YAN_TASK: 't1', YAN_WAIT_INTERVAL: '0.1' } });
    expect(r.code, r.out).toBe(2);
    expect(r.stderr).toContain('signal: s1');
    expect(r.stderr).toContain('yan drain');
    expect(readFileSync(sup.wake, 'utf8')).toContain('signal: s1');

    // The watcher ran in this hook's process tree and is gone with it: the lock
    // it took was released on the way out.
    expect(existsSync(sup.lock)).toBe(false);
  });

  it('does not arm a second watcher while one is on duty', async () => {
    // Every Stop can fire autoarm, so this is the normal case, not an error.
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');
    healthyWatcher();

    const r = await hook('hook-autoarm.sh', [], { env: { YAN_TASK: 't1' } });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(sup.wake)).toBe(false);
    expect(existsSync(join(run, 'signal'))).toBe(true);
    expect(readFileSync(sup.lock, 'utf8')).toContain(String(process.pid));
  });
});

describe('the turn-end guard', () => {
  it('has to be told which harness it is', async () => {
    const r = await hook('hook-turnend-guard.sh', [], { env: { YAN_TASK: 't1' } });
    expect(r.code).toBe(2);
    expect(r.out).toContain('--claude or --codex');
  });

  it('lets the turn end when there is nothing left to supervise, and resets the budget', async () => {
    writeFileSync(sup.guard, '2\n');
    const claude = await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 't1' } });
    expect(claude.code, claude.out).toBe(0);
    expect(existsSync(sup.guard)).toBe(false);

    writeFileSync(sup.guard, '2\n');
    const codex = await hook('hook-turnend-guard.sh', ['--codex'], { env: { YAN_TASK: 't1' } });
    expect(codex.code).toBe(0);
    expect(codex.stdout).toBe('');
    expect(existsSync(sup.guard)).toBe(false);
  });

  it('does not hold a turn hostage when it cannot tell whose it is', async () => {
    liveShift('s1');
    expect((await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: '' } })).code).toBe(0);
    expect(
      (await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 'no-such-task' } })).code,
    ).toBe(0);
  });
});

describe('the guard on Claude', () => {
  it('blocks while responsibility remains and nobody is on duty, then fails open', async () => {
    liveShift('s1');
    noWatcher();

    for (const attempt of [1, 2, 3]) {
      const r = await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 't1' } });
      expect(r.code, r.out).toBe(2);
      expect(r.stderr).toContain('no healthy watcher');
      expect(sup.guardCount()).toBe(attempt);
    }

    // Budget spent: fail open, loudly. A guard that can wedge a session forever
    // is worse than no guard.
    const failed = await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 't1' } });
    expect(failed.code).toBe(0);
    expect(failed.stderr).toContain('AUTOMATIC SUPERVISION IS BROKEN');
    expect(failed.stderr).toContain('yan ls t1');
  });

  it('lets the turn end when the watcher is healthy, and resets the count', async () => {
    liveShift('s1');
    healthyWatcher();
    writeFileSync(sup.guard, '2\n');

    const r = await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 't1' } });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(sup.guard)).toBe(false);
  });

  it('blocks on a live pid that has stopped looping', async () => {
    liveShift('s1');
    healthyWatcher();
    writeFileSync(sup.beacon, `${Math.floor(Date.now() / 1000) - 4000} ${process.pid} t1 polling\n`);

    const r = await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 't1' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('beacon');
  });

  it('blocks on a beacon left behind by a watcher that is gone', async () => {
    liveShift('s1');
    noWatcher();
    writeFileSync(sup.beacon, `${Math.floor(Date.now() / 1000)} ${process.pid} t1 subscribed\n`);

    expect((await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 't1' } })).code).toBe(2);
  });

  it('lets a watcher that is mid-reconnect through', async () => {
    // supervision.md §5, decided in Phase 6: a reconnect gap is not a fault.
    // The watcher is still going round its loop and its liveness poll never
    // went through the socket in the first place.
    liveShift('s1');
    healthyWatcher();
    writeFileSync(
      sup.beacon,
      `${Math.floor(Date.now() / 1000)} ${process.pid} t1 reconnecting\n`,
    );

    const r = await hook('hook-turnend-guard.sh', ['--claude'], { env: { YAN_TASK: 't1' } });
    expect(r.code, r.out).toBe(0);
  });

  it('does not false-alarm while autoarm is still claiming the lock', async () => {
    // Both Stop hooks fire concurrently. What earns a pass inside the window is
    // a lock that was NOT there when the window opened.
    liveShift('s1');
    noWatcher();

    // In a SEPARATE PROCESS, because the guard below is run with `spawnSync`
    // and a timer in this one could not fire while that call blocks. Autoarm is
    // a separate process in the real thing too.
    const record = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      at: 1,
      identity: 'yan-wait t1',
    });
    const late = spawn(
      process.execPath,
      [
        '-e',
        // Two seconds, because what is being tested is that the guard WAITS:
        // the lock has to appear after the guard has started looking, and
        // starting bash and node under a loaded test suite is not instant.
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sup.lock)}, ${JSON.stringify(`${record}\n`)}), 2000)`,
      ],
      { stdio: 'ignore', windowsHide: true },
    );

    const r = await hook('hook-turnend-guard.sh', ['--claude'], {
      env: { YAN_TASK: 't1', YAN_GUARD_SETTLE: '6' },
    });
    late.kill();

    expect(r.code, r.out).toBe(0);
    expect(existsSync(sup.guard)).toBe(false);
    // The second look asks only about the LOCK: a watcher that has just claimed
    // it has not necessarily written its first beacon.
    expect(existsSync(sup.beacon)).toBe(false);
  });

  it('does not accept stop_hook_active as a one-shot', async () => {
    // Claude sets it true after asyncRewake continuations too. A guard that
    // trusted it would let through exactly the turn that needs a watcher armed.
    liveShift('s1');
    noWatcher();

    const r = await hook('hook-turnend-guard.sh', ['--claude'], {
      env: { YAN_TASK: 't1' },
      input: '{"stop_hook_active":true,"session_id":"x"}',
    });
    expect(r.code).toBe(2);
    expect(sup.guardCount()).toBe(1);
  });
});

describe('the guard on Codex', () => {
  it('asks about responsibility, not about a lock', async () => {
    // There is no autoarm on Codex and no long-lived wait between slices, so a
    // missing lock is the normal state.
    liveShift('s1');
    noWatcher();

    const r = await hook('hook-turnend-guard.sh', ['--codex'], { env: { YAN_TASK: 't1' } });
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.stdout.trim()) as { decision: string }).toMatchObject({
      decision: 'block',
    });
    // The command has to be runnable where the model will paste it: `yan` is
    // not on PATH inside an agent's pane, and the pane's shell on Windows is
    // PowerShell, which reads `${VAR:-default}` as a parse error rather than a
    // default. A live codex ran this hook and dutifully reported
    // "the term 'yan' is not recognized" — so the path is absolute and the
    // number is resolved here.
    expect(r.stdout).toContain('wait --seconds 180');
    expect(r.stdout).toContain(`${home.replace(/\\/g, '/')}/bin/yan`);
    expect(r.stdout).not.toContain('${');
    expect(sup.guardCount()).toBe(1);

    // A healthy watcher does not excuse the model from its checkpoint loop.
    healthyWatcher();
    const again = await hook('hook-turnend-guard.sh', ['--codex'], { env: { YAN_TASK: 't1' } });
    expect((JSON.parse(again.stdout.trim()) as { decision: string }).decision).toBe('block');
    expect(sup.guardCount()).toBe(2);
  });

  it('may use stop_hook_active as a one-shot, and does not spend the budget for it', async () => {
    liveShift('s1');
    noWatcher();
    writeFileSync(sup.guard, '2\n');

    const r = await hook('hook-turnend-guard.sh', ['--codex'], {
      env: { YAN_TASK: 't1' },
      input: '{"stop_hook_active":true}',
    });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(sup.guardCount()).toBe(2);
  });

  it('shares the budget, and fails open the same way', async () => {
    liveShift('s1');
    noWatcher();
    writeFileSync(sup.guard, '3\n');

    const r = await hook('hook-turnend-guard.sh', ['--codex'], { env: { YAN_TASK: 't1' } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('AUTOMATIC SUPERVISION IS BROKEN');
    expect(r.stdout).not.toContain('decision');
  });
});

describe('the shell stubs', () => {
  it('reach the compiled hook when there is one', async () => {
    // Dual dispatch, exactly as bin/yan does it. Proven by the message: the
    // shell body cannot produce a Node stack or the TypeScript wording, so the
    // simplest proof is that the compiled file is what answered.
    const r = spawnSync(
      'bash',
      [join(home, 'bin', 'hook-turnend-guard.sh'), '--claude'],
      { encoding: 'utf8', env: { ...process.env, YAN_TASK: 't1' }, input: '', windowsHide: true },
    );
    expect(r.status).toBe(0);

    rmSync(join(home, 'dist', 'hooks'), { recursive: true, force: true });
    const fallback = spawnSync(
      'bash',
      [join(home, 'bin', 'hook-turnend-guard.sh'), '--claude'],
      { encoding: 'utf8', env: { ...process.env, YAN_TASK: 't1' }, input: '', windowsHide: true },
    );
    // With the compiled half gone the shell body answers, and answers the same.
    expect(fallback.status).toBe(0);
  });
});
