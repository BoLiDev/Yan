/**
 * The harness payload on stdin, or `''` when none arrives within `timeoutMs`.
 *
 * Never a read to EOF: a hook holds the harness's turn open while it runs, so
 * a pipe nobody closes would stall the session rather than this process alone.
 * A terminal on stdin is nobody piping anything, and answers at once.
 */
export function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY === true) return Promise.resolve('');
  return new Promise<string>((resolve) => {
    let text = '';
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
