import { describe, expect, it } from 'vitest';
import { initialsOf } from './letters';
import type { TaskSummary } from './api';

const t = (id: string, title: string): TaskSummary => ({ id, title, state: 'open', createdAt: null, closedAt: null, pausedAt: null, repos: [], deliverables: { done: 0, todo: 0, abandoned: 0 }, agents: [], artifacts: 0, added: [], touched: 0, rev: id });

describe('a task in one character', () => {
  it('is its first word\'s first letter in capital, its first character in Chinese, its number\'s last digit with no title', () => {
    const got = initialsOf([t('t001', 'pay retries twice'), t('t003', '修复登录跳转'), t('t004', ''), t('t005', 'Dashboard'), t('t006', '[web] 2fa login')]);
    expect([...got.values()]).toEqual(['P', '修', '4', 'D', 'W']);
  });

  it('takes the next word\'s letter, or the next character, when its first is an older task\'s, and shares it when it has no other', () => {
    const got = initialsOf([t('t004', 'Pay rent'), t('t003', '修复支付回调'), t('t002', 'poe roller support range'), t('t001', 'Pay retries twice'), t('t005', '修复登录')]);
    expect(Object.fromEntries(got)).toEqual({ t001: 'P', t002: 'R', t003: '修', t004: 'P', t005: '复' });
  });
});
