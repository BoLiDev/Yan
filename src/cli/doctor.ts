import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { yanHome } from '../util/home.js';
import { readJsonIfPresent } from '../util/json.js';
import { HERDR_PROTOCOL, HERDR_SCHEMA_VERSION, herdrHealth } from '../externals/herdr/index.js';
import { action, out } from './shared/action.js';

/**
 * `yan doctor` — the checklist, plus the Herdr section this phase earns.
 *
 * The rest of doctor is still shell, so this command RUNS THE SHELL ONE FIRST
 * and appends to it. That is the strangler applied inside a single command:
 * every existing check keeps running, unchanged, while the part this phase owns
 * is written where it belongs. Phase 9 deletes the delegation along with
 * `bin/yan-doctor.sh`.
 */

interface Report {
  ok: number;
  warn: number;
  fail: number;
}

function line(report: Report, state: 'ok' | 'warn' | 'fail', name: string, detail: string): void {
  report[state] += 1;
  const mark = state === 'ok' ? 'ok  ' : state === 'warn' ? 'WARN' : 'FAIL';
  out(`  ${mark}  ${name.padEnd(16)}${detail}`);
}

/** The agent kinds this machine's config names, e.g. { yan: 'claude', shift: 'claude' }. */
function configuredAgentKinds(): string[] {
  const config = readJsonIfPresent(join(yanHome(), 'conf', 'config.json'));
  if (typeof config !== 'object' || config === null) return [];
  const agents = (config as Record<string, unknown>).agents;
  if (typeof agents !== 'object' || agents === null) return [];
  const kinds = Object.values(agents as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string' && v !== '')
    // The value may carry trailing argv (`claude --dangerously-…`); the kind is
    // the first word.
    .map((v) => v.trim().split(/\s+/)[0] as string);
  return [...new Set(kinds)].sort();
}

export const command = new Command('doctor')
  .description('check this machine can run yan')
  .action(
    action('doctor', () => {
      const home = yanHome();

      // Everything that has not been ported yet, unchanged.
      spawnSync('bash', [join(home, 'bin', 'yan-doctor.sh')], {
        stdio: 'inherit',
        env: { ...process.env, YAN_HOME: home },
        windowsHide: true,
      });

      const report: Report = { ok: 0, warn: 0, fail: 0 };
      out('');
      out('herdr');

      const version = herdrHealth();
      if (version === undefined) {
        line(report, 'fail', 'herdr', "not answering - install it, or start it, then run 'yan doctor'");
      } else {
        line(report, 'ok', 'herdr', version.version);
        // A version check, and only a version check. Herdr ships on a preview
        // channel with no API stability promise, so the generated types are
        // pinned to a protocol and this is where drift is noticed
        // (runtime.md §4, sources.md §2).
        const drift =
          version.protocol !== HERDR_PROTOCOL || version.schemaVersion !== HERDR_SCHEMA_VERSION;
        line(
          report,
          drift ? 'warn' : 'ok',
          'protocol',
          drift
            ? `installed ${version.protocol}/${version.schemaVersion}, types generated against ${HERDR_PROTOCOL}/${HERDR_SCHEMA_VERSION} - re-run scripts/generate-herdr-types.mjs and re-check docs/v2/td/evidence.md §9`
            : `${version.protocol}, schema ${version.schemaVersion} - matches the generated types`,
        );
      }

      // Empty when herdr did not answer at all; the failure is already reported
      // above, and every kind then reads as "no integration installed".
      const installed = version?.integrations ?? {};
      const kinds = configuredAgentKinds();
      if (kinds.length === 0) {
        line(report, 'warn', 'integrations', 'conf/config.json names no agents');
      }
      for (const kind of kinds) {
        const state = installed[kind];
        if (state === undefined) {
          line(
            report,
            'warn',
            kind,
            `no herdr integration installed - 'herdr integration install ${kind}' records the agent's session id`,
          );
        } else {
          line(report, 'ok', kind, `integration ${state}`);
        }
      }

      // Said once, plainly, because the natural reading of "integration
      // installed" is exactly wrong for the two agents yan dispatches: at v7
      // the Claude and Codex integrations report SESSION IDENTITY ONLY and
      // never push state, so `blocked` and `done` are screen matches either way
      // (sources.md §4.1, evidence.md §8).
      out('');
      out('  note  an installed integration records the agent session id. It does not');
      out('        make agent state authoritative: for claude and codex, Herdr classifies');
      out('        state by matching the screen, so `run/signal` stays the other half of');
      out('        the pair (docs/v2/td/terminal.md §6).');

      out('');
      out(`herdr checks: ${report.ok} ok, ${report.warn} warn, ${report.fail} fail`);
      if (report.fail > 0) process.exitCode = 1;
    }),
  );
