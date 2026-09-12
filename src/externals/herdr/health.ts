import { runHerdr } from './cli.js';
import { asRecord } from '../../util/narrow.js';
import type { HerdrHealth } from './types.js';

/**
 * What the installed Herdr says about itself, or `undefined` when it cannot be
 * asked. `protocol` and `schemaVersion` are -1 when it answered without them.
 */
export function herdrHealth(): HerdrHealth | undefined {
  const version = runHerdr(['--version']);
  if (version.code !== 0) return undefined;

  const schema = runHerdr(['api', 'schema', '--json']);
  if (schema.code !== 0) return undefined;

  let protocol = -1;
  let schemaVersion = -1;
  try {
    const parsed = asRecord(JSON.parse(schema.stdout));
    protocol = typeof parsed.protocol === 'number' ? parsed.protocol : -1;
    schemaVersion = typeof parsed.schema_version === 'number' ? parsed.schema_version : -1;
  } catch {
    return undefined;
  }

  return {
    version: version.stdout.trim(),
    protocol,
    schemaVersion,
    integrations: integrationStatus(),
  };
}

/** `herdr integration status` parsed into name → state; `{}` when it fails. */
function integrationStatus(): Record<string, string> {
  const result = runHerdr(['integration', 'status']);
  return result.code === 0 ? parseIntegrationStatus(result.stdout) : {};
}

/**
 * One line per integration, `<name>: <state> (<path>)`. The state is two words
 * as often as one — `not installed` — so it is read up to the path rather than
 * as the next token, which used to leave every caller holding `not`.
 *
 * The path is dropped: where the hook file would go is herdr's business, and
 * every entry herdr knows about is listed whether it is installed or not, so
 * the state is the whole of the answer.
 */
export function parseIntegrationStatus(text: string): Record<string, string> {
  const status: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([a-z0-9_-]+):\s+([^(]+?)\s*(?:\(.*\))?$/.exec(line);
    if (match !== null) status[match[1] as string] = match[2] as string;
  }
  return status;
}
