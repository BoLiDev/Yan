import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir } from '../../../tests/helpers/fixtures.js';
import { atLeast, closePane, closeTab, controlCommand, createTab, herdrPane, layoutOf, paneOf, panesIn, readPane, sendInput, sendKeys, serverOf, splitPane, tabOf, versionOf } from './client.js';

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

  it('spells a controller\'s commands as herdr reads them', () => {
    expect(JSON.parse(controlCommand({ resize: { cols: 140, rows: 48 } }))).toEqual({ type: 'terminal.resize', cols: 140, rows: 48 });
    expect(JSON.parse(controlCommand({ scroll: -3, col: 10, row: 4 }))).toEqual({ type: 'terminal.scroll', direction: 'up', lines: 3, column: 10, row: 4 });
    expect(JSON.parse(controlCommand({ scroll: 2, col: 0, row: 0 }))).toMatchObject({ direction: 'down', lines: 2 });
  });

  it('asks its version and a pane, and types into it', async () => {
    const h = await fakeHerdr((method) =>
      method === 'ping' ? { result: { type: 'pong', version: '0.9.5', protocol: 22 } }
        : method === 'pane.get' ? { result: { type: 'pane_info', pane: { pane_id: 'w1:p2', agent: 'claude', agent_status: 'blocked' } } }
          : { result: { type: 'ok' } });
    servers.push(h.server);
    expect(await versionOf(h.socket)).toBe('0.9.5');
    expect(await paneOf(h.socket, 'w1:p2')).toMatchObject({ agent: 'claude', agent_status: 'blocked' });
    await sendKeys(h.socket, 'w1:p2', ['shift+tab']);
    await sendInput(h.socket, 'w1:p2', 'go on', ['enter']);
    expect(h.asked.map((a) => a.method)).toEqual(['ping', 'pane.get', 'pane.send_keys', 'pane.send_input']);
    expect(h.asked.slice(2)).toEqual([
      { method: 'pane.send_keys', params: { pane_id: 'w1:p2', keys: ['shift+tab'] } },
      { method: 'pane.send_input', params: { pane_id: 'w1:p2', text: 'go on', keys: ['enter'] } },
    ]);
  });

  it('reads how a tab is split, splits a pane and closes one', async () => {
    const pane = (id: string) => ({ type: 'pane', pane_id: id, cwd: '/code/app' });
    const h = await fakeHerdr((method) =>
      method === 'layout.export' ? { result: { type: 'layout_export', layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p2',
        root: { type: 'split', direction: 'right', ratio: 0.6, first: pane('w1:p2'), second: { type: 'split', direction: 'down', ratio: 7, first: pane('w1:p3'), second: pane('w1:p4') } } } } }
        : method === 'pane.split' ? { result: { type: 'pane_info', pane: { pane_id: 'w1:p5', agent_status: 'unknown' } } }
          : { result: { type: 'ok' } });
    servers.push(h.server);
    const layout = await layoutOf(h.socket, 'w1:p2');
    expect(layout, 'a ratio herdr could not have is taken for half').toEqual({
      split: 'right', ratio: 0.6, first: { pane: 'w1:p2' }, second: { split: 'down', ratio: 0.5, first: { pane: 'w1:p3' }, second: { pane: 'w1:p4' } },
    });
    expect(panesIn(layout)).toEqual(['w1:p2', 'w1:p3', 'w1:p4']);
    expect(await splitPane(h.socket, 'w1:p2', 'down')).toBe('w1:p5');
    await closePane(h.socket, 'w1:p5');
    expect(h.asked).toEqual([
      { method: 'layout.export', params: { pane_id: 'w1:p2' } },
      { method: 'pane.split', params: { target_pane_id: 'w1:p2', direction: 'down', focus: false } },
      { method: 'pane.close', params: { pane_id: 'w1:p5' } },
    ]);
  });

  it('finds the server a herdr command talks to, and opens a tab in it', async () => {
    if (process.platform === 'win32') return;
    const bin = join(mkTempDir(), 'herdr');
    writeFileSync(bin, `#!/bin/sh\n[ "$*" = "status server --json" ] && echo '{"status":"running","running":true,"version":"0.9.5","socket":"/run/h/herdr.sock","session":null}'\n`);
    chmodSync(bin, 0o755);
    expect(await serverOf(bin)).toEqual({ running: true, version: '0.9.5', socket: '/run/h/herdr.sock' });
    const silent = join(mkTempDir(), 'herdr');
    writeFileSync(silent, '#!/bin/sh\nexit 1\n');
    chmodSync(silent, 0o755);
    await expect(serverOf(silent)).rejects.toMatchObject({ code: 'herdr_unreachable' });

    const h = await fakeHerdr(() => ({ result: { type: 'tab_created', tab: { tab_id: 'w1:t4' }, root_pane: { pane_id: 'w1:p9', agent_status: 'unknown' } } }));
    servers.push(h.server);
    expect(await createTab(h.socket, { cwd: '/home/u', label: 'pay retries', env: { YAN_VAULT: '/v' } })).toBe('w1:p9');
    expect(h.asked).toEqual([{ method: 'tab.create', params: { cwd: '/home/u', label: 'pay retries', env: { YAN_VAULT: '/v' }, focus: false } }]);
  });

  it('reads what a pane shows, and closes the tab it is in', async () => {
    const h = await fakeHerdr((method) =>
      method === 'pane.read' ? { result: { type: 'pane_read', read: { pane_id: 'w1:p9', tab_id: 'w1:t4', text: '~ ❯ ', revision: 7, truncated: false } } }
        : method === 'layout.export' ? { result: { type: 'layout_export', layout: { workspace_id: 'w1', tab_id: 'w1:t4', zoomed: false, focused_pane_id: 'w1:p9', root: { type: 'pane', pane_id: 'w1:p9' } } } }
          : { result: { type: 'ok' } });
    servers.push(h.server);
    expect(await readPane(h.socket, 'w1:p9')).toEqual({ text: '~ ❯ ', revision: 7 });
    expect(await tabOf(h.socket, 'w1:p9')).toBe('w1:t4');
    await closeTab(h.socket, 'w1:t4');
    expect(h.asked).toEqual([
      { method: 'pane.read', params: { pane_id: 'w1:p9', source: 'visible' } },
      { method: 'layout.export', params: { pane_id: 'w1:p9' } },
      { method: 'tab.close', params: { tab_id: 'w1:t4' } },
    ]);
  });

  it('says herdr\'s own error, and that nothing answers where nothing listens', async () => {
    const h = await fakeHerdr(() => ({ error: { code: 'not_found', message: 'pane not found' } }));
    servers.push(h.server);
    await expect(paneOf(h.socket, 'w9:p9')).rejects.toMatchObject({ code: 'not_found' });
    await expect(paneOf(join(mkTempDir(), 'none.sock'), 'w1:p1')).rejects.toMatchObject({ code: 'herdr_unreachable' });
  });
});
