<script setup lang="ts">
import { computed,ref,nextTick,onMounted,onBeforeUnmount,watch } from 'vue';
import { showConfirmDialog,showToast } from 'vant';
import { useFinanceStore } from '../stores/finance';
import ChatBubble from '../components/ChatBubble.vue';
import ChatComposer from '../components/ChatComposer.vue';
import { redactChatText,renderLocalAmounts } from '../local/privacy/chat-redaction';
import { deriveSafeProfileSummary } from '../local/privacy/summary';
import { sendConversation,createBrowserAgentTransport } from '../api/agent-api';
import { calculateMonthlySurplus,evaluateScenarioLocal,generateCandidateScenarios,type LargePurchaseGoal } from '../local/finance/calculator';
import { ClientAgentCoordinator,type StructuredClarificationDecision,type LocalFinalReport } from '../agent-client/client';
import type { ChatMessage } from '../features/chat/types';
import { assertChatAmountCurrency,resolvePlanAmount } from '../features/chat/budget-plan';
import type { BrowserToolRequest,ConversationRequest,ConversationResponse } from '@maggot/contracts';
const store=useFinanceStore();
const draft=ref('');const busy=ref(false);const bottom=ref<HTMLElement|null>(null);
const pending=ref<BrowserToolRequest|null>(null);
const answeringPending=ref(false);let activeReserveMonths=3;
let controller:AbortController|null=null;
let resolvePending:((decision:StructuredClarificationDecision)=>void)|null=null;
let assistantId='';
const messages=computed(()=>store.conversation.messages);
const examples=['买一辆20万的车，我现在负担得起吗？','想一年存下10万元，怎么安排？','先帮我看看每月的收支情况'];
const formatMoney=(value:number)=>`${(value/100).toLocaleString('zh-CN',{maximumFractionDigits:2})}${store.profile?.currency==='USD'?'美元':'元'}`;
watch(()=>messages.value.map(m=>m.text).join(''),async()=>{await nextTick();bottom.value?.scrollIntoView({block:'end'});});
onMounted(()=>store.refreshHealth());
onBeforeUnmount(()=>controller?.abort());
function append(role:ChatMessage['role'],text:string,safeText?:string,status:ChatMessage['status']='done'){
 const id=crypto.randomUUID();store.conversation.messages.push({id,role,text,safeText,status,createdAt:new Date().toISOString()});return id;
}
function update(text:string,status:ChatMessage['status']='pending',safeText?:string){
 const message=store.conversation.messages.find(m=>m.id===assistantId);if(message)Object.assign(message,{text,status,...(safeText?{safeText}:{})});
}
async function persist(){if(store.isUnlocked)await store.saveConversation(JSON.parse(JSON.stringify(store.conversation)));}
async function authorize(){
 await store.refreshHealth();
 if(store.getGateway().isAuthorized(store.activeProviderId,['chat_text','profile_summary']))return;
 await showConfirmDialog({title:'允许 AI 使用脱敏信息？',message:'原始画像留在本地。聊天文字会先识别并替换金额、账号等信息，再发送给模型。自动识别无法保证覆盖所有敏感表达，请勿粘贴密码或完整账户资料。',confirmButtonText:'同意并继续',cancelButtonText:'暂不发送'});
 store.grantAuthorization(['profile_summary','goal_summary','scenarios','clarification','follow_up','chat_text']);
}
function questionFor(tool:BrowserToolRequest){
 switch(tool.params.fieldCategory){
  case 'expense_refinement':return '为了算得更贴近实际，你每月自己承担的生活开销大概多少？不含已经单独填写的还款。直接回复金额就好，也可以说「先跳过」。';
  case 'income_variability_detail':return '你的收入是比较稳定，还是波动较大？可以直接告诉我，也可以说「先跳过」。';
  case 'timing_flexibility_confirmation':return '你希望几个月后完成这个目标？直接回复月份即可；如果不想调整，就说「不改时间」。';
  default:return '有没有需要额外考虑的家庭负担？也可以说「先跳过」。';
 }
}
async function answerPending(raw:string){
 const tool=pending.value;const resolve=resolvePending;if(!tool||!resolve)return;
 const redacted=redactChatText(raw,store.conversation.amounts,store.profile?.nickname);
 store.conversation.amounts=redacted.amounts;append('user',raw,redacted.text);
 let decision:StructuredClarificationDecision;
 if(/跳过|不说|不清楚|不知道|暂不/.test(raw)){decision={action:'decline',rejectionCategory:'user_declined_clarification'};}
 else if(tool.params.fieldCategory==='expense_refinement'){
  const refId=[...redacted.text.matchAll(/\[金额:(amount_\d+)\]/g)].at(-1)?.[1];
  const amount=redacted.amounts.find(ref=>ref.id===refId);
  if(!amount||!store.profile){append('assistant','请回复一个金额，例如「每月4000元」，或者说「先跳过」。');await persist();return;}
  assertChatAmountCurrency(amount,store.profile.currency??'CNY');
  const saved=await store.saveProfile({...store.profile,essentialExpenses:{...store.profile.essentialExpenses,amount:amount.cents,scope:'individual',includesDebt:false}});
  const cashflow=calculateMonthlySurplus(saved);
  const savedGoal=await store.saveGoal({...store.goal,cashReserveFloor:(cashflow.monthlyExpenses+cashflow.monthlyDebtService)*activeReserveMonths});
  decision={action:'modify_input',updatedProfile:saved,updatedGoal:savedGoal};
 }else if(tool.params.fieldCategory==='timing_flexibility_confirmation'){
  const match=raw.match(/(\d+)\s*个?月/);
  if(match){const months=Number(match[1]);if(months>120)throw new Error('目前支持120个月以内的预算');const goal=await store.saveGoal({...store.goal,targetHorizonMonths:months});decision={action:'modify_input',updatedGoal:goal};}
  else decision={action:'answer',clarificationChoice:/不改|固定|不能/.test(raw)?'timing_fixed':'timing_flexible'};
 }else if(tool.params.fieldCategory==='income_variability_detail'){
  decision={action:'answer',clarificationChoice:/波动|不稳/.test(raw)?'income_highly_variable':'user_confirmed'};
 }else decision={action:'decline',rejectionCategory:'prefer_not_to_share_family'};
 await persist();pending.value=null;resolvePending=null;
 assistantId=append('assistant','收到，我按补充后的信息继续核算。',undefined,'pending');resolve(decision);
}
function renderReport(report:LocalFinalReport,goal:LargePurchaseGoal,reserveMonths:number){
 if(!store.profile)return report.tradeOffSummary;
 const profile=store.profile;const baseline=evaluateScenarioLocal(profile,goal,generateCandidateScenarios(goal)[0]);
 const surplus=calculateMonthlySurplus(profile).monthlySurplus;
 const timing=goal.targetHorizonMonths===0?'现在':`${goal.targetHorizonMonths}个月后`;
 const conclusion=!baseline.isReliable?'目前的信息还不足以给出确定的预算结论。':baseline.isSatisfied?'按这个月度预算情景，可以覆盖原预算。':`按这个情景，原预算还有约 ${formatMoney(baseline.cashDeficit)} 的缺口。`;
 const selected=generateCandidateScenarios(goal).find(s=>s.scenarioId===report.selectedScenarioId);
 const comparison=selected?evaluateScenarioLocal(profile,goal,selected):undefined;
 const alternative=selected&&comparison&&selected.scenarioKind!=='original_plan'
  ? `\n另一个方案：${selected.scenarioKind==='delayed_timing'?`延后到${comparison.targetHorizonMonths}个月`:selected.scenarioKind==='conservative_buffer'?'适当压缩生活开销':`将目标调整为${formatMoney(comparison.targetAmount)}`}。${!comparison.isReliable?'信息仍需补全。':comparison.isSatisfied?'该情景可以覆盖预算。':`仍有约${formatMoney(comparison.cashDeficit)}缺口。`}下面的建议基于这个备选方案。`
  : '';
 return `关于这笔 ${formatMoney(goal.targetAmount)} 的预算：\n\n${conclusion}\n当前每月预计结余：${formatMoney(surplus)}。${alternative}\n\n${report.tradeOffSummary}\n\n本次按${timing}完成目标、保留${reserveMonths}个月基本支出估算，沿用当前月收入、开销与还款；不代表每天的现金都充足。`;
}
async function plan(response:Extract<ConversationResponse,{type:'plan'}>){
 if(!store.profile)throw new Error('请先保存基础资料');
 const amount=resolvePlanAmount(response,store.conversation.amounts,store.profile.currency??'CNY',store.profile.monthlyIncome?.amount??0);
 activeReserveMonths=response.reserveMonths;
 const {text:_planText,type:_planType,...context}=response;store.conversation.lastPlan=context;
 const flow=calculateMonthlySurplus(store.profile);
 const goal=await store.saveGoal({id:'chat_goal',name:'对话中的财务目标',currency:store.profile.currency,taskType:response.taskType,
  targetAmount:amount,targetHorizonMonths:response.horizonMonths,cashReserveFloor:(flow.monthlyExpenses+flow.monthlyDebtService)*response.reserveMonths,
  timingFlexibility:response.timingFlexibility,version:store.goal.version,assessmentScope:'monthly_budget'});
 update(renderLocalAmounts(response.text,store.conversation.amounts));await persist();
 const coordinator=new ClientAgentCoordinator(store.getGateway(),createBrowserAgentTransport(),store.activeProviderId);
 const activeController=controller;
 store.registerRunLifecycle(activeController,()=>{coordinator.clearSensitiveState();pending.value=null;resolvePending=null;});
 const report=await coordinator.runPlanningLoop(store.profile,goal,{
  signal:activeController?.signal,checkpointStore:store.checkpointStore,
  getCurrentVersions:()=>({snapshotVersion:store.currentSnapshotVersion,goalVersion:store.goal.version}),
  onEvent:event=>{if(event.type==='tool_requested'&& !pending.value)update('正在结合你的收支核算、比较方案…');},
  clarificationHandler:tool=>{pending.value=tool;update(questionFor(tool),'done',questionFor(tool));return new Promise(resolve=>{resolvePending=resolve;});},
 });
 if(activeController?.signal.aborted||!store.isUnlocked)return;
 await store.saveReport(report);
 update(renderReport(report,store.goal,response.reserveMonths),'done',report.tradeOffSummary);
}
async function send(text=draft.value){
 const raw=text.trim();if(!raw||(!pending.value&&busy.value))return;
 if(!store.isUnlocked)return;
 if(pending.value){if(answeringPending.value)return;answeringPending.value=true;draft.value='';try{await answerPending(raw);}catch(e){showToast((e as Error).message);}finally{answeringPending.value=false;}return;}
 if(store.conversation.messages.length>=90){showToast('当前对话较长，请先清空对话再开始。');return;}
 assistantId='';busy.value=true;controller=new AbortController();
 try{
  await authorize();
  const redacted=redactChatText(raw,store.conversation.amounts,store.profile?.nickname);
  if(redacted.text.includes('[已隐藏金额]'))throw new Error('这段话中的金额较多或超出支持范围，请简化后再发。');
  store.conversation.amounts=redacted.amounts;append('user',raw,redacted.text);draft.value='';
  assistantId=append('assistant','正在了解你的问题…',undefined,'pending');await persist();
  const outgoing:ConversationRequest={...(store.conversation.lastPlan?{activePlan:store.conversation.lastPlan}:{}),messages:messages.value.filter(m=>m.status==='done'&&m.safeText).slice(-12).map(m=>({role:m.role,content:redactChatText(m.safeText??'',store.conversation.amounts,store.profile?.nickname).text})),
    profile:deriveSafeProfileSummary(store.profile!),amountRefs:store.conversation.amounts.map(({id,currency})=>({id,...(currency?{currency}:{})}))};
  const response=await sendConversation(store.getGateway().inspectConversation(outgoing,store.activeProviderId),controller.signal);
  if(controller.signal.aborted||!store.isUnlocked)return;
  if(response.type==='plan')await plan(response);
  else update(renderLocalAmounts(response.text,store.conversation.amounts),'done',response.text);
 }catch(error){
  if(store.isUnlocked && error!=='cancel' && error!=='close'){const original=(error as Error)?.message??'';
    const message=controller?.signal.aborted?'已停止回复。你可以继续发送新的问题。':/sensitive|Security Violation|forbidden token/i.test(original)?'这段话可能包含账号或密钥信息，请删除后再发。':/Agent run failed|VersionConflict|Security Exception/i.test(original)?'这次测算没有完成。请确认资料后重新提问，我会重新核算。':original||'这次回复没有完成，请重试。';
    if(messages.value.some(m=>m.id===assistantId))update(message,'error');else showToast(message);}
 }finally{
  pending.value=null;resolvePending=null;busy.value=false;controller=null;store.registerRunLifecycle(null,null);
  if(store.isUnlocked)await persist().catch(()=>showToast('这次对话暂时未保存，请检查本地存储空间。'));
 }
}
function stop(){controller?.abort();}
async function clearChat(){try{await showConfirmDialog({title:'清空当前对话？',message:'你的基础画像会保留。',confirmButtonText:'清空'});await store.saveConversation({messages:[],amounts:[]});}catch{/* user cancelled */}}
</script>

<template>
 <main class="chat-page" data-testid="chat-page">
  <div class="chat-toolbar"><span>{{ store.serverHealth?.providerMode==='mock'?'演示模式 · 未调用真实模型':'结合你的本地资料回答' }}</span><button v-if="messages.length&&!busy" class="text-button" @click="clearChat">清空对话</button></div>
  <section v-if="!messages.length" class="chat-welcome">
   <div class="welcome-symbol">✦</div><h1>{{ store.profile?.nickname?`${store.profile.nickname}，想聊点什么？`:'想聊聊哪件事？' }}</h1>
   <p>可以直接问预算、储蓄或收支问题。需要更多信息时，我会在这里问你。</p>
   <div class="chat-examples"><button v-for="example in examples" :key="example" :disabled="busy" @click="send(example)">{{ example }} <span>↗</span></button></div>
  </section>
  <section v-else class="chat-history" aria-live="polite"><ChatBubble v-for="message in messages" :key="message.id" :message="message" /></section>
  <div ref="bottom" class="chat-bottom-anchor"></div>
  <ChatComposer v-model="draft" :busy="busy" :clarifying="Boolean(pending)&&!answeringPending" @send="send()" @stop="stop" />
 </main>
</template>
