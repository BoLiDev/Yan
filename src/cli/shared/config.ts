import { readVaultConfig } from '../../util/config.js';
import { recordOrNone } from '../../util/narrow.js';
import { vaultConfigPath } from '../../util/vault.js';
import { CommandError } from './errors.js';

/**
 * The `agents.*` and `scenarios.*` sections of the vault's `config.json`.
 * `remote_git` is read inside `externals/remote-git` and nowhere else.
 *
 *   agents.<role>   the CLI a role runs, with an optional model and effort.
 *                   A bare string is the CLI alone.
 *   scenarios       what a shift may be dispatched as: exactly the scenarios in
 *                   SCENARIOS, each with at least one tier. A tier overrides
 *                   agents.shift field by field.
 */

export function configPath(): string {
  return vaultConfigPath();
}

/** The kinds of work a shift is dispatched for. Fixed: `user` configures tiers, not scenarios. */
export const SCENARIOS = ['explore', 'coding', 'uix'] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** What each scenario covers, which is how the main agent chooses one. */
export const SCENARIO_DESCRIPTIONS: Record<Scenario, string> = {
  explore: 'investigating: reading code, researching, answering a question - no code meant to merge',
  coding: 'implementing a feature, fixing a bug, refactoring - code meant to merge',
  uix: 'interface and interaction design: prototypes and visual proposals',
};

/** A CLI and how to run it. An empty `model` or `effort` means the CLI's own default. */
export interface AgentSpec {
  readonly cli: string;
  readonly model: string;
  readonly effort: string;
}

/** One tier of a scenario. An empty field inherits from `agents.shift`. */
export interface Tier extends AgentSpec {
  readonly name: string;
  readonly description: string;
  /** Skills the shift invokes before it reads its brief. Never inherited. */
  readonly skills: readonly string[];
}

export interface ScenarioConfig {
  readonly name: Scenario;
  readonly description: string;
  readonly defaultTier: string;
  readonly tiers: readonly Tier[];
}

/** The scenarios as configured, and everything wrong with them. */
export interface ScenarioReading {
  readonly scenarios: readonly ScenarioConfig[];
  readonly problems: readonly string[];
}

