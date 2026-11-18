import { describe, it, expect } from 'vitest';
import { assertChatAmountCurrency, resolvePlanAmount } from './budget-plan.js';
import type { ConversationResponse } from '@maggot/contracts';
const plan: Extract<ConversationResponse,{type:'plan'}>={type:'plan',text:'计算',taskType:'large_purchase',amountRef:'amount_1',horizonMonths:0,reserveMonths:3,timingFlexibility:'flexible',amountMode:'total'};
describe('浏览器金额解引用',()=>{
  it('拒绝将省略币种的人民币引用用于美元画像',()=>{
    expect(()=>resolvePlanAmount(plan,[{id:'amount_1',cents:2000000}],'USD',100000)).toThrow('币种');
    expect(resolvePlanAmount(plan,[{id:'amount_1',cents:2000000}],'CNY',100000)).toBe(2000000);
    expect(()=>assertChatAmountCurrency({id:'amount_1',cents:100,currency:'USD'},'CNY')).toThrow('币种');
  });
  it('按月收入缺口只在本地乘期限',()=>{
    expect(resolvePlanAmount({...plan,taskType:'income_reduction',amountRef:'monthly_income',horizonMonths:6},[],'CNY',100000)).toBe(600000);
  });
});
