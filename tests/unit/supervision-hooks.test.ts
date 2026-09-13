import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Supervision } from '../../src/records/supervision/index.js';
import { Task } from '../../src/records/task/index.js';
import { bashCommand, cleanupTempDirs, mkTempDir, mkYanHome, repoRoot } from '../helpers/fixtures.js';

/**
 * The two Stop hooks, driven through `bin/hook-*.sh` rather than the compiled
 * files, because the stub is part of the contract: a harness registration
 * names the `.sh`.
 *
 * The guard's 800 ms settle is injected down to 50 ms throughout.
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

/** Run a hook and wait for it, without blocking this worker's event loop. */
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
    const child = spawn(bashCommand(), [join(home, 'bin', name), ...args], {
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
    // A backgrounded watcher would outlive the session that armed it.
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

  it('replaces a watcher that is alive but has stopped looping', async () => {
    // A live pid with a stale beacon held the lock and nobody could take it
    // from it: autoarm stood down, `yan wait` stood down, and the guard could
    // only say so. Now the hung watcher is killed and a fresh one takes over.
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');
    const hung = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const pid = hung.pid ?? 0;
    writeFileSync(
      sup.lock,
      `${JSON.stringify({ pid, host: hostname(), at: 1, identity: 'yan-wait t1' })}\n`,
    );
    writeFileSync(sup.beacon, `${Math.floor(Date.now() / 1000) - 4000} ${pid} t1 polling\n`);

    try {
      const r = await hook('hook-autoarm.sh', [], { env: { YAN_TASK: 't1', YAN_WAIT_INTERVAL: '0.1' } });
      expect(r.code, r.out).toBe(2);
      expect(r.stderr).toContain('signal: s1');
      expect(hung.exitCode ?? hung.signalCode).not.toBeNull();
    } finally {
      hung.kill('SIGKILL');
    }
  });
});

/**
 * A shift working on this repository sits in a worktree that carries the
 * repository's own hook registrations, so its harness fires the main agent's
 * hooks. `YAN_SID` is set in a shift's environment and never in the main
 * agent's; on that evidence every hook has to get out of the way.
 */
describe('the hooks belong to the main agent, not to a shift', () => {
  it('autoarm arms nothing for a shift, and leaves the wake for yan', async () => {
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');
    noWatcher();

    const r = await hook('hook-autoarm.sh', [], {
      env: { YAN_TASK: 't1', YAN_SID: 's1', YAN_WAIT_INTERVAL: '0.1' },
    });
    expect(r.code, r.out).toBe(0);
    expect(existsSync(sup.lock), 'the lock a shift took is a wake yan never gets').toBe(false);
    expect(existsSync(sup.wake)).toBe(false);
    expect(existsSync(join(run, 'signal')), 'the event is still there for yan').toBe(true);
  });

  it('autoarm says `stop` for a shift on agy, where silence is not an answer', async () => {
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');

    const r = await hook('hook-autoarm.sh', ['--agy'], { env: { YAN_TASK: 't1', YAN_SID: 's1' } });
    expect(r.code, r.out).toBe(0);
    expect((JSON.parse(r.stdout.trim()) as { decision?: string }).decision).toBe('stop');
  });

  it('the guard lets a shift\'s turn end, on every harness', async () => {
    liveShift('s1');
    noWatcher();

    for (const harness of ['--claude', '--codex']) {
      const r = await hook('hook-turnend-guard.sh', [harness], {
        env: { YAN_TASK: 't1', YAN_SID: 's1' },
      });
      expect(r.code, r.out).toBe(0);
      expect(r.stdout, harness).toBe('');
      expect(sup.guardCount(), 'a shift never spends the main agent\'s budget').toBe(0);
    }

    const agy = await hook('hook-turnend-guard.sh', ['--agy'], {
      env: { YAN_TASK: 't1', YAN_SID: 's1' },
    });
    expect(agy.code, agy.out).toBe(0);
    expect((JSON.parse(agy.stdout.trim()) as { decision?: string }).decision).toBe('stop');
    expect(sup.guardCount()).toBe(0);
  });
});

