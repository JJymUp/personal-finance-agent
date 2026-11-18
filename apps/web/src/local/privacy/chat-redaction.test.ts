import { describe, it, expect } from 'vitest';
import { redactChatText } from './chat-redaction.js';

describe('chat privacy boundary', () => {
  it('keeps a 20万 purchase amount local while preserving the natural-language question', () => {
    const out = redactChatText('我买一辆20万的车是否支持？', []);
    expect(out.text).toBe('我买一辆[金额:amount_1]的车是否支持？');
    expect(out.amounts).toEqual([{ id: 'amount_1', cents: 20_000_000 }]);
  });
  it('handles Chinese money and hides accounts, email and the known nickname', () => {
    const out = redactChatText('我是小王，存款两万五千元，账号6222021234567890123，邮箱test@example.com', [], '小王');
    expect(out.text).not.toMatch(/小王|两万五千|622202|test@example/);
    expect(out.amounts[0]?.cents).toBe(2_500_000);
  });
  it('keeps timing information and reuses previous local money references', () => {
    const out = redactChatText('那12个月后买200,000元的车呢？', [{ id: 'amount_1', cents: 20_000_000 }]);
    expect(out.text).toContain('12个月');
    expect(out.text).toContain('[金额:amount_1]');
    expect(out.amounts).toHaveLength(1);
  });
});