/** A dispatch's scenario and tier, resolved against `agents.shift`. */
export interface ShiftSpec extends AgentSpec {
  readonly scenario: Scenario;
  readonly tier: string;
  readonly skills: readonly string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readConfig(): Record<string, unknown> {
  return readVaultConfig() ?? {};
}

/** `agents.<role>` in full. Every field is `''` when it is not configured. */
export function agentSpecFor(role: string): AgentSpec {
  const value = recordOrNone(readConfig().agents)?.[role];
  if (typeof value === 'string') return { cli: value.trim(), model: '', effort: '' };
  const spec = recordOrNone(value);
  return { cli: text(spec?.cli), model: text(spec?.model), effort: text(spec?.effort) };
}

/** `scenarios`, read without throwing: whatever cannot be used is named in `problems`. */
export function readScenarios(): ScenarioReading {
  const raw = recordOrNone(readConfig().scenarios);
  const problems: string[] = [];
  const scenarios: ScenarioConfig[] = [];
  if (raw === undefined) {
    return { scenarios, problems: [`no scenarios configured - add ${SCENARIOS.join(', ')}, each with at least one tier`] };
  }

  for (const key of Object.keys(raw)) {
    if (!(SCENARIOS as readonly string[]).includes(key)) {
      problems.push(`scenarios.${key} is not a scenario - they are ${SCENARIOS.join(', ')}`);
    }
  }

  for (const name of SCENARIOS) {
    const entry = recordOrNone(raw[name]);
    if (entry === undefined) {
      problems.push(`scenarios.${name} is missing`);
      continue;
    }
    const tiers: Tier[] = [];
    for (const [tierName, value] of Object.entries(recordOrNone(entry.tiers) ?? {})) {
      const tier = recordOrNone(value);
      if (tier === undefined) {
        problems.push(`scenarios.${name}.tiers.${tierName} is not an object`);
        continue;
      }
      const skills = tier.skills === undefined ? [] : tier.skills;
      if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string' || s.trim() === '')) {
        problems.push(`scenarios.${name}.tiers.${tierName}.skills is not a list of skill names - it is ignored`);
      }
      tiers.push({
        name: tierName,
        description: text(tier.description),
        cli: text(tier.cli),
        model: text(tier.model),
        effort: text(tier.effort),
        skills: Array.isArray(skills)
          ? skills.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim().replace(/^\//, ''))
          : [],
      });
    }
    if (tiers.length === 0) {
      problems.push(`scenarios.${name} has no tiers - it needs at least one`);
      continue;
    }
    let defaultTier = text(entry.default);
    if (defaultTier === '' && tiers.length === 1) defaultTier = (tiers[0] as Tier).name;
    if (!tiers.some((t) => t.name === defaultTier)) {
      problems.push(
        defaultTier === ''
          ? `scenarios.${name}.default is not set - name one of: ${tiers.map((t) => t.name).join(', ')}`
          : `scenarios.${name}.default '${defaultTier}' is not one of its tiers: ${tiers.map((t) => t.name).join(', ')}`,
      );
      continue;
    }
    scenarios.push({ name, description: SCENARIO_DESCRIPTIONS[name], defaultTier, tiers });
  }
  return { scenarios, problems };
}

/**
 * The CLI, model and effort a shift runs with: the tier's fields over
 * `agents.shift`'s. Only a configured scenario and tier can be named, so a
 * dispatch can never run a model `user` did not configure.
 *
 * @throws CommandError `usage` for a missing or unknown scenario or tier, a
 *   scenario the configuration cannot supply, or no CLI at all.
 */
export function resolveShift(command: string, scenario: string | undefined, tier: string | undefined): ShiftSpec {
  const asked = (scenario ?? '').trim();
  if (asked === '') {
    throw CommandError.usage(command, `--scenario is required - one of: ${SCENARIOS.join(' ')}`);
  }
  if (!(SCENARIOS as readonly string[]).includes(asked)) {
    throw CommandError.usage(command, `'${asked}' is not a scenario - one of: ${SCENARIOS.join(' ')}`);
  }
  const { scenarios, problems } = readScenarios();
  const found = scenarios.find((s) => s.name === asked);
  if (found === undefined) {
    const why = problems.filter((p) => p.includes(`scenarios.${asked}`) || p.startsWith('no scenarios'));
    throw CommandError.usage(command, `scenario '${asked}' cannot be used: ${why.join('; ')} - fix it in ${configPath()}`);
  }

  const tierName = (tier ?? '').trim() === '' ? found.defaultTier : (tier as string).trim();
  const chosen = found.tiers.find((t) => t.name === tierName);
  if (chosen === undefined) {
    throw CommandError.usage(command, `'${tierName}' is not a tier of ${asked} - one of: ${found.tiers.map((t) => t.name).join(' ')}`);
  }

  const base = agentSpecFor('shift');
  const cli = chosen.cli !== '' ? chosen.cli : base.cli;
  if (cli === '') {
    throw CommandError.usage(command, `${asked}/${tierName} names no cli and agents.shift is not set - set one in ${configPath()}`);
  }
  // A tier that changes the CLI does not inherit a model meant for another one.
  const sameCli = chosen.cli === '' || chosen.cli === base.cli;
  return {
    scenario: asked as Scenario,
    tier: tierName,
    cli,
    model: chosen.model !== '' ? chosen.model : sameCli ? base.model : '',
    effort: chosen.effort !== '' ? chosen.effort : sameCli ? base.effort : '',
    skills: chosen.skills,
  };
}

/** What a spec runs, in one phrase: `claude claude-opus-5 high /design`. */
export function runsAs(spec: AgentSpec & { readonly skills?: readonly string[] }): string {
  return [spec.cli, spec.model, spec.effort, ...(spec.skills ?? []).map((s) => `/${s}`)]
    .filter((x) => x !== '')
    .join(' ');
}

/** The executable's name without directory or `.exe`: `claude`, `codex`, `agy`. */
export function cliKind(cli: string): string {
  const first = cli.trim().split(/\s+/)[0] ?? '';
  return (first.split(/[\\/]/).pop() ?? first).replace(/\.exe$/, '');
}

/**
 * The flags that set a model and an effort, in the spelling `cli` takes.
 * `[]` for a CLI yan does not know, which `yan doctor` reports.
 */
export function modelFlags(cli: string, spec: { readonly model: string; readonly effort: string }): string[] {
  const kind = cliKind(cli);
  const args: string[] = [];
  if (kind === 'claude' || kind === 'agy') {
    if (spec.model !== '') args.push('--model', spec.model);
    if (spec.effort !== '') args.push('--effort', spec.effort);
  } else if (kind === 'codex') {
    if (spec.model !== '') args.push('-m', spec.model);
    // A bare value is taken as a literal string when it is not TOML.
    if (spec.effort !== '') args.push('-c', `model_reasoning_effort=${spec.effort}`);
  }
  return args;
}