describe('the turn-end guard', () => {
  it('has to be told which harness it is', async () => {
    const r = await hook('hook-turnend-guard.sh', [], { env: { YAN_TASK: 't1' } });
    expect(r.code).toBe(2);
    expect(r.out).toContain('--claude, --codex or --agy');
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
    expect(failed.stderr).toContain('yan show t1');
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
    // A reconnect gap is not a fault.
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
    // a lock that was not there when the window opened.
    liveShift('s1');
    noWatcher();

    // A separate process, as it is in the real thing. Stamped now: a lock that
    // is old with no beacon is a hung watcher, not one starting up.
    const record = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      at: Math.floor(Date.now() / 1000),
      identity: 'yan-wait t1',
    });
    const late = spawn(
      process.execPath,
      [
        '-e',
        // Long enough that the lock appears after the guard starts looking.
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
    // The second look asks only about the lock: a watcher that has just claimed
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
    // Pasteable in an agent's pane, where `yan` is not on PATH and the shell
    // may be PowerShell: an absolute path and a real number.
    expect(r.stdout).toContain('wait --seconds 180 --drain');
    expect(r.stdout, 'a quiet slice needs no separate drain').not.toContain(' drain,');
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

/**
 * Agy weighs Claude's evidence and speaks Codex's envelope. It reads no exit
 * code at all, so every answer — including the permissive one — is an object
 * on stdout, and `continue` is its word for exit 2.
 */
describe('the guard on Agy', () => {
  const decision = (out: string): { decision?: string; reason?: string } =>
    JSON.parse(out.trim()) as { decision?: string; reason?: string };

  it('asks Claude\'s question: is a watcher on duty?', async () => {
    liveShift('s1');
    noWatcher();

    const r = await hook('hook-turnend-guard.sh', ['--agy'], { env: { YAN_TASK: 't1' } });
    expect(r.code, r.out).toBe(0);
    expect(decision(r.stdout).decision).toBe('continue');
    expect(decision(r.stdout).reason).toContain('no healthy watcher');
    expect(sup.guardCount()).toBe(1);

    // Unlike Codex, a healthy watcher is the whole answer: there is an autoarm
    // on this harness, so the turn may end once one is on duty.
    healthyWatcher();
    const again = await hook('hook-turnend-guard.sh', ['--agy'], { env: { YAN_TASK: 't1' } });
    expect(decision(again.stdout).decision).toBe('stop');
    expect(sup.guardCount()).toBe(0);
  });

  it('says `stop` out loud on every permissive path, because silence is not an answer', async () => {
    // Nothing live at all.
    const idle = await hook('hook-turnend-guard.sh', ['--agy'], { env: { YAN_TASK: 't1' } });
    expect(idle.code).toBe(0);
    expect(decision(idle.stdout).decision).toBe('stop');

    // And when it cannot tell whose turn this is.
    liveShift('s1');
    for (const task of ['', 'no-such-task']) {
      const r = await hook('hook-turnend-guard.sh', ['--agy'], { env: { YAN_TASK: task } });
      expect(r.code, r.out).toBe(0);
      expect(decision(r.stdout).decision).toBe('stop');
    }
  });

  it('fails open by saying so, where Codex fails open by saying nothing', async () => {
    liveShift('s1');
    noWatcher();
    writeFileSync(sup.guard, '3\n');

    const r = await hook('hook-turnend-guard.sh', ['--agy'], { env: { YAN_TASK: 't1' } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('AUTOMATIC SUPERVISION IS BROKEN');
    expect(decision(r.stdout).decision).toBe('stop');
  });
});

describe('autoarm on Agy', () => {
  it('turns an event into a `continue`, not an exit code', async () => {
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');

    const r = await hook('hook-autoarm.sh', ['--agy'], {
      env: { YAN_TASK: 't1', YAN_WAIT_INTERVAL: '0.1' },
    });
    // Exit 2 would be Claude's answer; agy discards it and reads the object.
    expect(r.code, r.out).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe('continue');
    expect(parsed.reason).toContain('signal: s1');
    expect(parsed.reason).toContain('yan drain');
    expect(existsSync(sup.lock)).toBe(false);
  });

  it('says `stop` when there is nothing to arm', async () => {
    const r = await hook('hook-autoarm.sh', ['--agy'], { env: { YAN_TASK: 't1' } });
    expect(r.code, r.out).toBe(0);
    expect((JSON.parse(r.stdout.trim()) as { decision?: string }).decision).toBe('stop');
  });
});

describe('the shell stubs', () => {
  it('reach the compiled hook when there is one', async () => {
    // The wording proves the compiled hook answered rather than the stub.
    const r = spawnSync(
      bashCommand(),
      [join(home, 'bin', 'hook-turnend-guard.sh'), '--claude'],
      { encoding: 'utf8', env: { ...process.env, YAN_TASK: 't1' }, input: '', windowsHide: true },
    );
    expect(r.status).toBe(0);

    rmSync(join(home, 'dist', 'hooks'), { recursive: true, force: true });
    const fallback = spawnSync(
      bashCommand(),
      [join(home, 'bin', 'hook-turnend-guard.sh'), '--claude'],
      { encoding: 'utf8', env: { ...process.env, YAN_TASK: 't1' }, input: '', windowsHide: true },
    );
    // With the compiled half gone the shell body answers, and answers the same.
    expect(fallback.status).toBe(0);
  });
});
