import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { MockModelProvider } from './providers/mock.js';
import { SessionStore } from './agent/store.js';
import { ClientAgentCoordinator, type ClientTransport } from '../../web/src/agent-client/client.js';
import { PrivacyGateway } from '../../web/src/local/privacy/gateway.js';
import type { UserProfile } from '../../web/src/features/profile/types.js';
import type { LargePurchaseGoal } from '../../web/src/local/finance/calculator.js';
import type { RunRequest, AgentEvent } from '@maggot/contracts';

describe('Agent Loop & Browser Tool Orchestration (T5/P3, H-04~H-07, A-01~A-04, P-01~P-09)', () => {
  let app: FastifyInstance;
  let mockProvider: MockModelProvider;
  let store: SessionStore;
  let gateway: PrivacyGateway;

  const sampleProfile: UserProfile = {
    nickname: 'TestUser',
    availableDeposit: 1000000, // 10,000.00 in cents
    monthlyIncome: { status: 'fixed', amount: 500000, payDay: 11 }, // 5,000.00
    debtStatus: 'has_debt',
    debts: [
      {
        id: 'car_loan',
        name: 'Existing Loan',
        balance: 1000000,
        repaymentAmount: 100000, // 1,000.00
        frequency: 'monthly', nextPaymentDate: '2026-11-20',
      },
    ],
    essentialExpenses: {
      amount: 300000, // 3,000.00
      scope: 'individual', paymentDay: 15,
    },
    metadata: {
      version: 1,
      dataDate: '2026-11-10T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-10T00:00:00Z',
    },
  };

  const carGoal: LargePurchaseGoal = {
    id: 'goal_car_purchase',
    name: 'Family Car',
    targetAmount: 600000, // 6,000.00
    targetHorizonMonths: 6,
    cashReserveFloor: 500000, // 5,000.00 reserve
    timingFlexibility: 'flexible',
    version: 'v1',
  };

  beforeEach(async () => {
    mockProvider = new MockModelProvider({ behavior: 'standard' });
    store = new SessionStore();
    app = buildApp({ provider: mockProvider, store, skipTokenValidation: true });
    await app.ready();

    gateway = new PrivacyGateway();
    gateway.authorize({
      purpose: 'financial_planning',
      provider: 'mock_provider',
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification'],
      expiresAt: new Date(Date.now() + 100000).toISOString(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  // Create an in-memory test transport that talks to the Fastify instance directly
  function createTestTransport(): ClientTransport {
    return {
      async createRun(request: RunRequest) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/runs',
          payload: request,
        });
        expect(res.statusCode).toBe(201);
        return JSON.parse(res.body);
      },
      async submitToolResult(runId: string, result: unknown) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/runs/${runId}/tool-results`,
          payload: result as Record<string, any>,
        });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body);
      },
      async cancelRun(runId: string, reason: string) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/runs/${runId}/cancel`,
          payload: { reason },
        });
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body);
      },
      async fetchEvents(runId: string) {
        const session = store.getSession(runId);
        if (!session) return [];
        return session.getEventHistory();
      },
    };
  }

  it('H-05/A-01: Completes standard agent planning loop with local tool evaluation and interpolated report', async () => {
    const transport = createTestTransport();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const emittedEvents: AgentEvent[] = [];
    const report = await coordinator.runPlanningLoop(sampleProfile, carGoal, {
      onEvent: (evt) => emittedEvents.push(evt),
    });

    // 1. Verify report
    expect(report.isVerified).toBe(true);
    expect(report.verdict).toBe('viable');
    expect(report.selectedScenarioId).toBe('goal_car_purchase_orig');
    expect(report.exactTargetAmount).toBe(600000); // 6,000.00
    expect(report.exactEndingCash).toBe(1000000); // 10,000.00
    expect(report.exactMinimumCash).toBe(1000000); // 10,000.00 >= 5,000 reserve floor

    // 2. Verify event sequence
    const eventTypes = emittedEvents.map((e) => e.type);
    expect(eventTypes).toContain('status_changed');
    expect(eventTypes).toContain('tool_requested');
    expect(eventTypes).toContain('completed');

    // 3. Verify server state: check that Node.js session never received raw numbers (P-01, H-04)
    const session = store.getSession(report.runId);
    expect(session).toBeDefined();
    const serializedHistory = JSON.stringify(session?.getEventHistory());
    expect(serializedHistory).not.toContain('600000');
    expect(serializedHistory).not.toContain('1000000');
    expect(serializedHistory).not.toContain('500000');
    expect(serializedHistory).not.toContain('TestUser');
  });

  it('A-03: Blocks analysis when model hallucinates an invalid or fabricated evidence ID', async () => {
    // Configure mock provider to hallucinate fake evidence
    mockProvider.setBehavior('hallucinate_fake_evidence');

    const transport = createTestTransport();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    await expect(coordinator.runPlanningLoop(sampleProfile, carGoal)).rejects.toThrow(
      /UNVERIFIED_OR_UNRELIABLE_ANALYSIS|Security Exception \(A-03\)/
    );
  });

  it('H-05: Clarification modifies goal, cancels parent run, and inherits budget in continuation run', async () => {
    mockProvider.setBehavior('request_clarification_first');

    const transport = createTestTransport();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    let clarificationTriggered = false;

    const report = await coordinator.runPlanningLoop(sampleProfile, carGoal, {
      clarificationHandler: async (req) => {
        clarificationTriggered = true;
        expect(req.toolName).toBe('request_clarification');
        // User changes goal timing to 9 months
        const updatedGoal: LargePurchaseGoal = {
          ...carGoal,
          targetHorizonMonths: 9,
          version: 'v2',
        };
        return {
          action: 'modify_input',
          updatedGoal,
        };
      },
    });

    expect(clarificationTriggered).toBe(true);
    expect(report.isVerified).toBe(true);
    expect(report.verdict).toBe('viable');

    const contSession = store.getSession(report.runId)!;
    expect(contSession.request.parentRunId).toBeDefined();
    expect(contSession.request.originalClarificationCallId).toBeDefined();
    // Parent had 1 step + 1 toolCall; continuation had 2 steps + 1 toolCall => inherited totals
    expect(contSession.getUsage().stepCount).toBeGreaterThanOrEqual(3);
    expect(contSession.getUsage().toolCallCount).toBeGreaterThanOrEqual(2);
  });

  it('H-05: Late tool submission on cancelled run is rejected', async () => {
    const transport = createTestTransport();
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    // Start a run
    const candidateScenarios = [
      {
        scenarioId: 'sc1',
        scenarioKind: 'original_plan' as const,
        adjustmentTier: 'none' as const,
        assumptionCategory: 'baseline' as const,
        assumptionVersion: 'v1',
      },
    ];
    const { runId } = await transport.createRun({
      protocolVersion: '1.0',
      snapshotVersion: 'snap_1',
      goalVersion: 'v1',
      policyVersion: 'p_1.0',
      candidateScenarios,
      safeProfileSummary: {
        income_stability: 'stable',
        essential_expense_share: '30_40_pct',
        debt_service_share: '10_20_pct',
        cash_runway: '3_6_months',
        data_quality: {
          completeness: 'user_confirmed_complete',
          freshness: 'within_7_days',
        },
      },
      safeGoalSummary: {
        task_type: 'large_purchase',
        horizon: '6_12_months',
        cost_in_monthly_surplus: '3_6_months',
        timing_flexibility: 'flexible',
      },
    });

    // Cancel run
    await transport.cancelRun(runId, 'user_abandoned');

    const session = store.getSession(runId);
    expect(session?.getStatus()).toBe('cancelled');

    // Attempt to submit tool result to cancelled session
    const fakeResult = {
      callId: 'call_fake',
      toolName: 'evaluate_scenario',
      scenarioId: 'sc1',
      status: 'satisfied',
      isReliable: true,
      evidenceId: 'ev_123',
      versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
    };

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tool-results`,
      payload: fakeResult,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('Run has been cancelled');
  });
});
