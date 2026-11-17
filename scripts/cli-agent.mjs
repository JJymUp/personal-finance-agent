#!/usr/bin/env node
/**
 * Interactive & CLI Agent Conversation Runner (no frontend required).
 *
 * Exercises the complete end-to-end architecture from the terminal:
 *   Local Profile & Vault/Calculator -> PrivacyGateway -> Fastify API ->
 *   AgentSession -> OpenAIModelProvider (.env.local) / MockModelProvider ->
 *   Browser Tool Loop & Clarification -> Local Evidence Check & Exact Report
 *
 * Flags:
 *   --non-interactive          Run without interactive prompts
 *   --provider auto|openai|mock
 *   --scenario large_purchase|income_reduction|savings_goal
 *   --profile stable|variable|tight
 *   --use-http                 Use real TCP HTTP + SSE transport (default: in-process inject)
 *   --port <number>            Port for --use-http mode (default: 0 ephemeral or 3000)
 *   --custom-profile           Interactively enter your own financial profile
 *   --csv <path>               Load and preview local CSV transactions before planning
 */

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { buildApp } from '../apps/server/dist/app.js';
import { SessionStore } from '../apps/server/dist/agent/store.js';
import { loadServerEnv, getSafeEnvSummary } from '../apps/server/dist/config/env.js';
import { MockModelProvider } from '../apps/server/dist/providers/mock.js';
import { OpenAIModelProvider } from '../apps/server/dist/providers/openai.js';

import { validateProfile } from '../apps/web/dist/features/profile/rules.js';
import { PrivacyGateway } from '../apps/web/dist/local/privacy/gateway.js';
import { deriveSafeProfileSummary, deriveSafeGoalSummary } from '../apps/web/dist/local/privacy/summary.js';
import { parseCsvRows } from '../apps/web/dist/local/finance/csv-import.js';
import { previewImport } from '../apps/web/dist/local/finance/transaction-service.js';
import {
  ClientAgentCoordinator,
  MemoryCheckpointStore,
} from '../apps/web/dist/agent-client/client.js';
import { createHttpTransport } from '../apps/web/dist/agent-client/http-transport.js';

// ─── CLI Args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    provider: 'auto',
    scenario: 'large_purchase',
    profile: 'stable',
    nonInteractive: false,
    useHttp: false,
    port: 0,
    customProfile: false,
    csvPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--non-interactive') args.nonInteractive = true;
    else if (a === '--use-http') args.useHttp = true;
    else if (a === '--custom-profile') args.customProfile = true;
    else if (a === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10);
    else if (a === '--csv' && argv[i + 1]) args.csvPath = argv[++i];
    else if (a === '--provider' && argv[i + 1]) args.provider = argv[++i];
    else if (a === '--scenario' && argv[i + 1]) args.scenario = argv[++i];
    else if (a === '--profile' && argv[i + 1]) args.profile = argv[++i];
  }
  return args;
}

// ─── Synthetic Presets (cents) ───────────────────────────────────────────────

function makePresetProfile(kind) {
  const now = new Date().toISOString();
  if (kind === 'variable') {
    return {
      nickname: 'CLI_Synth_Variable',
      availableDeposit: 1_500_000, // 15,000 yuan
      monthlyIncome: { status: 'variable', amount: 1_200_000, isEstimate: true }, // ~12,000 yuan
      debtStatus: 'has_debt',
      debts: [
        {
          id: 'debt_cli_1',
          name: 'Consumer Loan',
          balance: 2_400_000,
          repaymentAmount: 200_000, // 2,000 yuan/mo
          frequency: 'monthly',
        },
      ],
      essentialExpenses: { amount: 500_000, scope: 'individual' }, // 5,000 yuan
      metadata: { version: 1, dataDate: now, completeness: 'task_ready', updatedAt: now },
    };
  }
  if (kind === 'tight') {
    return {
      nickname: 'CLI_Synth_Tight',
      availableDeposit: 600_000, // 6,000 yuan
      monthlyIncome: { status: 'fixed', amount: 800_000 }, // 8,000 yuan
      debtStatus: 'has_debt',
      debts: [
        {
          id: 'debt_cli_2',
          name: 'Installment',
          balance: 1_800_000,
          repaymentAmount: 250_000, // 2,500 yuan/mo
          frequency: 'monthly',
        },
      ],
      essentialExpenses: { amount: 400_000, scope: 'individual' }, // 4,000 yuan
      metadata: { version: 1, dataDate: now, completeness: 'task_ready', updatedAt: now },
    };
  }
  return {
    nickname: 'CLI_Synth_Stable',
    availableDeposit: 2_500_000, // 25,000 yuan
    monthlyIncome: { status: 'fixed', amount: 1_500_000 }, // 15,000 yuan
    debtStatus: 'none',
    debts: [],
    essentialExpenses: { amount: 500_000, scope: 'individual' }, // 5,000 yuan
    metadata: { version: 1, dataDate: now, completeness: 'task_ready', updatedAt: now },
  };
}

