import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TerminalEvents } from './events.js';
import { EventsError } from './errors.js';
import { defaultEndpoint, endpointFor, herdrSocketPath } from './socket.js';
import { repoRoot } from '../../../tests/helpers/fixtures.js';

/**
 * The socket client, against a real server speaking the protocol the Phase 5
 * spike recorded (evidence §11.1).
 *
 * It is a real `net` server on a real endpoint — a named pipe on Windows, a
 * unix socket elsewhere — because the thing most likely to be wrong here is the
 * transport itself, and a fake object in front of it would prove nothing about
 * the one platform rule this module exists to hold.
 *
 * Herdr is not needed and is never started.
 */

interface FakeHerdr {
  readonly endpoint: string;
  /** Every line the client sent, parsed. */
  readonly received: Record<string, unknown>[];
  /** How many clients have connected. A reconnect is a second one. */
  connections: number;
  /** Answer the next request with this error code instead of a result. */
  refuseWith?: string;
  /** Take requests and never answer them, so one can be caught in flight. */
  holdRequests?: boolean;
  push(line: string): void;
  dropClient(): void;
  stop(): Promise<void>;
}

let servers: FakeHerdr[] = [];
let clients: TerminalEvents[] = [];
let counter = 0;

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  for (const server of servers) await server.stop();
  servers = [];
});

