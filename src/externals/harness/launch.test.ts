import { describe, expect, it } from 'vitest';
import { modelFlags } from './launch.js';

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
