import type { PushState } from './wire.js';

/**
 * What the page wrote and has not pushed, the drafts written on disk and
 * the edits committed here, pushed `waitMs` after the last of them, or at
 * once when asked, the drafts' box closing: one push for a spell of
 * writing rather than one for each pause in it, so the page never waits on
 * the network. A push that fails is tried again on each tick, what was
 * written being here meanwhile all the same. What it says goes to the page
 * with serve's status.
 */
export class LaterPush {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private pending = false;
  private error: string | null = null;

  /** `push` commits and pushes, answering what went wrong, or null; `said` is called whenever the state changes. */
  public constructor(private readonly push: () => Promise<string | null>, private readonly said: () => void, private readonly waitMs = 10_000) {}

  public get state(): PushState {
    return { pending: this.pending || this.running !== undefined, error: this.error };
  }

  /** Something written here: the push waits for the writing to stop. */
  public touched(): void {
    const was = this.state.pending;
    this.pending = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.now(), this.waitMs);
    this.timer.unref();
    if (!was) this.said();
  }

  /** What is waiting pushed now; one running already is waited for, and what was written during it goes after. */
  public async now(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running !== undefined) await this.running;
    if (!this.pending) return;
    this.pending = false;
    this.running = this.push().then((warning) => {
      this.error = warning;
      if (warning !== null) this.pending = true;
    });
    try {
      await this.running;
    } finally {
      this.running = undefined;
      this.said();
    }
  }

  /** A push made elsewhere that failed, a change's from the page: it is tried again on each tick, and said meanwhile. */
  public failed(warning: string): void {
    this.pending = true;
    this.error = warning;
    this.said();
  }

  /** On each tick: a push that failed is tried again, unless more writing is being waited for. */
  public retry(): void {
    if (this.pending && this.error !== null && this.timer === undefined && this.running === undefined) void this.now();
  }

  public stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
