import { spawn } from 'node:child_process';
import { gitAsync } from './blobs.js';

/**
 * yan updating itself from the page, as `user` would at a terminal in its
 * clone: the clone pulled, its packages installed, its build made again;
 * then serve restarts on the new build, as it does on any it finds. `npm
 * link` is setup's once only: the command it links is this folder, which
 * an update changes in place. One update at a time, whoever asks.
 */

export const STEPS = ['pull', 'install', 'build', 'restart'] as const;
export type Step = (typeof STEPS)[number];
export type StepState = 'wait' | 'now' | 'done' | 'failed';

export interface UpdateState {
  readonly running: boolean;
  readonly steps: readonly { readonly step: Step; readonly state: StepState }[];
  /** What the step that failed said last. */
  readonly error: string | null;
}

/** How far yan's clone is behind what it tracks, once fetched; or why that cannot be told. */
export type Behind = { readonly behind: number } | { readonly error: string };

/** The last lines a command said, enough to tell why it failed. */
const tail = (said: string): string => said.trim().split('\n').slice(-6).join('\n');

/** `npm` and its arguments, in `dir`; Windows runs npm's .cmd through a shell. */
function npm(dir: string, args: readonly string[]): Promise<{ code: number; said: string }> {
  return new Promise((resolve) => {
    let said = '';
    const child = spawn('npm', [...args], { cwd: dir, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', (c: string) => (said = (said + c).slice(-8000)));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (said = (said + c).slice(-8000)));
    child.on('error', (err) => resolve({ code: 127, said: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, said }));
  });
}

export class Updater {
  private state: UpdateState = { running: false, steps: STEPS.map((step) => ({ step, state: 'wait' })), error: null };

  /** `restart` restarts serve on the build in `home`: a new one that starts, or none, it being the one running, or one that does not start. */
  public constructor(private readonly home: string, private readonly restart: () => 'restarting' | 'same' | 'broken') {}

  public get now(): UpdateState {
    return this.state;
  }

  /** Fetch what the clone tracks and count the commits it has that the clone does not. */
  public async behind(): Promise<Behind> {
    if ((await gitAsync(this.home, ['rev-parse', '--is-inside-work-tree'], 10_000)).code !== 0) return { error: `${this.home} 不是 git 仓库` };
    const fetched = await gitAsync(this.home, ['fetch', '--quiet'], 60_000);
    if (fetched.code !== 0) return { error: tail(fetched.stderr) || '拉取失败' };
    const counted = await gitAsync(this.home, ['rev-list', '--count', 'HEAD..@{upstream}'], 10_000);
    if (counted.code !== 0) return { error: tail(counted.stderr) || '当前分支没有跟踪远端' };
    return { behind: Number(counted.stdout.trim()) || 0 };
  }

  /** Start an update; false when one is running already. */
  public start(): boolean {
    if (this.state.running) return false;
    this.state = { running: true, steps: STEPS.map((step) => ({ step, state: 'wait' })), error: null };
    void this.run();
    return true;
  }

  private mark(step: Step, state: StepState, error: string | null = null): void {
    this.state = {
      running: state === 'now' || (state === 'done' && step !== 'restart'),
      steps: this.state.steps.map((s) => (s.step === step ? { step, state } : s)),
      error: error ?? this.state.error,
    };
  }

  private async run(): Promise<void> {
    const steps: [Step, () => Promise<{ code: number; said: string }>][] = [
      ['pull', async () => {
        const r = await gitAsync(this.home, ['pull', '--ff-only', '--quiet'], 120_000);
        return { code: r.code, said: r.stderr || r.stdout };
      }],
      ['install', () => npm(this.home, ['install', '--no-audit', '--no-fund'])],
      ['build', () => npm(this.home, ['run', 'build'])],
    ];
    for (const [step, act] of steps) {
      this.mark(step, 'now');
      const r = await act();
      if (r.code !== 0) return this.mark(step, 'failed', tail(r.said) || `${step} failed`);
      this.mark(step, 'done');
    }
    this.mark('restart', 'now');
    // A build that is the one running, nothing having changed, needs no restart.
    const restarted = this.restart();
    if (restarted === 'same') this.mark('restart', 'done');
    else if (restarted === 'broken') this.mark('restart', 'failed', '新的构建启动不了，yan serve 还在用原来的');
  }
}
