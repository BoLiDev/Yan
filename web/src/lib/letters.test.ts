import { describe, expect, it } from 'vitest';
import { initialsOf } from './letters';
import type { TaskSummary } from './api';

const t = (id: string, title: string): TaskSummary => ({ id, title, state: 'open', createdAt: null, closedAt: null, repos: [], deliverables: { done: 0, todo: 0, abandoned: 0 }, agents: [], artifacts: 0, added: [], touched: 0, rev: id });

describe('a task in two letters', () => {
  it('is its first two words\' first letters, its first character in Chinese, its number with no title', () => {
    const got = initialsOf([t('t001', 'Pay retries twice'), t('t002', 'poe-tools-alter-blade'), t('t003', '修复登录跳转'), t('t004', ''), t('t005', 'Dashboard')]);
    expect([...got.values()]).toEqual(['PR', 'PT', '修', '04', 'DA']);
  });

  it('takes the next letters of its own when the likeliest are another task\'s', () => {
    const got = initialsOf([t('t001', 'Pay retries twice'), t('t002', 'poe roller support range'), t('t003', 'Pay rent')]);
    expect([...got.values()]).toEqual(['PR', 'PO', 'PA']);
  });
});
