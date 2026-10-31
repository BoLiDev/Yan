import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir } from '../../../tests/helpers/fixtures.js';
import { atLeast, herdrPane, paneOf, paneSize, sendInput, sendKeys, versionOf } from './client.js';

afterAll(cleanupTempDirs);

/** A herdr that answers each request with what `answer` makes of it, and keeps what it was asked. */
function fakeHerdr(answer: (method: string, params: Record<string, unknown>) => unknown): Promise<{ socket: string; asked: { method: string; params: Record<string, unknown> }[]; server: Server }> {
  const socket = join(mkTempDir(), 'herdr.sock');
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer((conn) => {
    let got = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      got += chunk;
      const nl = got.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(got.slice(0, nl)) as { id: string; method: string; params: Record<string, unknown> };
      asked.push({ method: req.method, params: req.params });
      conn.end(`${JSON.stringify({ id: req.id, ...(answer(req.method, req.params) as object) })}\n`);
    });
  });
  return new Promise((resolve) => server.listen(socket, () => resolve({ socket, asked, server })));
}

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

describe('herdr', () => {
  it('finds the pane yan runs in only inside herdr', () => {
    expect(herdrPane({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2', HERDR_SOCKET_PATH: '/s/herdr.sock' })).toEqual({ pane: 'w1:p2', socket: '/s/herdr.sock', bin: 'herdr' });
    expect(herdrPane({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2', HERDR_SOCKET_PATH: '/s/herdr.sock', HERDR_BIN_PATH: '/opt/herdr' })?.bin).toBe('/opt/herdr');
    expect(herdrPane({ HERDR_PANE_ID: 'w1:p2', HERDR_SOCKET_PATH: '/s/herdr.sock' })).toBeUndefined();
    expect(herdrPane({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/s/herdr.sock' })).toBeUndefined();
  });

  it('compares versions part by part', () => {
    expect(atLeast('0.9.5', '0.7.2')).toBe(true);
    expect(atLeast('0.7.2', '0.7.2')).toBe(true);
    expect(atLeast('0.7.10', '0.7.2')).toBe(true);
    expect(atLeast('0.6.10', '0.7.2')).toBe(false);
    expect(atLeast('', '0.7.2')).toBe(false);
  });

  it('asks its version, a pane and its size, and types into it', async () => {
    const h = await fakeHerdr((method) =>
      method === 'ping' ? { result: { type: 'pong', version: '0.9.5', protocol: 22 } }
        : method === 'pane.get' ? { result: { type: 'pane_info', pane: { pane_id: 'w1:p2', agent: 'claude', agent_status: 'blocked' } } }
          : method === 'pane.layout' ? { result: { type: 'pane_layout', layout: { panes: [{ pane_id: 'w1:p1', rect: { width: 40, height: 30 } }, { pane_id: 'w1:p2', rect: { width: 110, height: 42 } }] } } }
            : { result: { type: 'ok' } });
    servers.push(h.server);
    expect(await versionOf(h.socket)).toBe('0.9.5');
    expect(await paneOf(h.socket, 'w1:p2')).toMatchObject({ agent: 'claude', agent_status: 'blocked' });
    expect(await paneSize(h.socket, 'w1:p2')).toEqual({ cols: 110, rows: 42 });
    await sendKeys(h.socket, 'w1:p2', ['shift+tab']);
    await sendInput(h.socket, 'w1:p2', 'go on', ['enter']);
    expect(h.asked.map((a) => a.method)).toEqual(['ping', 'pane.get', 'pane.layout', 'pane.send_keys', 'pane.send_input']);
    expect(h.asked.slice(3)).toEqual([
      { method: 'pane.send_keys', params: { pane_id: 'w1:p2', keys: ['shift+tab'] } },
      { method: 'pane.send_input', params: { pane_id: 'w1:p2', text: 'go on', keys: ['enter'] } },
    ]);
  });

  it('says herdr\'s own error, and that nothing answers where nothing listens', async () => {
    const h = await fakeHerdr(() => ({ error: { code: 'not_found', message: 'pane not found' } }));
    servers.push(h.server);
    await expect(paneOf(h.socket, 'w9:p9')).rejects.toMatchObject({ code: 'not_found' });
    expect(await paneSize(h.socket, 'w9:p9'), 'a herdr without pane.layout gives no size').toBeUndefined();
    await expect(paneOf(join(mkTempDir(), 'none.sock'), 'w1:p1')).rejects.toMatchObject({ code: 'herdr_unreachable' });
  });
});
