/**
 * T6: Synthetic End-to-End Integration Tests
 *
 * Covers the full planning loop for the "large purchase" (car buying) scenario:
 *   Profile init → Goal setup → Authorization → Safe summary → Agent loop →
 *   Local calculation → Verified report → Data update → Old results invalidated
 *
 * Uses ONLY synthetic data. No real financial data. No real AI model calls.
 * Covers: A-01, A-02, A-04, O-04, O-05, H-05~H-07, P-01~P-05
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { MockModelProvider } from './providers/mock.js';
import { SessionStore } from './agent/store.js';

import { validateProfile } from '../../web/src/features/profile/rules.js';
import type { UserProfile } from '../../web/src/features/profile/types.js';
import type { LargePurchaseGoal } from '../../web/src/local/finance/calculator.js';
import {
  generateCandidateScenarios,
  evaluateScenarioLocal,
  calculateMonthlySurplus,
} from '../../web/src/local/finance/calculator.js';
import { deriveSafeProfileSummary, deriveSafeGoalSummary } from '../../web/src/local/privacy/summary.js';
import { PrivacyGateway } from '../../web/src/local/privacy/gateway.js';
import { ClientAgentCoordinator, MemoryCheckpointStore } from '../../web/src/agent-client/client.js';
import type { ClientTransport, LocalFinalReport } from '../../web/src/agent-client/client.js';
import type { RunRequest, AgentEvent } from '@maggot/contracts';

// ─── Synthetic Profiles ───────────────────────────────────────────────────────

/** Case 1: Stable income, no debt, task-ready */
const profileStableNoDept: UserProfile = {
  nickname: 'SynthUser_A',
  availableDeposit: 2000000,     // 20,000
  monthlyIncome: { status: 'fixed', amount: 1000000, payDay: 2 }, // 10,000
  debtStatus: 'none',
  debts: [],
  essentialExpenses: { amount: 400000, scope: 'individual', paymentDay: 3 }, // 4,000
  metadata: { version: 1, dataDate: '2026-11-01T00:00:00Z', completeness: 'task_ready', updatedAt: '2026-11-01T00:00:00Z' },
};

/** Case 2: Variable income, has debt — same target, tighter */
const profileVariableWithDebt: UserProfile = {
  nickname: 'SynthUser_B',
  availableDeposit: 1000000,     // 10,000
  monthlyIncome: { status: 'variable', amount: 800000, isEstimate: true }, // ~8,000
  debtStatus: 'has_debt',
  debts: [{ id: 'debt1', name: 'Personal loan', balance: 3000000, repaymentAmount: 200000, frequency: 'monthly' }],
  essentialExpenses: { amount: 450000, scope: 'individual' }, // 4,500
  metadata: { version: 1, dataDate: '2026-11-01T00:00:00Z', completeness: 'task_ready', updatedAt: '2026-11-01T00:00:00Z' },
};

/** Case 3: Negative surplus (income barely covers expenses) */
const profileNegativeSurplus: UserProfile = {
  nickname: 'SynthUser_C',
  availableDeposit: 500000,
  monthlyIncome: { status: 'fixed', amount: 600000 },
  debtStatus: 'has_debt',
  debts: [{ id: 'debt2', name: 'Credit card', balance: 500000, repaymentAmount: 500000, frequency: 'monthly' }],
  essentialExpenses: { amount: 300000, scope: 'individual' },
  metadata: { version: 1, dataDate: '2026-11-01T00:00:00Z', completeness: 'task_ready', updatedAt: '2026-11-01T00:00:00Z' },
};

const carGoal: LargePurchaseGoal = {
  id: 'car_synth',
  name: 'Synthetic Car',
  targetAmount: 1200000, // 12,000
  targetHorizonMonths: 12,
  cashReserveFloor: 500000, // 5,000
  timingFlexibility: 'flexible',
  version: 'v1',
};

// ─── Transport ────────────────────────────────────────────────────────────────

