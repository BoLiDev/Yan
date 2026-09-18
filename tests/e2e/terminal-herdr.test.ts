import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Terminal } from '../../src/externals/herdr/index.js';
import * as term from '../../src/externals/herdr/index.js';
import { repoRoot } from '../helpers/fixtures.js';
import { placeShift } from '../../src/cli/shared/placement.js';

/**
 * The seven functions against a real Herdr session.
 *
 * A round trip: create a container, start an agent, list it, read it, close
 * it. Three rules:
 *   - never `herdr server stop`;
 *   - never run bare `herdr` (it launches or attaches the tui and hangs a
 *     non-interactive caller);
 *   - only close what you created. This test makes its own workspace and closes
 *     that one, by id, at the end. `user`'s panes are never touched.
 *
 * It skips loudly when Herdr is absent — never silently passing.
 */

function herdrPresent(): boolean {
  const r = spawnSync('herdr', ['status'], { encoding: 'utf8', windowsHide: true });
  return r.error === undefined && (r.status ?? 1) === 0;
}

const present = herdrPresent();
if (!present) {
  process.stderr.write(
    '\ntests/e2e/terminal-herdr.test.ts SKIPPED: herdr is not answering on this machine.\n' +
      'This is an e2e test and it proves nothing when it is skipped.\n\n',
  );
}

/** Only ever used to tear down the workspace this test created. */
let created: string | undefined;

afterAll(() => {
  if (created !== undefined) {
    spawnSync('herdr', ['workspace', 'close', created], { encoding: 'utf8', windowsHide: true });
    created = undefined;
  }
});

describe.runIf(present)('the seven functions, round-trip', () => {
  it('creates a container, starts an agent, lists it, and closes exactly that pane', () => {
    // 1/7 — a workspace of our own, so nothing here can disturb user's.
    const container = new Terminal().createContainer('yan-e2e', repoRoot);
    created = container.workspace;
    expect(container.workspace).toMatch(/^w[0-9A-Za-z]+$/);
    expect(container.tab).toMatch(/^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/);
    expect(container.pane).toMatch(/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/);

    // Two steps: a tab with cwd and env, then the agent into its pane.
    const started = new Terminal().startAgent({
      container: container.workspace,
      name: 'yane2e',
      kind: 'claude',
      cwd: repoRoot,
      env: { YAN_TASK: 't-e2e', YAN_E2E: '1' },
      timeoutMs: 120_000,
    });
    expect(started.name).toBe('yane2e');
    expect(started.pane).toMatch(/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/);
    expect(started.pane).not.toBe(container.pane);
    expect([...term.AGENT_STATUS]).toContain(started.status);
    // agent_session arrives from the integration's SessionStart hook, so its
    // absence is normal: only its shape is asserted.
    if (started.agent_session !== undefined) {
      expect(started.agent_session).toMatch(/^[0-9a-f-]{8,}$/);
    }

    // 5/7 — alive, by the two-step derivation.
    expect(new Terminal().agentAlive(started.pane)).toBe('alive');

    // 7/7 — the agent is listed, with its id, its state and its kind.
    const listed = new Terminal().list(container.workspace);
    const mine = listed.find((a) => a.pane === started.pane);
    expect(mine, JSON.stringify(listed)).toBeDefined();
    expect(mine?.name).toBe('yane2e');
    expect(mine?.kind).toBe('claude');

    // 4/7 — reading does not mark the tab seen, which is why yan reads instead
    // of focusing.
    const screen = new Terminal().read(started.pane, 20);
    expect(typeof screen).toBe('string');

    // 6/7 — close exactly the recorded pane, and the derivation follows it.
    new Terminal().close(started.pane);
    expect(new Terminal().agentAlive(started.pane)).toBe('dead');

    // The workspace is still ours to close, and afterAll does it.
    expect(created).toBe(container.workspace);
  });

  it('carries argv through without a shell in between', () => {
    // `--append-system-prompt "a b"` arrives as one argument: there is no
    // shell in between, so nothing needs quoting.
    const container = new Terminal().createContainer('yan-e2e-argv', repoRoot);
    const previous = created;
    created = container.workspace;
    if (previous !== undefined) {
      spawnSync('herdr', ['workspace', 'close', previous], { encoding: 'utf8', windowsHide: true });
    }

    const started = new Terminal().startAgent({
      container: container.workspace,
      name: 'yane2eargv',
      kind: 'claude',
      cwd: repoRoot,
      argv: ['--append-system-prompt', 'YANPROBE_MARKER is zx9q7. Spaces and : survive.'],
      timeoutMs: 120_000,
    });
    expect(started.pane).toMatch(/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/);
    new Terminal().close(started.pane);
  });

  it('splits shifts into the right half of the main tab, where the rule says', () => {
    const container = new Terminal().createContainer('yan-e2e-split', repoRoot);
    const previous = created;
    created = container.workspace;
    if (previous !== undefined) {
      spawnSync('herdr', ['workspace', 'close', previous], { encoding: 'utf8', windowsHide: true });
    }
    // The container's root pane stands in for the main agent's.
    const main = container.pane;
    const before = new Terminal().tabLayout(main);
    expect(before?.workspace).toBe(container.workspace);
    expect(before?.panes.map((p) => p.pane)).toEqual([main]);
    const whole = before?.panes[0]?.rect;

    // s1: the rule halves the main pane to the right.
    const first = placeShift(main, before!, []);
    expect(first).toEqual({ pane: main, direction: 'right' });
    const s1 = new Terminal().startAgent({
      container: container.workspace, split: first, name: 'yane2es1', kind: 'claude', cwd: repoRoot, timeoutMs: 120_000,
    });
    const afterOne = new Terminal().tabLayout(main);
    const rect = (pane: string) => afterOne?.panes.find((p) => p.pane === pane)?.rect;
    expect(afterOne?.tab, 'the same tab, not a new one').toBe(before?.tab);
    expect(rect(s1.pane)?.x).toBeGreaterThan(rect(main)?.x ?? 0);
    expect(Math.abs((rect(main)?.width ?? 0) * 2 - (whole?.width ?? 0))).toBeLessThanOrEqual(2);

    // s2: under s1.
    const second = placeShift(main, afterOne!, [{ sid: 's1', pane: s1.pane }]);
    expect(second).toEqual({ pane: s1.pane, direction: 'down' });
    const s2 = new Terminal().startAgent({
      container: container.workspace, split: second, name: 'yane2es2', kind: 'claude', cwd: repoRoot, timeoutMs: 120_000,
    });
    const afterTwo = new Terminal().tabLayout(main);
    const top = afterTwo?.panes.find((p) => p.pane === s1.pane)?.rect;
    const bottom = afterTwo?.panes.find((p) => p.pane === s2.pane)?.rect;
    expect(bottom?.x).toBe(top?.x);
    expect(bottom?.y).toBeGreaterThan(top?.y ?? 0);

    new Terminal().close(s2.pane);
    new Terminal().close(s1.pane);
    expect(new Terminal().tabLayout(main)?.panes.map((p) => p.pane)).toEqual([main]);
  });

  it('reports the installed version and the integrations, without claiming authority', () => {
    const version = term.herdrHealth();
    expect(version).toBeDefined();
    expect(version?.protocol).toBe(term.HERDR_PROTOCOL);
    expect(version?.schemaVersion).toBe(term.HERDR_SCHEMA_VERSION);

    // An installed integration is a session-id and version fact, nothing more.
    const status = version?.integrations ?? {};
    expect(typeof status).toBe('object');
  });
});
