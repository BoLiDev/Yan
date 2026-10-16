import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { runProcessAsync, type ProcessResult } from '../../util/process.js';

/**
 * Reading a repository without touching its work tree, for `yan serve`.
 *
 * Every read names an object: a blob by its sha, or `<commit>:<path>`. What
 * the agents write into the vault's work tree, and the hooks that pull and
 * push it, never see the server at all.
 */

/** `git` in `dir`, async, with paths printed as they are rather than octal-quoted. */
export function gitAsync(dir: string, args: readonly string[], timeoutMs = 60_000): Promise<ProcessResult> {
  return runProcessAsync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], { timeoutMs });
}

interface Pending {
  readonly name: string;
  readonly resolve: (blob: Buffer | undefined) => void;
}

/**
 * Blobs out of one repository through one long-running `git cat-file
 * --batch`. A tree of thumbnails asks for dozens at once, and a git process
 * each spends most of its time starting, on Windows above all.
 *
 * The answers come back in the order the names went in, so a queue of who
 * asked is all the bookkeeping there is. A process that dies answers
 * everyone still waiting with `undefined`, and the next read starts another.
 */
export class BlobReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly waiting: Pending[] = [];
  private chunks: Buffer[] = [];

  public constructor(private readonly dir: string) {}

  /** The object's bytes, or `undefined` when there is no such object or it is not a blob. */
  public read(name: string): Promise<Buffer | undefined> {
    if (/[\r\n]/.test(name)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const child = this.start();
      this.waiting.push({ name, resolve });
      child.stdin.write(`${name}\n`);
    });
  }

  /** Ends the git process; resolves once it is gone, which Windows needs before its directory can go. */
  public close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.once('close', () => resolve());
      child.stdin.end();
      child.kill();
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child;
    const child = spawn('git', ['-C', this.dir, 'cat-file', '--batch'], { windowsHide: true });
    child.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.drain();
    });
    child.stderr.resume();
    const gone = (): void => {
      if (this.child === child) this.child = undefined;
      this.chunks = [];
      for (const p of this.waiting.splice(0)) p.resolve(undefined);
    };
    child.on('error', gone);
    child.on('close', gone);
    child.stdin.on('error', gone);
    this.child = child;
    return child;
  }

  /** Hand out every answer that has arrived whole. */
  private drain(): void {
    while (this.waiting.length > 0) {
      let buf = this.chunks[0];
      if (buf === undefined) return;
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (this.chunks.length === 1) return;
        this.chunks = [Buffer.concat(this.chunks)];
        continue;
      }
      // `<sha> <type> <size>`, or `<name> missing` / `<name> ambiguous`.
      const header = buf.subarray(0, nl).toString('utf8').split(' ');
      const size = Number(header[2]);
      const found = header.length === 3 && Number.isInteger(size);
      const end = found ? nl + 1 + size + 1 : nl + 1;
      // Joined only once the whole answer is in: a big blob arrives in many
      // chunks, and joining at each one would copy it over and over.
      if (this.chunks.reduce((n, c) => n + c.length, 0) < end) return;
      if (this.chunks.length > 1) buf = Buffer.concat(this.chunks);

      const pending = this.waiting.shift() as Pending;
      pending.resolve(found && header[1] === 'blob' ? Buffer.from(buf.subarray(nl + 1, nl + 1 + size)) : undefined);
      const rest = buf.subarray(end);
      this.chunks = rest.length > 0 ? [rest] : [];
    }
  }
}
