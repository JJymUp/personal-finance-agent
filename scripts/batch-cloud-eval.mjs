#!/usr/bin/env node
/**
 * Batch Cloud Evaluation Script
 * Runs 12 synthetic business cases × 3 times each against the real cloud model.
 *
 * Outputs a structured JSON report to scripts/eval-results/cloud-eval-YYYYMMDDHHMMSS.json
 *
 * Cases (4 per scenario × 3 scenarios = 12 total):
 *   large_purchase: stable-no-debt, variable-with-debt, tight, tight-but-delayed-viable
 *   income_reduction: stable-short-drop, variable-long-drop, tight-impossible, clarification-path
 *   savings_goal: stable-fast, variable-slow, tight-fails, clarification-then-modified
 *
 * Usage:
 *   pnpm build && node scripts/batch-cloud-eval.mjs [--provider mock|openai] [--runs N]
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { buildApp } from '../apps/server/dist/app.js';
import { SessionStore } from '../apps/server/dist/agent/store.js';
import { loadServerEnv } from '../apps/server/dist/config/env.js';
import { MockModelProvider } from '../apps/server/dist/providers/mock.js';
import { OpenAIModelProvider } from '../apps/server/dist/providers/openai.js';
import { RateLimiter } from '../apps/server/dist/security/rate-limiter.js';
import { DisclosureGuard } from '../apps/server/dist/security/disclosure-guard.js';

import { PrivacyGateway } from '../apps/web/dist/local/privacy/gateway.js';
import { ClientAgentCoordinator } from '../apps/web/dist/agent-client/client.js';
import { createHttpTransport } from '../apps/web/dist/agent-client/http-transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let currentAudit = null;
const recordBrowserRequest = (payload) => {
  currentAudit?.browser.push(JSON.stringify(payload));
};
const recordModelRequest = async (url, init) => {
  if (typeof init?.body === 'string') currentAudit?.model.push(init.body);
  return fetch(url, init);
};

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { provider: 'auto', runs: 3, transport: 'http' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider' && argv[i + 1]) args.provider = argv[++i];
    if (a === '--runs' && argv[i + 1]) args.runs = parseInt(argv[++i], 10);
    if (a === '--transport' && argv[i + 1]) args.transport = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// ─── Provider Setup ───────────────────────────────────────────────────────────

function makeProvider(providerArg) {
  if (providerArg === 'mock') {
    return { provider: new MockModelProvider({ behavior: 'standard' }), name: 'mock_provider', model: 'mock' };
  }
  const env = loadServerEnv();
  if (!env.openaiApiKey) {
    console.warn('[batch-eval] No OPENAI_API_KEY found, falling back to mock provider');
    return { provider: new MockModelProvider({ behavior: 'standard' }), name: 'mock_provider', model: 'mock' };
  }
  return {
    provider: new OpenAIModelProvider({
      apiKey: env.openaiApiKey,
      model: env.openaiModel ?? 'gpt-5.6-luna',
      baseUrl: env.openaiBaseUrl,
      fetchImpl: recordModelRequest,
    }),
    name: `openai:${env.openaiModel ?? 'gpt-5.6-luna'}`,
    model: env.openaiModel ?? 'gpt-5.6-luna',
  };
}

const { provider, name: providerName, model: modelName } = makeProvider(
  args.provider === 'auto' ? 'openai' : args.provider
);

// ─── Synthetic Profiles (cents) ───────────────────────────────────────────────

// Fixed synthetic balance date keeps expected financial outcomes reproducible.
const NOW = '2026-11-01T00:00:00Z';

const PROFILES = {
  stableNoDept: {
    nickname: 'Eval_A',
    availableDeposit: 2_000_000,
    monthlyIncome: { status: 'fixed', amount: 1_000_000, payDay: 5 },
    debtStatus: 'none',
    debts: [],
    essentialExpenses: { amount: 400_000, scope: 'individual', paymentDay: 8 },
    metadata: { version: 1, dataDate: NOW, completeness: 'task_ready', updatedAt: NOW },
  },
  variableWithDebt: {
    nickname: 'Eval_B',
    availableDeposit: 1_000_000,
    monthlyIncome: { status: 'variable', amount: 800_000, isEstimate: true, payDay: 5 },
    debtStatus: 'has_debt',
    debts: [{ id: 'd1', name: 'Loan', balance: 3_000_000, repaymentAmount: 200_000, frequency: 'monthly', nextPaymentDate: '2026-11-10' }],
    essentialExpenses: { amount: 450_000, scope: 'individual', paymentDay: 8 },
    metadata: { version: 1, dataDate: NOW, completeness: 'task_ready', updatedAt: NOW },
  },
  tight: {
    nickname: 'Eval_C',
    availableDeposit: 500_000,
    monthlyIncome: { status: 'fixed', amount: 700_000, payDay: 5 },
    debtStatus: 'has_debt',
    debts: [{ id: 'd2', name: 'Card', balance: 500_000, repaymentAmount: 400_000, frequency: 'monthly', nextPaymentDate: '2026-11-10' }],
    essentialExpenses: { amount: 250_000, scope: 'individual', paymentDay: 8 },
    metadata: { version: 1, dataDate: NOW, completeness: 'task_ready', updatedAt: NOW },
  },
  stableSavings: {
    nickname: 'Eval_D',
    availableDeposit: 500_000,
    monthlyIncome: { status: 'fixed', amount: 1_200_000, payDay: 5 },
    debtStatus: 'none',
    debts: [],
    essentialExpenses: { amount: 500_000, scope: 'individual', paymentDay: 8 },
    metadata: { version: 1, dataDate: NOW, completeness: 'task_ready', updatedAt: NOW },
  },
  variableSlow: {
    nickname: 'Eval_E',
    availableDeposit: 300_000,
    monthlyIncome: { status: 'variable', amount: 900_000, isEstimate: true, payDay: 5 },
    debtStatus: 'has_debt',
    debts: [{ id: 'd3', name: 'Instalment', balance: 2_000_000, repaymentAmount: 150_000, frequency: 'monthly', nextPaymentDate: '2026-11-10' }],
    essentialExpenses: { amount: 400_000, scope: 'individual', paymentDay: 8 },
    metadata: { version: 1, dataDate: NOW, completeness: 'task_ready', updatedAt: NOW },
  },
};

// ─── Goals ────────────────────────────────────────────────────────────────────

const GOALS = {
  largePurchaseBaseline: {
    id: 'g_lp_baseline',
    name: 'Car Purchase Baseline',
    taskType: 'large_purchase',
    targetAmount: 1_200_000,
    targetHorizonMonths: 12,
    cashReserveFloor: 500_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  },
  largePurchaseTight: {
    id: 'g_lp_tight',
    name: 'Car Purchase Tight',
    taskType: 'large_purchase',
    targetAmount: 800_000,
    targetHorizonMonths: 6,
    cashReserveFloor: 400_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  },
  largePurchaseDelayed: {
    id: 'g_lp_delayed',
    name: 'Car Purchase Delayed',
    taskType: 'large_purchase',
    targetAmount: 1_200_000,
    targetHorizonMonths: 18,
    cashReserveFloor: 500_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  },
  incomeReductionShort: {
    id: 'g_ir_short',
    name: 'Income Drop — Short',
    taskType: 'income_reduction',
    targetAmount: 300_000,
    targetHorizonMonths: 3,
    cashReserveFloor: 400_000,
    timingFlexibility: 'fixed',
    version: 'v1',
  },
  incomeReductionLong: {
    id: 'g_ir_long',
    name: 'Income Drop — Long',
    taskType: 'income_reduction',
    targetAmount: 400_000,
    targetHorizonMonths: 6,
    cashReserveFloor: 300_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  },
  incomeReductionImpossible: {
    id: 'g_ir_impossible',
    name: 'Income Drop — Impossible',
    taskType: 'income_reduction',
    targetAmount: 1_500_000,
    targetHorizonMonths: 3,
    cashReserveFloor: 400_000,
    timingFlexibility: 'fixed',
    version: 'v1',
  },
  savingsGoalFast: {
    id: 'g_sg_fast',
    name: 'Savings Goal — Fast',
    taskType: 'savings_goal',
    targetAmount: 1_000_000,
    targetHorizonMonths: 12,
    cashReserveFloor: 300_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  },
  savingsGoalSlow: {
    id: 'g_sg_slow',
    name: 'Savings Goal — Slow',
    taskType: 'savings_goal',
    targetAmount: 1_500_000,
    targetHorizonMonths: 24,
    cashReserveFloor: 300_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  },
  savingsGoalFails: {
    id: 'g_sg_fails',
    name: 'Savings Goal — Fails',
    taskType: 'savings_goal',
    targetAmount: 3_000_000,
    targetHorizonMonths: 6,
    cashReserveFloor: 400_000,
    timingFlexibility: 'fixed',
    version: 'v1',
  },
};

// ─── 12 Test Cases ────────────────────────────────────────────────────────────

const TEST_CASES = [
  // large_purchase (4 cases)
  {
    id: 'LP-1',
    description: 'Large purchase: stable-no-debt — should be viable',
    scenario: 'large_purchase',
    profile: PROFILES.stableNoDept,
    goal: GOALS.largePurchaseBaseline,
    expectedVerdicts: ['viable'],
  },
  {
    id: 'LP-2',
    description: 'Large purchase: variable income cannot establish reliable feasibility — caution',
    scenario: 'large_purchase',
    profile: PROFILES.variableWithDebt,
    goal: GOALS.largePurchaseBaseline,
    expectedVerdicts: ['caution'],
  },
  {
    id: 'LP-3',
    description: 'Large purchase: tight — expect not_viable or caution',
    scenario: 'large_purchase',
    profile: PROFILES.tight,
    goal: GOALS.largePurchaseTight,
    expectedVerdicts: ['not_viable', 'caution'],
  },
  {
    id: 'LP-4',
    description: 'Large purchase: stable-no-debt with 18-month delay — should be viable',
    scenario: 'large_purchase',
    profile: PROFILES.stableNoDept,
    goal: GOALS.largePurchaseDelayed,
    expectedVerdicts: ['viable'],
  },
  // income_reduction (4 cases)
  {
    id: 'IR-1',
    description: 'Income reduction: stable-short-drop — should handle gracefully',
    scenario: 'income_reduction',
    profile: PROFILES.stableNoDept,
    goal: GOALS.incomeReductionShort,
    expectedVerdicts: ['viable'],
  },
  {
    id: 'IR-2',
    description: 'Income reduction: variable-long-drop — expect caution or not_viable',
    scenario: 'income_reduction',
    profile: PROFILES.variableWithDebt,
    goal: GOALS.incomeReductionLong,
    expectedVerdicts: ['caution'],
  },
  {
    id: 'IR-3',
    description: 'Income reduction: tight-impossible — expect not_viable',
    scenario: 'income_reduction',
    profile: PROFILES.tight,
    goal: GOALS.incomeReductionImpossible,
    expectedVerdicts: ['not_viable', 'caution'],
  },
  {
    id: 'IR-4',
    description: 'Income reduction: stable but needs clarification timing',
    scenario: 'income_reduction',
    profile: PROFILES.stableNoDept,
    goal: GOALS.incomeReductionLong,
    expectedVerdicts: ['viable'],
  },
  // savings_goal (4 cases)
  {
    id: 'SG-1',
    description: 'Savings goal: stable-fast — should be viable',
    scenario: 'savings_goal',
    profile: PROFILES.stableSavings,
    goal: GOALS.savingsGoalFast,
    expectedVerdicts: ['viable'],
  },
  {
    id: 'SG-2',
    description: 'Savings goal: variable-slow — caution expected',
    scenario: 'savings_goal',
    profile: PROFILES.variableSlow,
    goal: GOALS.savingsGoalSlow,
    expectedVerdicts: ['caution'],
  },
  {
    id: 'SG-3',
    description: 'Savings goal: tight-fails — not_viable expected',
    scenario: 'savings_goal',
    profile: PROFILES.tight,
    goal: GOALS.savingsGoalFails,
    expectedVerdicts: ['not_viable', 'caution'],
  },
  {
    id: 'SG-4',
    description: 'Savings goal: stable achieves goal with flexibility',
    scenario: 'savings_goal',
    profile: PROFILES.stableNoDept,
    goal: GOALS.savingsGoalSlow,
    expectedVerdicts: ['viable'],
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

function makeInjectTransport(appInstance, storeInstance) {
  const tokensByRun = new Map();
  return {
    async createRun(request) {
      recordBrowserRequest(request);
      const parentToken = request.parentRunId ? tokensByRun.get(request.parentRunId) : undefined;
      const headers = parentToken ? { 'x-parent-session-token': parentToken } : {};
      const res = await appInstance.inject({
        method: 'POST',
        url: '/api/runs',
        headers,
        payload: request,
      });
      if (res.statusCode !== 201) throw new Error(`createRun failed: ${res.body}`);
      const parsed = JSON.parse(res.body);
      if (parsed.sessionToken) tokensByRun.set(parsed.runId, parsed.sessionToken);
      return parsed;
    },
    async submitToolResult(runId, result) {
      recordBrowserRequest(result);
      const token = tokensByRun.get(runId);
      const res = await appInstance.inject({
        method: 'POST',
        url: `/api/runs/${runId}/tool-results`,
        headers: token ? { 'x-session-token': token } : {},
        payload: result,
      });
      if (res.statusCode !== 200) throw new Error(`submitToolResult failed: ${res.body}`);
      return JSON.parse(res.body);
    },
    async cancelRun(runId, reason) {
      recordBrowserRequest({ reason });
      const token = tokensByRun.get(runId);
      const res = await appInstance.inject({
        method: 'POST',
        url: `/api/runs/${runId}/cancel`,
        headers: token ? { 'x-session-token': token } : {},
        payload: { reason },
      });
      return JSON.parse(res.body);
    },
    async fetchEvents(runId) {
      return storeInstance.getSession(runId)?.getEventHistory() ?? [];
    },
    async getCheckpoint(runId) {
      const token = tokensByRun.get(runId);
      const res = await appInstance.inject({
        method: 'GET',
        url: `/api/runs/${runId}/checkpoint`,
        headers: token ? { 'x-session-token': token } : {},
      });
      return res.statusCode === 200 ? JSON.parse(res.body) : null;
    },
    async sendFollowUp(runId, request) {
      recordBrowserRequest(request);
      const token = tokensByRun.get(runId);
      const res = await appInstance.inject({
        method: 'POST',
        url: `/api/runs/${runId}/followup`,
        headers: token ? { 'x-session-token': token } : {},
        payload: request,
      });
      if (res.statusCode !== 200) throw new Error(`sendFollowUp failed: ${res.body}`);
      return JSON.parse(res.body);
    },
  };
}

async function runCase(caseSpec, runIndex, appInstance, storeInstance, baseUrl) {
  const startedAt = Date.now();
  currentAudit = { browser: [], model: [] };
  let activeRunId = null;
  const transport = baseUrl
    ? createHttpTransport(baseUrl, { fetchImpl: async (url, init) => {
        if (typeof init?.body === 'string') currentAudit.browser.push(init.body);
        return fetch(url, init);
      } })
    : makeInjectTransport(appInstance, storeInstance);

  const gateway = new PrivacyGateway();
  gateway.authorize({
    purpose: 'financial_planning',
    provider: providerName,
    allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification', 'follow_up'],
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });

  const coordinator = new ClientAgentCoordinator(gateway, transport, providerName);

  let updatedProfileAfterClarify = null;
  let updatedGoalAfterClarify = null;

  try {
    const report = await coordinator.runPlanningLoop(caseSpec.profile, caseSpec.goal, {
      onRunCreated: (id) => {
        activeRunId = id;
      },
      clarificationHandler: async (tool) => {
        switch (tool.params.fieldCategory) {
          case 'timing_flexibility_confirmation':
            return { action: 'answer', clarificationChoice: caseSpec.goal.timingFlexibility === 'fixed' ? 'timing_fixed' : 'timing_flexible' };
          case 'expense_refinement':
            return { action: 'answer', clarificationChoice: 'expense_confirmed_accurate' };
          case 'income_variability_detail':
            return { action: 'decline', rejectionCategory: 'prefer_not_to_share_income_detail' };
          default:
            return { action: 'decline', rejectionCategory: 'prefer_not_to_share_family' };
        }
      },
    });

    activeRunId = report.runId;

    const followUp = await coordinator.askFollowUp(
      caseSpec.profile,
      report,
      {
        intent: 'explain_verdict_and_risk',
        selectedScenarioId: report.selectedScenarioId,
      },
      caseSpec.goal.version
    );

    const durationMs = Date.now() - startedAt;
    const sessionObj = storeInstance.getSession(report.runId);
    const wire = [...currentAudit.browser, ...currentAudit.model].join('\n');
    const effectiveProfile = updatedProfileAfterClarify ?? caseSpec.profile;
    const effectiveGoal = updatedGoalAfterClarify ?? caseSpec.goal;
    const amounts = [effectiveProfile.availableDeposit, effectiveProfile.monthlyIncome?.amount,
      effectiveProfile.essentialExpenses?.amount, effectiveGoal.targetAmount,
      ...effectiveProfile.debts.flatMap(d => [d.balance, d.repaymentAmount])].filter(n => typeof n === 'number' && n >= 100);
    const amountTokens = [...new Set(amounts.flatMap(n => [String(n), String(n / 100)]))];
    const leakedAmount = amountTokens.some(token => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`).test(wire);
    });
    const privacyAuditPassed = currentAudit.browser.length > 0 && !leakedAmount &&
      !wire.includes(caseSpec.profile.nickname) && !wire.includes('family_burden_category') &&
      (providerName === 'mock_provider' || currentAudit.model.length > 0);

    const constraintViolations = [];
    if (!report.isVerified) constraintViolations.push('report_not_verified');
    if (
      caseSpec.goal.timingFlexibility === 'fixed' &&
      report.selectedScenarioId.includes('_delay')
    ) {
      constraintViolations.push('fixed_goal_selected_delay');
    }
    if (followUp.citedEvidenceId !== report.evidenceId) {
      constraintViolations.push('followup_evidence_mismatch');
    }

    if (!Array.isArray(caseSpec.expectedVerdicts) || caseSpec.expectedVerdicts.length === 0 || caseSpec.expectedVerdicts.length > 2) {
      throw new Error('Missing explicit expected verdict');
    }
    const expectVerdictMatch = caseSpec.expectedVerdicts.includes(report.verdict) ? 'pass' : 'fail';

    const gateFailed =
      !privacyAuditPassed || constraintViolations.length > 0 || expectVerdictMatch === 'fail';

    return {
      caseId: caseSpec.id,
      runIndex,
      description: caseSpec.description,
      scenario: caseSpec.scenario,
      status: gateFailed ? 'failed' : 'passed',
      dimensions: {
        flow: 'passed',
        schema: 'passed',
        privacy: privacyAuditPassed ? 'passed' : 'failed',
        constraints: constraintViolations.length === 0 ? 'passed' : 'failed',
        verdict: expectVerdictMatch === 'pass' ? 'passed' : 'failed',
      },
      ...(gateFailed
        ? {
            error: [
              !privacyAuditPassed ? 'privacy_audit_failed' : null,
              constraintViolations.length > 0 ? constraintViolations.join(',') : null,
              expectVerdictMatch === 'fail'
                ? `expected_verdict_${caseSpec.expectedVerdicts.join("_or_")}_got_${report.verdict}`
                : null,
            ]
              .filter(Boolean)
              .join('; '),
          }
        : {}),
      runId: report.runId,
      verdict: report.verdict,
      selectedScenarioId: report.selectedScenarioId,
      evidenceId: report.evidenceId,
      followUpCitedEvidenceId: followUp.citedEvidenceId,
      isVerified: report.isVerified,
      privacyAuditPassed,
      privacyEvidence: { browserRequestCount: currentAudit.browser.length, modelRequestCount: currentAudit.model.length,
        modelEgress: providerName === 'mock_provider' ? 'not_applicable_mock' : 'captured_fetch_body' },
      constraintViolations,
      tokenUsage: sessionObj?.getTokenUsage() ?? null,
      provider: providerName,
      model: modelName,
      transportMode: baseUrl ? 'http_sse' : 'inject',
      durationMs,
      isMockResult: providerName === 'mock_provider',
      expectedVerdicts: caseSpec.expectedVerdicts,
      expectVerdictMatch,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const sessionObj = activeRunId ? storeInstance.getSession(activeRunId) : null;
    const wire = [...currentAudit.browser, ...currentAudit.model].join('\n');
    let leakedAmount = false;
    let privacyAuditPassed = 'not_evaluated';
    if (wire.length > 0) {
      const amounts = [
        caseSpec.profile.availableDeposit,
        caseSpec.profile.monthlyIncome?.amount,
        caseSpec.profile.essentialExpenses?.amount,
        caseSpec.goal.targetAmount,
        ...caseSpec.profile.debts.flatMap((d) => [d.balance, d.repaymentAmount]),
      ].filter((n) => typeof n === 'number' && n >= 100);
      const amountTokens = [...new Set(amounts.flatMap((n) => [String(n), String(n / 100)]))];
      leakedAmount = amountTokens.some((token) => {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`).test(wire);
      });
      const leakedNickname = wire.includes(caseSpec.profile.nickname);
      const leakedFamily = wire.includes('family_burden_category');
      if (leakedAmount || leakedNickname || leakedFamily) {
        privacyAuditPassed = false;
      } else if (currentAudit.browser.length > 0) {
        privacyAuditPassed = true;
      }
    }

    const isSchemaErr =
      err.message.includes('schema') ||
      err.message.includes('INVALID_') ||
      err.message.includes('ZodError');

    return {
      caseId: caseSpec.id,
      runIndex,
      description: caseSpec.description,
      scenario: caseSpec.scenario,
      status: 'failed',
      dimensions: {
        flow: 'failed',
        schema: isSchemaErr ? 'failed' : 'not_evaluated',
        privacy: privacyAuditPassed === false ? 'failed' : (privacyAuditPassed === true ? 'passed' : 'not_evaluated'),
        constraints: 'not_evaluated',
        verdict: 'not_evaluated',
      },
      error: err.message,
      privacyAuditPassed: privacyAuditPassed === false ? false : (privacyAuditPassed === true ? true : null),
      privacyEvidence: { browserRequestCount: currentAudit.browser.length, modelRequestCount: currentAudit.model.length },
      constraintViolations: [],
      tokenUsage: sessionObj?.getTokenUsage() ?? null,
      provider: providerName,
      model: modelName,
      transportMode: baseUrl ? 'http_sse' : 'inject',
      durationMs,
      isMockResult: providerName === 'mock_provider',
      timestamp: new Date().toISOString(),
    };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const totalRuns = args.runs;
  const totalCases = TEST_CASES.length;

  console.warn(`\n[batch-eval] Provider: ${providerName} | Model: ${modelName}`);
  console.warn(
    `[batch-eval] Transport: ${args.transport} | Cases: ${totalCases} × ${totalRuns} runs = ${totalCases * totalRuns} total\n`
  );

  const isMock = providerName === 'mock_provider';
  if (isMock) {
    console.warn('[batch-eval] ⚠️  Using MOCK provider — results are NOT real AI outputs');
  }

  const store = new SessionStore();
  const app = buildApp({
    provider,
    store,
    createRunRateLimiter: new RateLimiter({ windowMs: 60_000, maxRequests: 1000 }),
    toolResultRateLimiter: new RateLimiter({ windowMs: 60_000, maxRequests: 1000 }),
    disclosureGuard: new DisclosureGuard({ maxRunsPerWindow: 1000, maxDistinctProbesPerWindow: 1000 }),
  });

  let baseUrl = null;
  if (args.transport === 'http') {
    const addr = await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = addr;
  } else {
    await app.ready();
  }

  const allResults = [];
  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    for (let run = 1; run <= totalRuns; run++) {
      process.stdout.write(`  [${tc.id}] run ${run}/${totalRuns}... `);
      const result = await runCase(tc, run, app, store, baseUrl);
      allResults.push(result);

      if (result.status === 'passed') {
        passed++;
        process.stdout.write(`✓ verdict=${result.verdict} (${result.durationMs}ms)\n`);
      } else {
        failed++;
        process.stdout.write(`✗ ERROR: ${result.error}\n`);
      }
    }
  }

  await app.close();

  // ─── Output Report ──────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const outDir = path.join(__dirname, 'eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `cloud-eval-${ts}.json`);

  const verdictMismatches = allResults.filter((r) => r.expectVerdictMatch === 'fail');
  const privacyFailures = allResults.filter((r) => r.privacyAuditPassed === false);
  const constraintFailures = allResults.filter((r) => (r.constraintViolations?.length ?? 0) > 0);
  const durations = allResults.map((r) => r.durationMs).filter((d) => Number.isFinite(d));
  const totalPromptTokens = allResults.reduce((acc, r) => acc + (r.tokenUsage?.promptTokens ?? 0), 0);
  const totalCompletionTokens = allResults.reduce(
    (acc, r) => acc + (r.tokenUsage?.completionTokens ?? 0),
    0
  );

  const report = {
    generatedAt: new Date().toISOString(),
    provider: providerName,
    model: modelName,
    transportMode: baseUrl ? 'http_sse' : 'inject',
    isMockResults: isMock,
    totalCases,
    totalRuns,
    totalExecuted: allResults.length,
    passCount: passed,
    failCount: failed,
    verdictMismatchCount: verdictMismatches.length,
    privacyFailureCount: privacyFailures.length,
    privacyEvidence: {
      browserRequestCount: allResults.reduce((sum, r) => sum + (r.privacyEvidence?.browserRequestCount ?? 0), 0),
      modelRequestCount: allResults.reduce((sum, r) => sum + (r.privacyEvidence?.modelRequestCount ?? 0), 0),
      modelEgress: isMock ? 'not_applicable_mock' : 'captured_fetch_body',
      scope: 'Synthetic-case exact values and allowed DTO fields; not a general non-disclosure proof',
    },
    constraintViolationCount: constraintFailures.length,
    performance: {
      avgDurationMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0,
      maxDurationMs: durations.length ? Math.max(...durations) : 0,
      totalPromptTokens,
      totalCompletionTokens,
    },
    mockSummary: isMock
      ? { executed: allResults.length, passed, failed }
      : { executed: 0, passed: 0, failed: 0 },
    cloudSummary: !isMock
      ? { executed: allResults.length, passed, failed }
      : { executed: 0, passed: 0, failed: 0 },
    summary: {
      byScenario: ['large_purchase', 'income_reduction', 'savings_goal'].map((s) => ({
        scenario: s,
        runs: allResults.filter((r) => r.scenario === s).length,
        passed: allResults.filter((r) => r.scenario === s && r.status === 'passed').length,
        verdictDist: Object.fromEntries(
          ['viable', 'caution', 'not_viable'].map((v) => [
            v,
            allResults.filter((r) => r.scenario === s && r.status === 'passed' && r.verdict === v)
              .length,
          ])
        ),
      })),
    },
    results: allResults,
  };

  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

  console.warn(`\n[batch-eval] ─────────────────────────────────────────`);
  console.warn(`[batch-eval]  Passed:  ${passed}/${allResults.length}`);
  console.warn(`[batch-eval]  Failed:  ${failed}/${allResults.length}`);
  console.warn(`[batch-eval]  Privacy Failures: ${privacyFailures.length}`);
  console.warn(`[batch-eval]  Constraint Violations: ${constraintFailures.length}`);
  console.warn(`[batch-eval]  Verdict Mismatches: ${verdictMismatches.length}`);
  console.warn(`[batch-eval]  Mock results: ${isMock ? 'YES (not real AI)' : 'NO (real AI)'}`);
  console.warn(`[batch-eval]  Report: ${outFile}`);
  console.warn(`[batch-eval] ─────────────────────────────────────────\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[batch-eval] Fatal error:', err);
  process.exit(1);
});
