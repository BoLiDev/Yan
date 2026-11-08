#!/usr/bin/env node
/**
 * A fake herdr for a monkey's sandbox, so the page's Terminal, Agents and the
 * task menu's typing into an agent can be walked without the user's own
 * herdr: the one the e2e tests stand up (tests/helpers/fake-herdr.ts), kept
 * running until this process is stopped.
 *
 *   node .claude/skills/monkey/herdr.mjs <sandbox> &
 *
 * It writes, in <sandbox>/herdr/:
 *   env.sh       the variables a program in its agent pane sees: source it
 *                before bare yan, and yan takes itself for an agent in a
 *                herdr pane, which `yan serve` then shows and types into
 *   state.json   every second: its tabs and panes, what each pane was sent,
 *                the streams yan opened; what the program in a pane would see
 *   ctl          append `agent <pane> working|blocked|done|idle` to change
 *                what herdr says of the agent in a pane
 *
 * Its first tab, w1:t1, holds the agent's pane w1:p2 and a shell, w1:p3.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sandbox = process.argv[2];
if (sandbox === undefined || !existsSync(join(sandbox, 'SANDBOX.md'))) {
  process.stderr.write('usage: node .claude/skills/monkey/herdr.mjs <sandbox made by sandbox.mjs>\n');
  process.exit(1);
}
const jitiPath = join(repoRoot, 'node_modules', 'jiti', 'lib', 'jiti.mjs');
if (!existsSync(jitiPath)) {
  process.stderr.write(`herdr: no jiti in ${dirname(jitiPath)} to load tests/helpers/fake-herdr.ts with; herdr's features are out of this walk\n`);
  process.exit(1);
}
const { createJiti } = await import(jitiPath);
const { startFakeHerdr, AGENT_PANE } = await createJiti(import.meta.url).import(join(repoRoot, 'tests', 'helpers', 'fake-herdr.ts'));

const h = await startFakeHerdr({ version: '0.9.5' });
const dir = join(resolve(sandbox), 'herdr');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'env.sh'), `export HERDR_ENV=1 HERDR_PANE_ID=${AGENT_PANE} HERDR_SOCKET_PATH=${JSON.stringify(h.socket)} HERDR_BIN_PATH=${JSON.stringify(h.bin)}\n`);
const ctl = join(dir, 'ctl');
appendFileSync(ctl, '');

let read = readFileSync(ctl, 'utf8').length;
const tick = setInterval(() => {
  const text = readFileSync(ctl, 'utf8');
  for (const line of text.slice(read).split('\n')) {
    const [verb, pane, status] = line.trim().split(/\s+/);
    if (verb === 'agent' && pane && status) h.agentIs(pane, status);
  }
  read = text.length;
  const tabs = h.tabs();
  const panes = [...new Set(tabs.flatMap((t) => t.panes))];
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
    socket: h.socket,
    bin: h.bin,
    tabs,
    panes: Object.fromEntries(panes.map((p) => [p, { received: h.received(p), cwd: h.cwdOf(p), scrolledBack: h.scrolledBack(p) }])),
    controllers: h.controllers(),
  }, null, 2)}\n`);
}, 1000);

process.stdout.write(`fake herdr on ${h.socket}; . ${join(dir, 'env.sh')} before bare yan to run it in pane ${AGENT_PANE}\n`);
const stop = async () => {
  clearInterval(tick);
  await h.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