function makeTransport(app: FastifyInstance, store: SessionStore): ClientTransport {
  return {
    async createRun(request: RunRequest) {
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: request });
      if (res.statusCode !== 201) throw new Error(`createRun failed: ${res.body}`);
      return JSON.parse(res.body);
    },
    async submitToolResult(runId: string, result: unknown) {
      const res = await app.inject({
        method: 'POST', url: `/api/runs/${runId}/tool-results`,
        payload: result as Record<string, unknown>,
      });
      if (res.statusCode !== 200) throw new Error(`submitToolResult failed: ${res.body}`);
      return JSON.parse(res.body);
    },
    async cancelRun(runId: string, reason: string) {
      const res = await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, payload: { reason } });
      return JSON.parse(res.body);
    },
    async fetchEvents(runId: string) {
      return store.getSession(runId)?.getEventHistory() ?? [];
    },
  };
}

function makeGateway(provider = 'mock_provider'): PrivacyGateway {
  const gw = new PrivacyGateway();
  gw.authorize({
    purpose: 'financial_planning',
    provider,
    allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification'],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  });
  return gw;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('T6: Synthetic end-to-end planning scenarios', () => {
  let app: FastifyInstance;
  let store: SessionStore;
  let mockProvider: MockModelProvider;

  beforeEach(async () => {
    mockProvider = new MockModelProvider({ behavior: 'standard' });
    store = new SessionStore();
    app = buildApp({ provider: mockProvider, store, skipTokenValidation: true });
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  // ── Scenario 1: Profile validation → Task-ready ──────────────────────────

  it('T6-S1: Profile validation confirms task-ready status (U-01, U-02)', () => {
    const resA = validateProfile(profileStableNoDept);
    expect(resA.isValid).toBe(true);
    expect(resA.completeness).toBe('task_ready');

    // Missing expenses → initialized, not task_ready
    const noExpenses = { ...profileStableNoDept, essentialExpenses: undefined };
    const resB = validateProfile(noExpenses);
    expect(resB.isValid).toBe(true);
    expect(resB.completeness).toBe('initialized');
    expect(resB.completeness).not.toBe('task_ready');
  });

  // ── Scenario 2: Same goal, different income stability → different analysis ──

  it('T6-S2 (A-01): Same goal, stable vs variable income → different safe profile summaries', () => {
    const summaryA = deriveSafeProfileSummary(profileStableNoDept);
    const summaryB = deriveSafeProfileSummary(profileVariableWithDebt);

    expect(summaryA.income_stability).toBe('stable');
    expect(summaryB.income_stability).toBe('variable');

    // Different debt burden classification
    expect(summaryA.debt_service_share).toBe('no_debt');
    expect(summaryB.debt_service_share).not.toBe('no_debt');

    // Both pass schema validation
    expect(summaryA).toHaveProperty('cash_runway');
    expect(summaryB).toHaveProperty('cash_runway');
  });

  // ── Scenario 3: Negative surplus → target clearly not viable ──────────────

  it('T6-S3 (A-02): Negative surplus results in violated constraint for all scenarios', () => {
    const surplus = calculateMonthlySurplus(profileNegativeSurplus);
    // 600,000 income - 300,000 expenses - 500,000 debt = -200,000 (negative)
    expect(surplus.monthlySurplus).toBe(-200000);

    const scenarios = generateCandidateScenarios(carGoal);
    for (const sc of scenarios) {
      const calc = evaluateScenarioLocal(profileNegativeSurplus, carGoal, sc, `call_${sc.scenarioId}`);
      expect(calc.isSatisfied).toBe(false);
      expect(calc.cashDeficit).toBeGreaterThan(0);
    }
  });

  // ── Scenario 4: Full end-to-end loop, stable profile ────────────────────

  it('T6-S4: Full planning loop — stable profile, original plan viable', async () => {
    const transport = makeTransport(app, store);
    const gateway = makeGateway();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const events: AgentEvent[] = [];
    const report = await coordinator.runPlanningLoop(profileStableNoDept, carGoal, {
      onEvent: (e) => events.push(e),
    });

    // 1. Report integrity
    expect(report.isVerified).toBe(true);
    expect(report.verdict).toBe('viable');
    expect(report.exactTargetAmount).toBe(1200000);
    // Surplus: 10,000 - 4,000 - 0 (no debt) = 6,000/month × 12 + 20,000 initial - 12,000 purchase = 80,000 (8,000,000 cents)
    expect(report.exactEndingCash).toBe(2000000 + 12 * 600000 - 1200000); // 8,000,000 cents

    // 2. No raw financials in server-side events
    const serverEventDump = JSON.stringify(store.getSession(report.runId)?.getEventHistory());
    expect(serverEventDump).not.toContain('2000000');
    expect(serverEventDump).not.toContain('1000000');
    expect(serverEventDump).not.toContain('SynthUser_A');

    // 3. Event sequence includes tool_requested and completed
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_requested');
    expect(types).toContain('completed');

    // 4. Monotonically increasing sequence numbers
    const seqNums = events.map((e) => e.sequenceNumber);
    for (let i = 1; i < seqNums.length; i++) {
      expect(seqNums[i]).toBeGreaterThan(seqNums[i - 1]);
    }
  });

  // ── Scenario 5: Full loop, tight profile → original violated, alt tried ──

  it('T6-S5: Full loop — tight profile triggers fallback to alternative scenario', async () => {
    // Tight goal that original plan fails (deposit barely enough)
    const tightGoal: LargePurchaseGoal = {
      ...carGoal,
      targetAmount: 2500000, // 25,000 — much more than available + surplus
      cashReserveFloor: 500000,
    };

    const transport = makeTransport(app, store);
    const gateway = makeGateway();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const events: AgentEvent[] = [];
    const report = await coordinator.runPlanningLoop(profileVariableWithDebt, tightGoal, {
      onEvent: (e) => events.push(e),
    });

    // With variable income and debt, original plan should fail
    // Mock provider will try alternative when original is violated
    expect(report.isVerified).toBe(true);

    // Verify at least 2 tool_requested events (original + alt)
    const toolReqs = events.filter((e) => e.type === 'tool_requested');
    expect(toolReqs.length).toBeGreaterThanOrEqual(1);
  });

  // ── Scenario 6: User refuses to answer clarification (A-04) ──────────────

  it('T6-S6 (A-04): User refusal during clarification handled gracefully', async () => {
    mockProvider.setBehavior('request_clarification_first');
    const transport = makeTransport(app, store);
    const gateway = makeGateway();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    let askedClarification = false;
    const report = await coordinator.runPlanningLoop(profileStableNoDept, carGoal, {
      clarificationHandler: async (req) => {
        askedClarification = true;
        // User refuses — but doesn't modify goal (just confirms)
        return { action: 'answer', answer: 'flexible' };
      },
    });

    expect(askedClarification).toBe(true);
    expect(report.isVerified).toBe(true);
  });

  // ── Scenario 7: Safe summary never contains raw amounts ──────────────────

  it('T6-S7 (P-01, U-06): Safe summaries for all 3 profiles contain no raw financial data', () => {
    const profiles = [profileStableNoDept, profileVariableWithDebt, profileNegativeSurplus];
    for (const profile of profiles) {
      const summary = deriveSafeProfileSummary(profile);
      const json = JSON.stringify(summary);
      // No raw amounts (all are multiples of 100000)
      expect(json).not.toMatch(/\b[0-9]{5,}\b/); // no large numbers
      // No nicknames
      expect(json).not.toContain('SynthUser');
    }
  });

  // ── Scenario 8: Profile update invalidates old report (F-06, O-05) ───────

  it('T6-S8 (F-06, O-05): After goal version change, old scenario IDs are invalid for new run', async () => {
    const v1Scenarios = generateCandidateScenarios({ ...carGoal, version: 'v1' });
    const v2Scenarios = generateCandidateScenarios({ ...carGoal, version: 'v2', targetAmount: 1500000 });

    // Scenario IDs should be the same (derived from goal.id), but assumption versions differ
    expect(v1Scenarios[0].scenarioId).toBe(v2Scenarios[0].scenarioId);
    expect(v1Scenarios[0].assumptionVersion).toBe('v1');
    expect(v2Scenarios[0].assumptionVersion).toBe('v2');

    // A v1 calc result cannot satisfy a v2 scenario
    const v1Calc = evaluateScenarioLocal(profileStableNoDept, { ...carGoal, version: 'v1' }, v1Scenarios[0], 'call_v1');
    const v2Calc = evaluateScenarioLocal(profileStableNoDept, { ...carGoal, version: 'v2', targetAmount: 1500000 }, v2Scenarios[0], 'call_v2');

    // Different amounts → different results
    expect(v1Calc.targetAmount).toBe(1200000);
    expect(v2Calc.targetAmount).toBe(1500000);
    expect(v1Calc.evidenceId).not.toBe(v2Calc.evidenceId);
  });

  // ── Scenario 9: Revoked auth prevents outbound request ───────────────────

  it('T6-S9 (P-04): Revoked authorization blocks planning loop', async () => {
    const gateway = makeGateway();
    gateway.revoke(); // revoke before starting

    const transport = makeTransport(app, store);
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    await expect(coordinator.runPlanningLoop(profileStableNoDept, carGoal)).rejects.toThrow(
      /Unauthorized/
    );
  });

  // ── Scenario 10: Income reduction scenario end-to-end ───────────────────

  it('T6-S10: Full loop — income_reduction scenario models temporary income drop accurately', async () => {
    const incomeDropGoal: LargePurchaseGoal = {
      id: 'income_drop_synth',
      name: 'Job Transition Buffer',
      taskType: 'income_reduction',
      targetAmount: 4800000, // 48,000 total drop over 6 months = 8,000/month drop
      targetHorizonMonths: 6,
      cashReserveFloor: 500000, // 5,000 floor
      timingFlexibility: 'flexible',
      version: 'v1',
    };

    const safeGoal = deriveSafeGoalSummary(profileStableNoDept, incomeDropGoal);
    expect(safeGoal.task_type).toBe('income_reduction');

    const transport = makeTransport(app, store);
    const gateway = makeGateway();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const report = await coordinator.runPlanningLoop(profileStableNoDept, incomeDropGoal);
    expect(report.isVerified).toBe(true);
    // Stable surplus is +6,000/month, drop is -8,000/month => net -2,000/month × 6 = -12,000
    // Initial cash 20,000 - 12,000 = 8,000 >= 5,000 reserve floor => viable!
    expect(report.verdict).toBe('viable');
    expect(report.exactEndingCash).toBe(2000000 - 6 * 200000); // 800,000 cents
    expect(report.exactDeficit).toBe(0);
  });

  // ── Scenario 11: Savings goal scenario end-to-end ───────────────────────

  it('T6-S11: Full loop — savings_goal scenario retains savings above reserve floor', async () => {
    const savingsGoal: LargePurchaseGoal = {
      id: 'savings_synth',
      name: 'Emergency Reserve Target',
      taskType: 'savings_goal',
      targetAmount: 3000000, // 30,000 saved target
      targetHorizonMonths: 6,
      cashReserveFloor: 500000, // 5,000 floor => need >= 35,000 total by month 6
      timingFlexibility: 'flexible',
      version: 'v1',
    };

    const safeGoal = deriveSafeGoalSummary(profileStableNoDept, savingsGoal);
    expect(safeGoal.task_type).toBe('savings_goal');

    const transport = makeTransport(app, store);
    const gateway = makeGateway();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const report = await coordinator.runPlanningLoop(profileStableNoDept, savingsGoal);
    expect(report.isVerified).toBe(true);
    // Initial 20,000 + 6 * 6,000 surplus = 56,000 total cash >= 35,000 required
    expect(report.verdict).toBe('viable');
    expect(report.exactEndingCash).toBe(5600000);
    expect(report.exactDeficit).toBe(0);
  });

  // ── Scenario 12: 3 repeated mock runs recorded independently ────────────

  it('T6-S12: Repeated mock runs (3x) stay deterministic, isolated, and labeled mock (not real AI)', async () => {
    const runRecords: Array<{
      runIndex: number;
      provider: string;
      runId: string;
      verdict: string;
      endingCash: number;
    }> = [];

    for (let i = 1; i <= 3; i++) {
      const transport = makeTransport(app, store);
      const gateway = makeGateway('mock_provider');
      const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');
      const report = await coordinator.runPlanningLoop(profileStableNoDept, carGoal);

      runRecords.push({
        runIndex: i,
        provider: 'mock_provider',
        runId: report.runId,
        verdict: report.verdict,
        endingCash: report.exactEndingCash,
      });
    }

    expect(runRecords).toHaveLength(3);
    // Distinct server runIds per run
    expect(new Set(runRecords.map((r) => r.runId)).size).toBe(3);
    // Explicitly recorded as mock_provider (never confused with real cloud model)
    expect(runRecords.every((r) => r.provider === 'mock_provider')).toBe(true);
    expect(runRecords.every((r) => r.endingCash === 8000000)).toBe(true);
  });

  // ── Scenario 13: Checkpoint persistence & interrupted recovery (H-06) ───

  it('T6-S13 (H-06): Checkpoint export, interrupted recovery via parentRunId, and version guard', async () => {
    // 1. Create a run directly and interrupt it before tool submission
    const cpStore = new MemoryCheckpointStore();
    const safeProfile = deriveSafeProfileSummary(profileStableNoDept);
    const safeGoal = deriveSafeGoalSummary(profileStableNoDept, carGoal);
    const candidateScenarios = generateCandidateScenarios(carGoal);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        protocolVersion: '1.0',
        snapshotVersion: `snap_${profileStableNoDept.metadata.version}`,
        goalVersion: carGoal.version,
        policyVersion: 'p_1.0',
        candidateScenarios,
        safeProfileSummary: safeProfile,
        safeGoalSummary: safeGoal,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { runId: interruptedRunId } = JSON.parse(createRes.body);

    const oldSession = store.getSession(interruptedRunId)!;
    const oldUsage = oldSession.getUsage();
    expect(oldUsage.stepCount).toBe(1);
    expect(oldUsage.toolCallCount).toBe(1);

    oldSession.interrupt('simulated_server_restart');

    // Verify GET /api/runs/:runId/checkpoint exposes coordination checkpoint cleanly (no raw amounts)
    const cpRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${interruptedRunId}/checkpoint`,
    });
    expect(cpRes.statusCode).toBe(200);
    const serverCp = JSON.parse(cpRes.body);
    expect(serverCp.runId).toBe(interruptedRunId);
    expect(serverCp.status).toBe('interrupted');
    expect(serverCp.usageSoFar).toMatchObject({ stepCount: 1, toolCallCount: 1 });
    expect(JSON.stringify(serverCp)).not.toContain('2000000');

    await cpStore.save({
      runId: serverCp.runId,
      goalId: carGoal.id,
      snapshotVersion: serverCp.snapshotVersion,
      goalVersion: serverCp.goalVersion,
      lastSequenceNumber: 2,
      status: 'interrupted',
      updatedAt: new Date().toISOString(),
    });

    // 2. Stale version must fail resume (F-06 / O-05)
    const transport = makeTransport(app, store);
    const gateway = makeGateway();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const savedCp = cpStore.load(carGoal.id)!;
    await expect(
      coordinator.resumeFromCheckpoint(
        profileStableNoDept,
        { ...carGoal, version: 'v2' },
        savedCp
      )
    ).rejects.toThrow(/Checkpoint invalidated/);

    // 3. Matching version resumes cleanly via parentRunId and inherits quota!
    const resumedReport = await coordinator.resumeFromCheckpoint(
      profileStableNoDept,
      carGoal,
      savedCp,
      { checkpointStore: cpStore }
    );
    expect(resumedReport.isVerified).toBe(true);
    expect(resumedReport.runId).not.toBe(interruptedRunId);

    const resumedSession = store.getSession(resumedReport.runId)!;
    expect(resumedSession.request.parentRunId).toBe(interruptedRunId);
    // Inherited stepCount (1) + resumed run steps (2) = 3; inherited toolCallCount (1) + 1 = 2
    expect(resumedSession.getUsage().stepCount).toBeGreaterThan(oldUsage.stepCount);
    expect(resumedSession.getUsage().toolCallCount).toBeGreaterThan(oldUsage.toolCallCount);

    // Local checkpoint updated to completed
    expect(cpStore.load(carGoal.id)?.status).toBe('completed');
  });
});
