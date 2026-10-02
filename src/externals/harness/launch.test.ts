import { describe, expect, it } from 'vitest';
import { WAIT_LINE, cliKind, isKnownCli, launchArgs } from './launch.js';

const plain = { model: '', effort: '', workdir: '/tree', addDirs: [], prompt: 'the prompt', skipPermissions: false };

describe('launchArgs', () => {
  it('gives claude the prompt as its system prompt, so nothing starts a turn', () => {
    expect(launchArgs('claude', plain)).toEqual(['--append-system-prompt', 'the prompt']);
  });

  it('gives codex the prompt as developer instructions, quoted as a TOML string', () => {
    const args = launchArgs('codex', { ...plain, prompt: 'say "hi"\nthen wait' });
    expect(args).toEqual(['-c', 'developer_instructions="say \\"hi\\"\\nthen wait"']);
  });

  it('gives agy its workspace and the prompt as a first message that asks it to wait', () => {
    expect(launchArgs('agy', plain)).toEqual(['--add-dir', '/tree', '-i', `the prompt\n${WAIT_LINE}`]);
  });

  it("speaks each CLI's spelling of a model and an effort, first", () => {
    const spec = { ...plain, model: 'm', effort: 'e' };
    expect(launchArgs('claude', spec).slice(0, 4)).toEqual(['--model', 'm', '--effort', 'e']);
    expect(launchArgs('C:/tools/agy.exe', spec).slice(0, 4)).toEqual(['--model', 'm', '--effort', 'e']);
    expect(launchArgs('codex', spec).slice(0, 4)).toEqual(['-m', 'm', '-c', 'model_reasoning_effort=e']);
  });

  it("skips each CLI's approvals with its own flag, ahead of the prompt", () => {
    const skip = { ...plain, skipPermissions: true };
    expect(launchArgs('claude', skip)).toEqual(['--dangerously-skip-permissions', '--append-system-prompt', 'the prompt']);
    expect(launchArgs('codex', skip)[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
    expect(launchArgs('agy', skip)[0]).toBe('--dangerously-skip-permissions');
  });

  it("hands every CLI the task's other trees as --add-dir", () => {
    const more = { ...plain, addDirs: ['/b', '/c'] };
    expect(launchArgs('claude', more)).toEqual(['--add-dir', '/b', '--add-dir', '/c', '--append-system-prompt', 'the prompt']);
    expect(launchArgs('codex', more).slice(0, 4)).toEqual(['--add-dir', '/b', '--add-dir', '/c']);
    expect(launchArgs('agy', more).slice(0, 6)).toEqual(['--add-dir', '/tree', '--add-dir', '/b', '--add-dir', '/c']);
  });

  it('knows three CLIs and nothing else', () => {
    expect(['claude', '/usr/local/bin/codex', 'agy.exe'].map(isKnownCli)).toEqual([true, true, true]);
    expect(isKnownCli('node')).toBe(false);
    expect(launchArgs('node', plain)).toEqual([]);
    expect(cliKind('C:\\bin\\codex.exe --flag')).toBe('codex');
  });
});
