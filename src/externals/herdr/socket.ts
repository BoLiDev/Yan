import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Herdr's socket is, and what a client actually connects to. On Windows
 * the published path is a hint file, not a socket: the endpoint is a named
 * pipe whose name is that path. On Linux it is an ordinary unix socket.
 */

/**
 * The socket path Herdr publishes, before any transport rule is applied.
 * `$HERDR_SOCKET_PATH` overrides it.
 */
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
 * The address to hand `net.connect`, given the published socket path. Takes
 * the platform explicitly so the rule can be tested on either. A path that is
 * already a pipe name is returned unchanged.
 */
export function endpointFor(socketPath: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return socketPath;
  const asPipe = socketPath.replace(/\//g, '\\');
  if (asPipe.startsWith('\\\\.\\pipe\\')) return asPipe;
  return `\\\\.\\pipe\\${asPipe}`;
}

/** Where this machine's Herdr is listening. */
export function defaultEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return endpointFor(herdrSocketPath(env), process.platform);
}
