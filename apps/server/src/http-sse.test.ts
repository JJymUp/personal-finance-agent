import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { MockModelProvider } from './providers/mock.js';
import { SessionStore } from './agent/store.js';
import { validateSessionToken } from './security/session-token.js';
import { ClientAgentCoordinator } from '../../web/src/agent-client/client.js';
import { createHttpTransport } from '../../web/src/agent-client/http-transport.js';
import { PrivacyGateway } from '../../web/src/local/privacy/gateway.js';
import type { UserProfile } from '../../web/src/features/profile/types.js';
import type { LargePurchaseGoal } from '../../web/src/local/finance/calculator.js';
import type { AgentEvent } from '@maggot/contracts';

/**
 * In-process fetch adapter backed by Fastify app.inject() + streaming SSE from SessionStore.
 * Allows exercising HttpClientTransport's HTTP serialization, X-Session-Token headers,
 * Last-Event-ID resumption, and SSE ReadableStream parsing inside the network-restricted sandbox.
 */
function createInjectFetch(app: FastifyInstance, store: SessionStore): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          if (v !== undefined) headers[k.toLowerCase()] = v;
        }
      }
    }

    // Stream SSE directly from session after enforcing X-Session-Token header (R02)
    const sseMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (method === 'GET' && sseMatch) {
      const runId = sseMatch[1];
      const session = store.getSession(runId);
      if (!session) {
        return new Response(JSON.stringify({ error: 'SESSION_NOT_FOUND' }), { status: 404 });
      }
      const token = headers['x-session-token'];
      if (!token || !validateSessionToken(runId, token, store)) {
        return new Response(
          JSON.stringify({ error: 'INVALID_SESSION_TOKEN', message: 'Missing or invalid X-Session-Token header.' }),
          { status: 403 }
        );
      }

      const rawLastId = headers['last-event-id'];
      const lastId = rawLastId && /^\d+$/.test(rawLastId) ? parseInt(rawLastId, 10) : 0;
      const encoder = new TextEncoder();
      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
      let unsub: (() => void) | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let lastSent = lastId;
          let closed = false;

          const pushEvt = (evt: AgentEvent) => {
            if (closed || evt.sequenceNumber <= lastSent) return;
            lastSent = evt.sequenceNumber;
            // Split across two chunks intentionally to exercise incremental SSE frame buffering
            const frame = `id: ${evt.sequenceNumber}\ndata: ${JSON.stringify(evt)}\n\n`;
            const mid = Math.floor(frame.length / 2);
            controller.enqueue(encoder.encode(frame.slice(0, mid)));
            controller.enqueue(encoder.encode(frame.slice(mid)));

            if (TERMINAL.has(evt.type)) {
              closed = true;
              unsub?.();
              controller.close();
            }
          };

          unsub = session.addEventListener(pushEvt);
          for (const evt of session.getEventHistory()) {
            pushEvt(evt);
          }

          if (!closed && TERMINAL.has(session.getStatus())) {
            closed = true;
            unsub();
            controller.close();
          }
        },
        cancel() {
          unsub?.();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    const res = await app.inject({
      method: method as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers,
      payload: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  };
}

describe('Real HTTP + SSE Transport Integration', () => {
  let app: FastifyInstance;
  let store: SessionStore;
  let mockProvider: MockModelProvider;
  let injectFetch: typeof fetch;
  let gateway: PrivacyGateway;

  const sampleProfile: UserProfile = {
    nickname: 'HttpTestUser',
    availableDeposit: 1_000_000,
    monthlyIncome: { status: 'fixed', amount: 500_000, payDay: 11 },
    debtStatus: 'has_debt',
    debts: [
      {
        id: 'car_loan',
        name: 'Existing Loan',
        balance: 1_000_000,
        repaymentAmount: 100_000,
        frequency: 'monthly', nextPaymentDate: '2026-11-20',
      },
    ],
    essentialExpenses: { amount: 300_000, scope: 'individual', paymentDay: 15 },
    metadata: {
      version: 1,
      dataDate: '2026-11-10T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-10T00:00:00Z',
    },
  };

  const carGoal: LargePurchaseGoal = {
    id: 'goal_http_car',
    name: 'HTTP Car',
    targetAmount: 600_000,
    targetHorizonMonths: 6,
    cashReserveFloor: 500_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  };

  beforeEach(async () => {
    mockProvider = new MockModelProvider({ behavior: 'standard' });
    store = new SessionStore();
    // Note: skipTokenValidation is false (real session token security enabled)
    app = buildApp({ provider: mockProvider, store });
    await app.ready();
    injectFetch = createInjectFetch(app, store);

    gateway = new PrivacyGateway();
    gateway.authorize({
      purpose: 'financial_planning',
      provider: 'mock_provider',
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification', 'follow_up'],
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('completes full planning loop over HTTP + SSE with X-Session-Token enforcement', async () => {
    const transport = createHttpTransport('http://127.0.0.1:3000', { fetchImpl: injectFetch });
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const events: AgentEvent[] = [];
    const report = await coordinator.runPlanningLoop(sampleProfile, carGoal, {
      onEvent: (evt) => events.push(evt),
    });

    expect(report.isVerified).toBe(true);
    expect(report.verdict).toBe('viable');
    expect(report.exactEndingCash).toBe(1_000_000);
    expect(events.some((e) => e.type === 'tool_requested')).toBe(true);
    expect(events.some((e) => e.type === 'completed')).toBe(true);
  });

  it('supports clarification modify_input continuation flow over HTTP + SSE', async () => {
    mockProvider.setBehavior('request_clarification_first');
    const transport = createHttpTransport('http://127.0.0.1:3000', { fetchImpl: injectFetch });
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const report = await coordinator.runPlanningLoop(sampleProfile, carGoal, {
      clarificationHandler: async () => ({
        action: 'modify_input',
        updatedGoal: { ...carGoal, targetHorizonMonths: 9, version: 'v2' },
      }),
    });

    expect(report.isVerified).toBe(true);
    expect(report.verdict).toBe('viable');
    const contSession = store.getSession(report.runId);
    expect(contSession?.request.parentRunId).toBeDefined();
    expect(contSession?.request.originalClarificationCallId).toBeDefined();
  });

  it('rejects HTTP tool-result submission without valid session token', async () => {
    const createRes = await injectFetch('http://127.0.0.1:3000/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: '1.0',
        snapshotVersion: 'snap_1',
        goalVersion: 'v1',
        policyVersion: 'p_1.0',
        candidateScenarios: [
          {
            scenarioId: 'sc_orig',
            scenarioKind: 'original_plan',
            adjustmentTier: 'none',
            assumptionCategory: 'baseline',
            assumptionVersion: 'v1',
          },
        ],
        safeProfileSummary: {
          income_stability: 'stable',
          essential_expense_share: '30_40_pct',
          debt_service_share: 'no_debt',
          cash_runway: '6_12_months',
          data_quality: { completeness: 'user_confirmed_complete', freshness: 'within_7_days' },
        },
        safeGoalSummary: {
          task_type: 'large_purchase',
          horizon: '6_12_months',
          cost_in_monthly_surplus: '3_6_months',
          timing_flexibility: 'flexible',
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const { runId } = (await createRes.json()) as { runId: string };

    // Missing X-Session-Token on tool-results, GET events, and GET checkpoint -> 403 (R02)
    const res = await injectFetch(`http://127.0.0.1:3000/api/runs/${runId}/tool-results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callId: 'call_x',
        toolName: 'evaluate_scenario',
        scenarioId: 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_x',
        versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
      }),
    });
    expect(res.status).toBe(403);

    const sseNoToken = await injectFetch(`http://127.0.0.1:3000/api/runs/${runId}/events`);
    expect(sseNoToken.status).toBe(403);

    const cpNoToken = await injectFetch(`http://127.0.0.1:3000/api/runs/${runId}/checkpoint`);
    expect(cpNoToken.status).toBe(403);

    // 64-char non-hex token must return 403 cleanly, never HTTP 500 (R02)
    const cpBadHex = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/checkpoint`,
      headers: { 'x-session-token': 'z'.repeat(64) },
    });
    expect(cpBadHex.statusCode).toBe(403);

    // Disallowed Origin header -> 403 ORIGIN_NOT_ALLOWED (R02)
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { origin: 'https://evil.example' },
      payload: {},
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(JSON.parse(badOrigin.body).error).toBe('ORIGIN_NOT_ALLOWED');
  });
});

describe('A-04 Refused Clarification & P-03 Post-Report Follow-up over HTTP', () => {
  it('A-04 & P-03: Handles declined clarification gracefully and answers controlled structured follow-up intents', async () => {
    const mockProvider = new MockModelProvider({ behavior: 'request_clarification_first' });
    const store = new SessionStore();
    const app = buildApp({ provider: mockProvider, store });
    await app.ready();
    const injectFetch = createInjectFetch(app, store);

    const gateway = new PrivacyGateway();
    gateway.authorize({
      purpose: 'financial_planning',
      provider: 'mock_provider',
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification', 'follow_up'],
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
    });

    const profile: UserProfile = {
      nickname: 'DeclineFollowUser',
      availableDeposit: 1_500_000,
      monthlyIncome: { status: 'fixed', amount: 1_000_000 },
      debtStatus: 'none',
      debts: [],
      essentialExpenses: { amount: 400_000, scope: 'individual' },
      metadata: {
        version: 1,
        dataDate: '2026-11-11T00:00:00Z',
        completeness: 'task_ready',
        updatedAt: '2026-11-11T00:00:00Z',
      },
    };
    const goal: LargePurchaseGoal = {
      id: 'goal_a04_p03',
      name: 'Planned Purchase',
      targetAmount: 600_000,
      targetHorizonMonths: 6,
      cashReserveFloor: 300_000,
      timingFlexibility: 'flexible',
      version: 'v1',
    };

    const transport = createHttpTransport('http://127.0.0.1:3000', { fetchImpl: injectFetch });
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    const report = await coordinator.runPlanningLoop(profile, goal, {
      clarificationHandler: async () => ({
        action: 'decline',
        rejectionCategory: 'prefer_not_to_share_flexibility',
      }),
    });

    expect(report.isVerified).toBe(true);
    expect(report.assumptionsUsed.some((a) => a.includes('declined optional clarification'))).toBe(true);

    // P-03 / R01: Ask structured post-report follow-up intent over HTTP with session token
    const followUp = await coordinator.askFollowUp(profile, report, {
      intent: 'explain_cash_buffer_impact',
      selectedScenarioId: report.selectedScenarioId,
    });
    expect(followUp.citedEvidenceId).toBe(report.evidenceId);
    expect(followUp.limitationsNoted.length).toBeGreaterThan(0);

    // P-03 / R01: Attempting to send arbitrary free-text question field is rejected
    await expect(
      coordinator.askFollowUp(profile, report, {
        intent: 'explain_verdict_and_risk',
        question: 'Since I have 15000 yuan, is that safe?',
      } as never)
    ).rejects.toThrow();

    // R14: Follow-up against stale goalVersion/snapshotVersion is rejected before hitting network
    await expect(
      coordinator.askFollowUp(profile, report, { intent: 'explain_verdict_and_risk' }, 'v2_changed')
    ).rejects.toThrow(/ReportStaleError/);

    await app.close();
  });

  it('R06 / R14: Reconnects to live server run without restarting, requires confirmation on lost server state, and rejects mid-run mutation', async () => {
    const mockProvider = new MockModelProvider({ behavior: 'standard' });
    const store = new SessionStore();
    const app = buildApp({ provider: mockProvider, store });
    await app.ready();
    const injectFetch = createInjectFetch(app, store);

    const gateway = new PrivacyGateway();
    gateway.authorize({
      purpose: 'financial_planning',
      provider: 'mock_provider',
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification', 'follow_up'],
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
    });

    const profile: UserProfile = {
      nickname: 'ReconnectUser',
      availableDeposit: 1_500_000,
      monthlyIncome: { status: 'fixed', amount: 1_000_000 },
      debtStatus: 'none',
      debts: [],
      essentialExpenses: { amount: 400_000, scope: 'individual' },
      metadata: {
        version: 1,
        dataDate: '2026-11-11T00:00:00Z',
        completeness: 'task_ready',
        updatedAt: '2026-11-11T00:00:00Z',
      },
    };
    const goal: LargePurchaseGoal = {
      id: 'goal_reconnect',
      name: 'Planned Purchase',
      targetAmount: 600_000,
      targetHorizonMonths: 6,
      cashReserveFloor: 300_000,
      timingFlexibility: 'flexible',
      version: 'v1',
    };

    const transport = createHttpTransport('http://127.0.0.1:3000', { fetchImpl: injectFetch });
    const coordinator = new ClientAgentCoordinator(gateway, transport, 'mock_provider');

    // Create a run directly so it waits in waiting_for_browser_tool
    const { deriveSafeProfileSummary, deriveSafeGoalSummary } = await import(
      '../../web/src/local/privacy/summary.js'
    );
    const { generateCandidateScenarios } = await import('../../web/src/local/finance/calculator.js');
    const created = await transport.createRun({
      protocolVersion: '1.0',
      snapshotVersion: 'snap_1',
      goalVersion: 'v1',
      policyVersion: 'p_1.0',
      candidateScenarios: generateCandidateScenarios(goal),
      safeProfileSummary: deriveSafeProfileSummary(profile),
      safeGoalSummary: deriveSafeGoalSummary(profile, goal),
    });

    const liveCheckpoint = {
      runId: created.runId,
      sessionToken: created.sessionToken,
      goalId: goal.id,
      snapshotVersion: 'snap_1',
      goalVersion: 'v1',
      policyVersion: 'p_1.0',
      lastSequenceNumber: 0,
      status: 'waiting_for_browser_tool' as const,
      updatedAt: new Date().toISOString(),
    };

    // R06: Resume attaches to the SAME live server runId (zero duplicate run creation)
    const resumed = await coordinator.resumeFromCheckpoint(profile, goal, liveCheckpoint);
    expect(resumed.runId).toBe(created.runId);
    expect(resumed.isVerified).toBe(true);

    // R06: When server state is lost, reject unless user explicitly confirms restart
    const lostCheckpoint = {
      ...liveCheckpoint,
      runId: 'run_lost_after_restart',
    };
    await expect(
      coordinator.resumeFromCheckpoint(profile, goal, lostCheckpoint)
    ).rejects.toThrow(/SERVER_SESSION_LOST/);

    const confirmedRestart = await coordinator.resumeFromCheckpoint(profile, goal, lostCheckpoint, {
      confirmRestartOnLostServerState: true,
    });
    expect(confirmedRestart.hasUncertainPriorSpend).toBe(true);

    // R14: Mid-run snapshot change aborts tool execution before completion
    await expect(
      coordinator.runPlanningLoop(profile, goal, {
        getCurrentVersions: () => ({ snapshotVersion: 'snap_999', goalVersion: 'v1' }),
      })
    ).rejects.toThrow(/VersionConflict \(R14\)/);

    await app.close();
  });
});