function makePresetGoal(taskType) {
  if (taskType === 'income_reduction') {
    return {
      id: 'cli_income_drop',
      name: '职业空窗期 / 降薪缓冲',
      taskType: 'income_reduction',
      targetAmount: 4_800_000, // 48,000 yuan total reduction over 6m
      targetHorizonMonths: 6,
      cashReserveFloor: 1_000_000, // 10,000 yuan
      timingFlexibility: 'flexible',
      version: 'v1',
    };
  }
  if (taskType === 'savings_goal') {
    return {
      id: 'cli_savings',
      name: '应急储备金目标',
      taskType: 'savings_goal',
      targetAmount: 6_000_000, // 60,000 yuan
      targetHorizonMonths: 9,
      cashReserveFloor: 1_000_000, // 10,000 yuan
      timingFlexibility: 'flexible',
      version: 'v1',
    };
  }
  return {
    id: 'cli_large_purchase',
    name: '购车大额支出计划',
    taskType: 'large_purchase',
    targetAmount: 8_000_000, // 80,000 yuan
    targetHorizonMonths: 12,
    cashReserveFloor: 1_000_000, // 10,000 yuan
    timingFlexibility: 'flexible',
    version: 'v1',
  };
}

function fmtYuan(cents) {
  return `¥${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function makeInjectTransport(app, store) {
  const tokensByRun = new Map();
  return {
    async createRun(request) {
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: request });
      if (res.statusCode !== 201) throw new Error(`createRun failed (${res.statusCode}): ${res.body}`);
      const parsed = JSON.parse(res.body);
      if (parsed.sessionToken) tokensByRun.set(parsed.runId, parsed.sessionToken);
      return parsed;
    },
    async submitToolResult(runId, result) {
      const token = tokensByRun.get(runId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${runId}/tool-results`,
        headers: token ? { 'x-session-token': token } : {},
        payload: result,
      });
      if (res.statusCode !== 200) {
        throw new Error(`submitToolResult failed (${res.statusCode}): ${res.body}`);
      }
      return JSON.parse(res.body);
    },
    async cancelRun(runId, reason) {
      const token = tokensByRun.get(runId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${runId}/cancel`,
        headers: token ? { 'x-session-token': token } : {},
        payload: { reason },
      });
      return JSON.parse(res.body);
    },
    async fetchEvents(runId) {
      return store.getSession(runId)?.getEventHistory() ?? [];
    },
    async getCheckpoint(runId) {
      const token = tokensByRun.get(runId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/runs/${runId}/checkpoint`,
        headers: token ? { 'x-session-token': token } : {},
      });
      if (res.statusCode !== 200) return null;
      return JSON.parse(res.body);
    },
    async sendFollowUp(runId, request) {
      const token = tokensByRun.get(runId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/runs/${runId}/followup`,
        headers: token ? { 'x-session-token': token } : {},
        payload: request,
      });
      if (res.statusCode !== 200) {
        throw new Error(`sendFollowUp failed (${res.statusCode}): ${res.body}`);
      }
      return JSON.parse(res.body);
    },
  };
}

function createPrompter() {
  const rl = readline.createInterface({ input, output });
  const queue = [];
  let waiting = null;
  let closed = false;

  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve('');
    }
  });

  return {
    async question(prompt) {
      output.write(prompt);
      if (queue.length > 0) {
        const line = queue.shift();
        if (!input.isTTY) output.write(line + '\n');
        return line;
      }
      if (closed) return '';
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
}

async function promptCustomProfile(rl) {
  const now = new Date().toISOString();
  const nickname = (await rl.question('  用户称呼 (默认 CLI_Custom): ')).trim() || 'CLI_Custom';
  const depositYuan = Number((await rl.question('  可用存款金额(元, 默认 20000): ')).trim() || '20000');
  const incomeStatusRaw = (await rl.question('  收入类型 [fixed/variable] (默认 fixed): ')).trim();
  const incomeStatus = incomeStatusRaw === 'variable' ? 'variable' : 'fixed';
  const incomeYuan = Number((await rl.question('  月收入金额(元, 默认 12000): ')).trim() || '12000');
  const expenseYuan = Number((await rl.question('  月必要生活支出(元, 默认 4500): ')).trim() || '4500');
  const debtYuan = Number((await rl.question('  每月固定还款金额(元, 无负债填 0): ')).trim() || '0');

  const debts =
    debtYuan > 0
      ? [
          {
            id: 'custom_debt_1',
            name: 'Monthly Debt',
            balance: Math.round(debtYuan * 12 * 100),
            repaymentAmount: Math.round(debtYuan * 100),
            frequency: 'monthly',
          },
        ]
      : [];

  return {
    nickname,
    availableDeposit: Math.round(depositYuan * 100),
    monthlyIncome: {
      status: incomeStatus,
      amount: Math.round(incomeYuan * 100),
      isEstimate: incomeStatus === 'variable',
    },
    debtStatus: debts.length > 0 ? 'has_debt' : 'none',
    debts,
    essentialExpenses: { amount: Math.round(expenseYuan * 100), scope: 'individual' },
    metadata: { version: 1, dataDate: now, completeness: 'task_ready', updatedAt: now },
  };
}

// ─── Main Runner ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadServerEnv();
  const envSummary = getSafeEnvSummary(env);

  let useOpenAI = false;
  if (args.provider === 'openai') {
    if (!env.openaiApiKey) {
      throw new Error('Requested --provider openai, but OPENAI_API_KEY is missing in .env.local');
    }
    useOpenAI = true;
  } else if (args.provider === 'auto') {
    useOpenAI = env.providerMode === 'openai';
  }

  const provider = useOpenAI
    ? new OpenAIModelProvider({
        apiKey: env.openaiApiKey,
        model: env.openaiModel,
        baseUrl: env.openaiBaseUrl,
        timeoutMs: env.openaiTimeoutMs,
        maxRetries: env.openaiMaxRetries,
      })
    : new MockModelProvider({ behavior: 'standard' });

  const store = new SessionStore();
  const app = buildApp({
    provider,
    store,
    providerInfo: {
      ...envSummary,
      providerMode: useOpenAI ? 'openai' : 'mock',
      model: useOpenAI ? env.openaiModel : 'mock_provider',
    },
  });

  let transport;
  if (args.useHttp) {
    const address = await app.listen({ port: args.port, host: '127.0.0.1' });
    console.log(`[HTTP/SSE] Fastify server listening at ${address}`);
    transport = createHttpTransport(address);
  } else {
    await app.ready();
    transport = makeInjectTransport(app, store);
  }

  const rl = args.nonInteractive ? null : createPrompter();

  try {
    console.log('\n==============================================================');
    console.log(' Maggot Finance Agent CLI (Local Calculator + Controlled Cloud)');
    console.log(` Provider: ${provider.name} (${useOpenAI ? 'LIVE CLOUD' : 'MOCK'})`);
    console.log(` Transport: ${args.useHttp ? 'Real HTTP + SSE' : 'In-Process Inject'}`);
    console.log('==============================================================\n');

    if (args.csvPath) {
      const rawCsv = fs.readFileSync(args.csvPath, 'utf8');
      const parsed = parseCsvRows(rawCsv);
      const preview = previewImport(parsed.rows, []);
      console.log(`[CSV 本地解析] 文件: ${args.csvPath}`);
      console.log(
        `  有效行: ${parsed.rows.length}, 错误/跳过: ${parsed.skippedCount}, 预览新增: ${preview.newCount}, 重复: ${preview.duplicateCount}, 冲突: ${preview.conflictCount}`
      );
      if (parsed.errors.length > 0) {
        console.log('  前 3 条解析警告:', parsed.errors.slice(0, 3));
      }
      console.log('');
    }

    let profile = makePresetProfile(args.profile);
    let goal = makePresetGoal(args.scenario);

    if (rl && args.customProfile) {
      console.log('请输入自定义本地画像（仅保存在本地，绝不上传精确金额）:');
      profile = await promptCustomProfile(rl);
    } else if (rl) {
      const pChoice = await rl.question(
        '选择合成用户画像 [1=稳定无债, 2=不固定收入+有债, 3=预算偏紧, 4=手动自定义] (默认 1): '
      );
      if (pChoice.trim() === '2') profile = makePresetProfile('variable');
      else if (pChoice.trim() === '3') profile = makePresetProfile('tight');
      else if (pChoice.trim() === '4') profile = await promptCustomProfile(rl);

      const gChoice = await rl.question(
        '选择规划目标 [1=买车/大额支出, 2=降薪/空窗缓冲, 3=目标储蓄] (默认 1): '
      );
      if (gChoice.trim() === '2') goal = makePresetGoal('income_reduction');
      else if (gChoice.trim() === '3') goal = makePresetGoal('savings_goal');
    }

    const gateway = new PrivacyGateway();
    const checkpointStore = new MemoryCheckpointStore();

    let keepGoing = true;
    while (keepGoing) {
      // 1. Local profile validation (zero server calls)
      const val = validateProfile(profile);
      if (!val.isValid) {
        console.error('本地画像校验失败:', val.errors);
        break;
      }

      console.log('\n[本地私密画像（绝不上传到 Node.js/AI）]');
      console.log(
        `  称呼: ${profile.nickname} | 可用存款: ${fmtYuan(profile.availableDeposit)} | 月收入(${profile.monthlyIncome.status}): ${fmtYuan(profile.monthlyIncome.amount)} | 必要开销: ${fmtYuan(profile.essentialExpenses.amount)}`
      );
      console.log(
        `[规划目标] ${goal.name} (${goal.taskType}, ${goal.version}): 目标金额 ${fmtYuan(goal.targetAmount)}, 期限 ${goal.targetHorizonMonths} 个月, 最低现金底线 ${fmtYuan(goal.cashReserveFloor)}`
      );

      // 2. Preview outbound safe summary & authorize
      const safeProfile = deriveSafeProfileSummary(profile);
      const safeGoal = deriveSafeGoalSummary(profile, goal);
      console.log('\n[出站摘要预览（仅以下脱敏区间允许上传）]');
      console.log(JSON.stringify({ safeProfile, safeGoal }, null, 2));

      if (rl) {
        const authAns = await rl.question('\n确认授权发送上述脱敏摘要给模型服务? [Y/n]: ');
        if (authAns.trim().toLowerCase() === 'n') {
          console.log('已拒绝授权，退出。');
          break;
        }
      }

      gateway.authorize({
        purpose: 'financial_planning',
        provider: provider.name,
        allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification', 'follow_up'],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });

      const coordinator = new ClientAgentCoordinator(gateway, transport, provider.name);

      console.log('\n[Agent 执行日志]');
      const report = await coordinator.runPlanningLoop(profile, goal, {
        checkpointStore,
        onEvent: (evt) => {
          if (evt.type === 'tool_requested') {
            const tr = evt.payload.toolRequest;
            console.log(
              `  -> #${evt.sequenceNumber} [tool_requested] ${tr.toolName} ${JSON.stringify(tr.params)} | 理由: ${evt.payload.reasoning}`
            );
          } else if (evt.type === 'completed') {
            console.log(`  -> #${evt.sequenceNumber} [completed] 已生成服务端分析结论`);
          } else if (evt.type === 'failed' || evt.type === 'cancelled') {
            console.log(`  -> #${evt.sequenceNumber} [${evt.type}]`, evt.payload);
          }
        },
        clarificationHandler: async (req) => {
          console.log(`\n[Agent 请求本地澄清] 字段类别: ${req.params.fieldCategory}`);
          if (!rl) {
            console.log('  (non-interactive 模式默认结构化确认: timing_flexible)');
            return { action: 'answer', clarificationChoice: 'timing_flexible' };
          }
          const ans = await rl.question(
            '请选择结构化操作 [1=时间可延后(timing_flexible), 2=时间固定(timing_fixed), 3=确认费用准确(expense_confirmed_accurate), modify=修改目标重算, decline=跳过]: '
          );
          const trimmed = ans.trim().toLowerCase();
          if (trimmed === 'decline') {
            return { action: 'decline', rejectionCategory: 'user_declined_clarification' };
          }
          if (trimmed === 'modify') {
            const newTargetYuan = Number(await rl.question('新目标金额(元): '));
            const newMonths = Number(await rl.question('新期限(月): '));
            const nextVer = `v${Number(goal.version.replace('v', '')) + 1}`;
            const updatedGoal = {
              ...goal,
              targetAmount:
                Number.isFinite(newTargetYuan) && newTargetYuan > 0
                  ? Math.round(newTargetYuan * 100)
                  : goal.targetAmount,
              targetHorizonMonths:
                Number.isFinite(newMonths) && newMonths > 0
                  ? Math.round(newMonths)
                  : goal.targetHorizonMonths,
              version: nextVer,
            };
            goal = updatedGoal;
            return { action: 'modify_input', updatedGoal };
          }
          const choiceMap = {
            '1': 'timing_flexible',
            '2': 'timing_fixed',
            '3': 'expense_confirmed_accurate',
          };
          return {
            action: 'answer',
            clarificationChoice: choiceMap[trimmed] ?? 'user_confirmed',
          };
        },
      });

      // 3. Display local interpolated report
      console.log('\n==================== 本地验证报告 (精确金额本地插值) ====================');
      console.log(`  Run ID:          ${report.runId}`);
      console.log(`  选中方案:        ${report.selectedScenarioId}`);
      console.log(`  验证凭证 ID:     ${report.evidenceId}`);
      console.log(`  可行性结论:      ${report.verdict} (verified=${report.isVerified})`);
      console.log(`  目标有效金额:    ${fmtYuan(report.exactTargetAmount)}`);
      console.log(`  期末预计现金:    ${fmtYuan(report.exactEndingCash)}`);
      console.log(`  期间最低现金:    ${fmtYuan(report.exactMinimumCash)}`);
      console.log(`  资金缺口:        ${fmtYuan(report.exactDeficit)}`);
      console.log(`  取舍说明:        ${report.tradeOffSummary}`);
      console.log(`  关键假设:        ${report.assumptionsUsed.join('；')}`);
      console.log('========================================================================');

      // Verify server zero-leakage
      const sessionObj = store.getSession(report.runId);
      const serverSessionDump = JSON.stringify(sessionObj?.getEventHistory() ?? []);
      const leakedDeposit = serverSessionDump.includes(String(profile.availableDeposit));
      const leakedNickname = serverSessionDump.includes(profile.nickname);
      const tokUsage = sessionObj?.getTokenUsage();
      console.log(
        `[隐私审计] 服务端会话中是否包含原始存款/称呼: deposit=${leakedDeposit}, nickname=${leakedNickname}`
      );
      if (tokUsage && tokUsage.totalTokens > 0) {
        console.log(
          `[Token 消耗] prompt=${tokUsage.promptTokens}, completion=${tokUsage.completionTokens}, total=${tokUsage.totalTokens}`
        );
      }

      if (!rl) break;

      let reportMenu = true;
      while (reportMenu) {
        const nextCmd = await rl.question(
          '\n后续操作 [1=调整目标金额重算(使旧报告失效), 2=查看服务端事件摘要, 3=围绕当前报告继续追问, q=退出]: '
        );
        const choice = nextCmd.trim();
        if (choice === '1') {
          const newAmt = Number(await rl.question('请输入新目标金额(元): '));
          const nextVer = `v${Number(goal.version.replace('v', '')) + 1}`;
          goal = {
            ...goal,
            targetAmount:
              Number.isFinite(newAmt) && newAmt > 0 ? Math.round(newAmt * 100) : goal.targetAmount,
            version: nextVer,
          };
          console.log(`目标已更新至 ${goal.version}，旧报告已失效，准备重新规划...`);
          reportMenu = false;
        } else if (choice === '2') {
          const hist = store.getSession(report.runId)?.getEventHistory() ?? [];
          console.log('\n[服务端会话事件全量记录（供核查不含任何原始财务数据）]');
          console.log(JSON.stringify(hist, null, 2));
        } else if (choice === '3') {
          const fuPick = (
            await rl.question(
              '选择结构化追问意图 [1=解释结论与风险, 2=对比备选方案, 3=分析现金底线影响, 4=了解提升可行性方向]: '
            )
          ).trim();
          const intents = {
            '1': 'explain_verdict_and_risk',
            '2': 'compare_candidate_scenarios',
            '3': 'explain_cash_buffer_impact',
            '4': 'how_to_improve_feasibility',
          };
          const intent = intents[fuPick] ?? 'explain_verdict_and_risk';
          try {
            const fu = await coordinator.askFollowUp(
              profile,
              report,
              { intent, selectedScenarioId: report.selectedScenarioId },
              goal.version
            );
            console.log('\n[受控多轮追问回复]');
            console.log(`  依据凭证: ${fu.citedEvidenceId}`);
            console.log(`  回复内容: ${fu.answer}`);
            console.log(`  限制说明: ${fu.limitationsNoted.join('；')}`);
          } catch (err) {
            console.error('  追问被拦截或失败:', err.message);
          }
        } else {
          reportMenu = false;
          keepGoing = false;
        }
      }
    }
  } finally {
    if (rl) rl.close();
    await app.close();
  }
}

main().catch((err) => {
  console.error('CLI Error:', err.message);
  process.exit(1);
});
