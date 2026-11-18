import { describe,it,expect } from 'vitest';
import { evaluateScenarioLocal,generateCandidateScenarios,toSafeToolResult,type LargePurchaseGoal } from './calculator.js';
import type { UserProfile } from '../../features/profile/types.js';
const profile: UserProfile={availableDeposit:3_000_000,monthlyIncome:{status:'fixed',amount:1_000_000},essentialExpenses:{amount:300_000,scope:'individual'},debtStatus:'none',debts:[],metadata:{version:1,dataDate:'2026-11-17',updatedAt:'2026-11-17',completeness:'task_ready'}};
describe('conversation monthly budget',()=>{
 it('assesses an immediate purchase without inventing payment dates',()=>{
  const goal:LargePurchaseGoal={id:'chat',name:'purchase',targetAmount:2_000_000,targetHorizonMonths:0,cashReserveFloor:900_000,timingFlexibility:'fixed',version:'v1',assessmentScope:'monthly_budget'};
  const result=evaluateScenarioLocal(profile,goal,generateCandidateScenarios(goal)[0]);
  expect(result.projectedEndingCash).toBe(1_000_000);
  expect(result.isSatisfied).toBe(true);
  expect(result.intraMonthLiquidityStatus).toBe('not_assessed_monthly_budget');
  expect(toSafeToolResult('c',result,{snapshotVersion:'s',goalVersion:'v1',policyVersion:'p'}).status).toBe('satisfied');
 });
 it('projects whole future months and retains unknown living expenses',()=>{
  const goal:LargePurchaseGoal={id:'chat',name:'purchase',targetAmount:5_000_000,targetHorizonMonths:3,cashReserveFloor:0,timingFlexibility:'fixed',version:'v1',assessmentScope:'monthly_budget'};
  const result=evaluateScenarioLocal(profile,goal,generateCandidateScenarios(goal)[0]);
  expect(result.projectedEndingCash).toBe(100_000);
  const missing=evaluateScenarioLocal({...profile,essentialExpenses:undefined},goal,generateCandidateScenarios(goal)[0]);
  expect(missing.isReliable).toBe(false);expect(missing.isSatisfied).toBe(false);
 });
});
