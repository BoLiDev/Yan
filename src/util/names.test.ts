import { describe, expect, it } from 'vitest';
import { isRecordId } from './names.js';

describe('isRecordId', () => {
  it('takes letters, digits, dot, dash and underscore', () => {
    for (const id of ['t042', 's3', 'my-repo', 'v1.2', 'a_b', '.hidden', 'x..y']) expect(isRecordId(id), id).toBe(true);
  });

  it('refuses a separator, a space and the empty name', () => {
    for (const id of ['a/b', 'a\\b', 'a b', '']) expect(isRecordId(id), id).toBe(false);
  });

  it('refuses dots alone, which name the directory itself or its parent', () => {
    for (const id of ['.', '..', '...']) expect(isRecordId(id), id).toBe(false);
  });
});
