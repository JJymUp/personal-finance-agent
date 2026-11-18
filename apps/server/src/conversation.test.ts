import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';
import { OpenAIModelProvider } from './providers/openai.js';
import { ConversationResponseSchema, type ConversationRequest } from '@maggot/contracts';
import { mockConversation } from './providers/conversation.js';
const input: ConversationRequest = { messages: [{role:'user', content:'我买一辆[金额:amount_1]的车是否支持？'}],
  amountRefs: [{id:'amount_1'}], profile: { income_stability:'stable', essential_expense_share:'30_40_pct',
    debt_service_share:'no_debt', cash_runway:'3_6_months', data_quality:{completeness:'user_confirmed_complete',freshness:'within_7_days'} } };
describe('conversation entry', () => {
  it('turns a sanitized natural question into a browser-owned budget request', async () => {
    const app=buildApp({staticDistDir:false});
    try {const res=await app.inject({method:'POST',url:'/api/conversation',payload:input});
      expect(res.statusCode).toBe(200);expect(res.json()).toMatchObject({type:'plan',amountRef:'amount_1',taskType:'large_purchase'});
    }finally{await app.close();}
  });
  it('rejects exact-profile fields before invoking any model', async () => {
    const app=buildApp({staticDistDir:false});
    try {const res=await app.inject({method:'POST',url:'/api/conversation',payload:{...input,exactBalance:123456}});expect(res.statusCode).toBe(400);}finally{await app.close();}
  });
  it('rejects a model plan referencing an amount the browser never supplied', async () => {
    const provider=new OpenAIModelProvider({apiKey:'synthetic-test',model:'synthetic',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{tool_calls:[{function:{name:'start_plan',arguments:JSON.stringify({text:'计算预算',taskType:'large_purchase',amountRef:'amount_99',horizonMonths:0,reserveMonths:3})}}]}}]}),{status:200})});
    const app=buildApp({provider,staticDistDir:false});
    try {const res=await app.inject({method:'POST',url:'/api/conversation',payload:input});expect(res.statusCode).toBe(502);}finally{await app.close();}
  });
});

// 模型只能选择受限预算语义，不能把月收入当作购车预算。
describe('对话计划的语义边界', () => {
  const plan = {type:'plan', text:'测算', taskType:'large_purchase', amountRef:'amount_1', horizonMonths:12, reserveMonths:3};
  it('拒绝购买计划引用月收入或按月倍增预算', () => {
    expect(ConversationResponseSchema.safeParse({...plan, amountRef:'monthly_income'}).success).toBe(false);
    expect(ConversationResponseSchema.safeParse({...plan, amountMode:'per_month'}).success).toBe(false);
    expect(ConversationResponseSchema.safeParse({...plan, taskType:'income_reduction', horizonMonths:0}).success).toBe(false);
  });
  it('只调整应急金时保留目标期限与预算引用', () => {
    const response=mockConversation({...input,activePlan:{taskType:'large_purchase',amountRef:'amount_1',horizonMonths:12,reserveMonths:3,timingFlexibility:'flexible',amountMode:'total'},messages:[{role:'user',content:'保留6个月应急金'}]});
    expect(response).toMatchObject({type:'plan',horizonMonths:12,reserveMonths:6,amountRef:'amount_1'});
    expect(response.text).toContain('6个月');
  });
});

it('Mock 能结合上一轮目标与本轮补充的金额和期限', () => {
  const purchase=mockConversation({...input,messages:[{role:'user',content:'我想买车'},{role:'assistant',content:'预计花多少钱？'},{role:'user',content:'[金额:amount_1]'}]});
  expect(purchase).toMatchObject({type:'plan',taskType:'large_purchase',amountRef:'amount_1'});
  const loss=mockConversation({...input,messages:[{role:'user',content:'失业了'},{role:'assistant',content:'预计持续多久？'},{role:'user',content:'6个月'}]});
  expect(loss).toMatchObject({type:'plan',taskType:'income_reduction',amountRef:'monthly_income',horizonMonths:6});
});
