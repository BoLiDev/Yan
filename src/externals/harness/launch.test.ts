import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { herdrIntegration, hooksFile, isKnownCli, launchArgs, modelFlags, promptInArgv } from './launch.js';

describe('modelFlags', () => {
  const spec = { model: 'm', effort: 'e' };

  it("speaks each CLI's spelling", () => {
    expect(modelFlags('claude', spec)).toEqual(['--model', 'm', '--effort', 'e']);
    expect(modelFlags('C:/tools/agy.exe', spec)).toEqual(['--model', 'm', '--effort', 'e']);
    expect(modelFlags('codex', spec)).toEqual(['-m', 'm', '-c', 'model_reasoning_effort=e']);
  });

  it('passes nothing that was not configured, and nothing to a CLI it does not know', () => {
    expect(modelFlags('claude', { model: '', effort: '' })).toEqual([]);
    expect(modelFlags('codex', { model: '', effort: 'high' })).toEqual(['-c', 'model_reasoning_effort=high']);
    expect(modelFlags('node', spec)).toEqual([]);
  });
});

describe('launchArgs', () => {
  const dirs = { workdir: '/tree/apps/web', addDirs: ['/tree/apps/common'] };
  const none = { model: '', effort: '' };

  /** What `yan continue` asks for, and what `yan shift new` asks for with a coding shift. */
  const main = (cli: string): string[] => launchArgs(cli, { ...none, ...dirs });
  const shift = (cli: string, readOnly = false): string[] =>
    launchArgs(cli, { ...none, ...dirs, readOnly, prompt: 'Read brief.md' });

  it('gives the main agent and a shift the same argv on one CLI, the prompt aside', () => {
    for (const cli of ['claude', 'codex', 'agy', '/opt/bin/claude']) {
      const tail = promptInArgv(cli) ? ['-i', 'Read brief.md'] : [];
      expect(shift(cli), cli).toEqual([...main(cli), ...tail]);
    }
  });

  it('runs every CLI unattended', () => {
    expect(main('claude')).toEqual(['--add-dir', '/tree/apps/common', '--dangerously-skip-permissions']);
    expect(main('codex')).toEqual(['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']);
    expect(main('agy')).toEqual(['--add-dir', '/tree/apps/web', '--add-dir', '/tree/apps/common', '--dangerously-skip-permissions']);
  });

  it('keeps a report-only shift from pushing without parking it on an approval', () => {
    expect(shift('claude', true)).toContain('Bash(git push:*)');
    expect(shift('claude', true)).not.toContain('plan');
    expect(shift('codex', true)).toEqual(['--sandbox', 'read-only', '--dangerously-bypass-hook-trust']);
  });

  it('puts the model flags first', () => {
    expect(launchArgs('codex', { model: 'gpt-5', effort: 'high', ...dirs }).slice(0, 4)).toEqual(['-m', 'gpt-5', '-c', 'model_reasoning_effort=high']);
  });

  it('carries the prompt only for agy, and nothing at all for a CLI it does not know', () => {
    expect(promptInArgv('agy')).toBe(true);
    expect(promptInArgv('claude')).toBe(false);
    expect(promptInArgv('codex')).toBe(false);
    expect(shift('claude')).not.toContain('Read brief.md');
    expect(shift('node')).toEqual([]);
    expect(promptInArgv('node')).toBe(false);
  });
});

describe('what yan doctor checks', () => {
  it('names the herdr integration, which for agy is not the executable', () => {
    expect(herdrIntegration('agy')).toBe('antigravity-cli');
    expect(herdrIntegration('/usr/local/bin/claude')).toBe('claude');
    expect(herdrIntegration('node')).toBe('node');
  });

  it('knows three CLIs', () => {
    expect(['claude', 'codex', 'agy', 'C:/tools/agy.exe'].every(isKnownCli)).toBe(true);
    expect(isKnownCli('node')).toBe(false);
  });

  it("finds yan's hook file for each", () => {
    expect(hooksFile('codex', '/yan')).toBe(join('/yan', '.codex', 'hooks.json'));
    expect(hooksFile('agy', '/yan')).toBe(join('/yan', '.agents', 'hooks.json'));
  });
});
