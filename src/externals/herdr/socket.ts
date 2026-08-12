import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Herdr's socket is, and what a client actually connects to.
 *
 * The windows pipe-name rule (evidence §11.1). `%APPDATA%\herdr\herdr.sock` is
 * not a socket at all: it is a hint file whose whole content is
 * `<server-pid>:<nanos>`. Connecting to it as a path gives `ENOTSOCK`, and the
 * number inside it is not a tcp port either. The real endpoint is a named pipe
 * whose name is that path:
 *
 *     \\.\pipe\C:\Users\…\AppData\Roaming\herdr\herdr.sock
 *
 * That is the whole rule, and it is the reason this file exists rather than the
 * one line `net.connect(socketPath)` a reader would expect.
 *
 * On Linux the same path is an ordinary unix domain socket and is connected to
 * directly. Herdr on WSL is unverified (conventions §1), so the candidate
 * locations below are the documented xdg ones and not measurements — which is
 * why `$HERDR_SOCKET_PATH` is honoured first and is the escape hatch when a
 * guess is wrong.
 */

/** The socket path Herdr publishes, before any transport rule is applied. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HERDR_SOCKET_PATH;
  if (explicit !== undefined && explicit !== '') return explicit;

  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'herdr', 'herdr.sock');
  }
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && runtime !== '') return join(runtime, 'herdr', 'herdr.sock');
  return join(homedir(), '.local', 'share', 'herdr', 'herdr.sock');
}

/**
 * The address to hand `net.connect`, given the published socket path.
 *
 * Exported with an explicit platform so the rule can be tested on the platform
 * it is not running on. A pipe name that is already one is left alone: passing
 * `\\.\pipe\…` through twice would produce an address nothing listens on.
 */
export function endpointFor(socketPath: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return socketPath;
  // The path with backslashes, and no other normalisation: a pipe name is
  // matched against what the server created, not compared against a path yan
  // built, so `util/paths` has no business here.
  const asPipe = socketPath.replace(/\//g, '\\');
  if (asPipe.startsWith('\\\\.\\pipe\\')) return asPipe;
  return `\\\\.\\pipe\\${asPipe}`;
}

/** Where this machine's Herdr is listening. */
export function defaultEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return endpointFor(herdrSocketPath(env), process.platform);
}
