import type { ConversationResponse } from '@maggot/contracts';
import type { LocalAmountRef } from '../../local/privacy/chat-redaction.js';

export function assertChatAmountCurrency(ref: LocalAmountRef, currency: string): void {
  if ((ref.currency ?? 'CNY') !== currency) {
    throw new Error('目前需要使用与基础资料相同的币种，请先换算后告诉我。');
  }
}

/** 金额解引用只在浏览器执行，并在进入计算器前检查币种。 */
export function resolvePlanAmount(
  plan: Extract<ConversationResponse, { type: 'plan' }>,
  amounts: LocalAmountRef[],
  currency: string,
  monthlyIncome: number,
): number {
  const ref = amounts.find(item => item.id === plan.amountRef);
  if (ref) assertChatAmountCurrency(ref, currency);
  const amount = plan.amountRef === 'monthly_income'
    ? monthlyIncome * plan.horizonMonths
    : ref ? ref.cents * (plan.amountMode === 'per_month' ? plan.horizonMonths : 1) : undefined;
  if (amount === undefined) throw new Error('这笔金额暂时没有识别出来，请重新告诉我预算。');
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 10_000_000_000) {
    throw new Error('这笔预算超出当前支持范围，请缩短期限或调整金额。');
  }
  return amount;
}