function endpointForTest(): string {
  counter += 1;
  const name = `yan-events-${process.pid}-${counter}`;
  // The Windows rule is exercised for real here: the address IS a pipe name.
  // The *derivation* of that name from Herdr's `.sock` path is tested purely,
  // below, so this does not depend on where herdr happens to be installed.
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`);
}

async function fakeHerdr(): Promise<FakeHerdr> {
  const endpoint = endpointForTest();
  const received: Record<string, unknown>[] = [];
  let current: Socket | undefined;

  const server: Server = createServer((socket) => {
    current = socket;
    fake.connections += 1;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === '') continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        received.push(message);
        if (fake.holdRequests === true) continue;
        const id = message.id as string;
        socket.write(
          fake.refuseWith === undefined
            ? `${JSON.stringify({ id, result: { type: 'subscription_started' } })}\n`
            : `${JSON.stringify({ id, error: { code: fake.refuseWith, message: 'no' } })}\n`,
        );
      }
    });
    socket.on('error', () => {
      // A client that goes away mid-write is normal here.
    });
  });

  const fake: FakeHerdr = {
    endpoint,
    received,
    connections: 0,
    push(line: string) {
      current?.write(`${line}\n`);
    },
    dropClient() {
      current?.destroy();
      current = undefined;
    },
    stop() {
      return new Promise<void>((resolve) => {
        current?.destroy();
        server.close(() => {
          resolve();
        });
      });
    },
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      resolve();
    });
  });
  servers.push(fake);
  return fake;
}

function client(endpoint: string): TerminalEvents {
  const events = new TerminalEvents({ endpoint, connectTimeoutMs: 5_000 });
  clients.push(events);
  return events;
}

/** Wait for `check` to become true, or fail the test. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 5_000; waited += 20) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the Windows pipe-name rule', () => {
  it('turns the .sock path into a pipe name, and leaves other platforms alone', () => {
    // evidence §11.1: `%APPDATA%\herdr\herdr.sock` is a hint file, not a
    // socket. The endpoint is a named pipe whose NAME is that path.
    expect(endpointFor('C:\\Users\\x\\AppData\\Roaming\\herdr\\herdr.sock', 'win32')).toBe(
      '\\\\.\\pipe\\C:\\Users\\x\\AppData\\Roaming\\herdr\\herdr.sock',
    );
    // A path that came out of a Git Bash environment variable has forward
    // slashes; a pipe name cannot.
    expect(endpointFor('C:/Users/x/AppData/Roaming/herdr/herdr.sock', 'win32')).toBe(
      '\\\\.\\pipe\\C:\\Users\\x\\AppData\\Roaming\\herdr\\herdr.sock',
    );
    // Applying the rule twice would produce an address nothing listens on.
    expect(endpointFor('\\\\.\\pipe\\herdr.sock', 'win32')).toBe('\\\\.\\pipe\\herdr.sock');
    expect(endpointFor('/run/user/1000/herdr/herdr.sock', 'linux')).toBe(
      '/run/user/1000/herdr/herdr.sock',
    );
  });

  it('honours $HERDR_SOCKET_PATH before any guess', () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: '/tmp/elsewhere.sock' })).toBe(
      '/tmp/elsewhere.sock',
    );
    expect(defaultEndpoint({ HERDR_SOCKET_PATH: endpointFor('/tmp/x.sock', process.platform) })).toContain(
      'x.sock',
    );
  });

  it('falls back to a location rather than to nothing', () => {
    expect(herdrSocketPath({}).endsWith('herdr.sock')).toBe(true);
  });
});

describe('events.subscribe over the socket', () => {
  it('sends the request shape the spike recorded, one subscription per pane', async () => {
    const herdr = await fakeHerdr();
    const events = client(herdr.endpoint);
    await events.open();
    await events.subscribe(['w1:p2', 'w1:p3']);

    expect(herdr.received).toHaveLength(1);
    const request = herdr.received[0] as {
      method: string;
      params: { subscriptions: { type: string; pane_id: string }[] };
    };
    expect(request.method).toBe('events.subscribe');
    expect(request.params.subscriptions).toEqual([
      { type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
      { type: 'pane.agent_status_changed', pane_id: 'w1:p3' },
    ]);
    expect(events.subscribed).toEqual(['w1:p2', 'w1:p3']);
  });

  it('does not re-subscribe to a pane it already has', async () => {
    const herdr = await fakeHerdr();
    const events = client(herdr.endpoint);
    await events.open();
    await events.subscribe(['w1:p2']);
    await events.subscribe(['w1:p2']);
    await events.subscribe(['w1:p2', 'w1:p9']);

    expect(herdr.received).toHaveLength(2);
    expect(
      (herdr.received[1] as { params: { subscriptions: { pane_id: string }[] } }).params
        .subscriptions,
    ).toEqual([{ type: 'pane.agent_status_changed', pane_id: 'w1:p9' }]);
  });

  it('refuses a label where a pane id belongs', async () => {
    const herdr = await fakeHerdr();
    const events = client(herdr.endpoint);
    await events.open();
    for (const bad of ['yan', 's3-auth', '%7', 'w1', '']) {
      await expect(events.subscribe([bad])).rejects.toMatchObject({
        code: EventsError.codes.usage,
      });
    }
  });

  it('maps a refusal onto yan vocabulary and lets no herdr code escape', async () => {
    const herdr = await fakeHerdr();
    herdr.refuseWith = 'invalid_request';
    const events = client(herdr.endpoint);
    await events.open();

    const thrown = await events.subscribe(['w1:p2']).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(EventsError);
    expect((thrown as EventsError).code).toBe(EventsError.codes.refused);
    // The pane is not remembered, so a reconnect does not restore a
    // subscription that was never established.
    expect(events.subscribed).toEqual([]);
  });

  it('says it cannot reach a socket that is not there', async () => {
    const events = new TerminalEvents({
      endpoint: endpointForTest(),
      connectTimeoutMs: 2_000,
    });
    const thrown = await events.open().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(EventsError);
    expect((thrown as EventsError).code).toBe(EventsError.codes.unreachable);
  });
});

describe('what arrives on a subscription', () => {
  it('is one status per pane, in yan words', async () => {
    const herdr = await fakeHerdr();
    const events = client(herdr.endpoint);
    const seen: { pane: string; status: string; kind: string }[] = [];
    events.onStatus((e) => seen.push({ ...e }));
    await events.open();
    await events.subscribe(['w1:p2']);

    herdr.push(
      JSON.stringify({
        event: 'pane.agent_status_changed',
        data: { agent: 'claude', agent_status: 'blocked', pane_id: 'w1:p2', workspace_id: 'w1' },
      }),
    );
    await until(() => seen.length === 1, 'the status event');
    expect(seen[0]).toEqual({ pane: 'w1:p2', status: 'blocked', kind: 'claude' });
  });

  it('reports a status it does not recognise as unknown, never as itself', async () => {
    const herdr = await fakeHerdr();
    const events = client(herdr.endpoint);
    const seen: string[] = [];
    events.onStatus((e) => seen.push(e.status));
    await events.open();
    await events.subscribe(['w1:p2']);

    herdr.push(
      JSON.stringify({
        event: 'pane.agent_status_changed',
        data: { agent_status: 'thinking-very-hard', pane_id: 'w1:p2' },
      }),
    );
    await until(() => seen.length === 1, 'the status event');
    expect(seen[0]).toBe('unknown');
  });

  it('ignores other event kinds and unreadable lines without dying', async () => {
    const herdr = await fakeHerdr();
    const events = client(herdr.endpoint);
    const seen: string[] = [];
    events.onStatus((e) => seen.push(e.pane));
    await events.open();
    await events.subscribe(['w1:p2']);

    herdr.push('warning: this is a preview build');
    herdr.push(JSON.stringify({ event: 'pane_exited', data: { pane_id: 'w1:p2' } }));
    herdr.push(
      JSON.stringify({
        event: 'pane.agent_status_changed',
        data: { agent_status: 'done', pane_id: 'w1:p2' },
      }),
    );
    await until(() => seen.length === 1, 'the one event that counts');
    expect(seen).toEqual(['w1:p2']);
  });
});

describe('a subscription that ends', () => {
  it('is reported, and reconnecting subscribes again', async () => {
    // supervision.md §2: reconnect is not optional. The spike never saw a Herdr
    // restart under a subscriber, so the path is tested by ENDING THE
    // CONNECTION under it rather than by hoping.
    const herdr = await fakeHerdr();
    const events = client(herdr.endpoint);
    let closed = 0;
    events.onClosed(() => {
      closed += 1;
    });
    await events.open();
    await events.subscribe(['w1:p2']);
    expect(events.connected).toBe(true);

    herdr.dropClient();
    await until(() => closed === 1, 'the closed notification');
    expect(events.connected).toBe(false);

    await events.reconnect(['w1:p2', 'w1:p4']);
    expect(events.connected).toBe(true);
    expect(herdr.connections).toBe(2);
    expect(events.subscribed).toEqual(['w1:p2', 'w1:p4']);

    const last = herdr.received[herdr.received.length - 1] as {
      params: { subscriptions: { pane_id: string }[] };
    };
    expect(last.params.subscriptions.map((s) => s.pane_id)).toEqual(['w1:p2', 'w1:p4']);

    // And the new connection really carries events.
    const seen: string[] = [];
    events.onStatus((e) => seen.push(e.status));
    herdr.push(
      JSON.stringify({
        event: 'pane.agent_status_changed',
        data: { agent_status: 'blocked', pane_id: 'w1:p4' },
      }),
    );
    await until(() => seen.length === 1, 'an event on the new connection');
    expect(seen[0]).toBe('blocked');
  });

  it('fails a request that was in flight, rather than hanging on it', async () => {
    const herdr = await fakeHerdr();
    herdr.holdRequests = true;
    const events = client(herdr.endpoint);
    await events.open();
    const inFlight = events.subscribe(['w1:p2']);
    await until(() => herdr.received.length === 1, 'the request to arrive');
    herdr.dropClient();
    const thrown = await inFlight.catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(EventsError);
    expect((thrown as EventsError).code).toBe(EventsError.codes.closed);
  });
});

describe('the module cannot move the user or close anything', () => {
  const source = readdirSync(join(repoRoot, 'src', 'externals', 'herdr'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(repoRoot, 'src', 'externals', 'herdr', f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('never spells focus, close or stop as a herdr verb', () => {
    // conventions §5, regressions 5 and 6, applied to the second module that
    // talks to Herdr: focusing marks a tab seen and turns the `done` yan is
    // waiting for into an `idle` it ignores.
    expect(source).not.toContain('agent focus');
    expect(source).not.toContain('pane.focus');
    expect(source).not.toContain('workspace.close');
    expect(source).not.toContain('pane.close');
    expect(source).not.toContain('server.stop');
  });

  it('sends exactly one method', () => {
    const methods = [...source.matchAll(/'(events\.[a-z_]+)'/g)].map((m) => m[1]);
    expect([...new Set(methods)]).toEqual(['events.subscribe']);
  });
});
