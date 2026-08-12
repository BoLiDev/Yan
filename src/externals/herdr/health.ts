import { runHerdr } from './cli.js';
import { asRecord } from './parse.js';
import type { HerdrHealth } from './types.js';

/**
 * What the installed Herdr says about itself.
 *
 * A module function rather than a method on `Terminal`, because `yan doctor`
 * asks it precisely when the terminal may not be usable at all — constructing
 * something first would be the wrong shape.
 *
 * `yan doctor` compares the two stamps against the ones in `schema.ts`. That is
 * a version check and NOTHING MORE: a matching protocol says the wire shapes
 * agree, not that Herdr's view of an agent is authoritative — for Claude and
 * Codex it is not, and wording it that way in `doctor` output would mislead.
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

/** `herdr integration status`, one line per kind, parsed into name → state. */
function integrationStatus(): Record<string, string> {
  const result = runHerdr(['integration', 'status']);
  if (result.code !== 0) return {};
  const status: Record<string, string> = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*([a-z0-9_-]+):\s+(\S+)/.exec(line);
    if (match !== null) status[match[1] as string] = match[2] as string;
  }
  return status;
}
