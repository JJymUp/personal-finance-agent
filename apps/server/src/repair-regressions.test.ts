import { describe, expect, it, vi } from 'vitest';
import { AgentSession, MAX_MODEL_REQUESTS } from './agent/session.js';
import { OpenAIModelProvider } from './providers/openai.js';
import type { ModelProvider } from './providers/types.js';
import { deriveSafeProfileSummary, deriveSafeGoalSummary } from '../../web/src/local/privacy/summary.js';
import { generateCandidateScenarios, evaluateScenarioLocal } from '../../web/src/local/finance/calculator.js';
import { createHttpTransport } from '../../web/src/agent-client/http-transport.js';
import { MemoryCheckpointStore } from '../../web/src/agent-client/client.js';
import type { RunRequest } from '@maggot/contracts';
import { buildApp } from './app.js';
import { SessionStore } from './agent/store.js';
import { MockModelProvider } from './providers/mock.js';
import { PrivacyGateway } from '../../web/src/local/privacy/gateway.js';
import { ClientAgentCoordinator, type ClientTransport } from '../../web/src/agent-client/client.js';
import { ClientVault, MemoryStorage, VAULT_GOALS_KEY, VAULT_REPORTS_KEY } from '../../web/src/local/vault/vault.js';
import type { UserProfile } from '../../web/src/features/profile/types.js';
import type { LargePurchaseGoal } from '../../web/src/local/finance/calculator.js';

const profile: UserProfile = {
  currency: 'CNY', availableDeposit: 3_000_000,
  monthlyIncome: { status: 'fixed', amount: 1_000_000, payDay: 28 },
  essentialExpenses: { amount: 400_000, scope: 'individual', paymentDay: 2 },
  debtStatus: 'none', debts: [],
  metadata: { version: 1, dataDate: '2026-11-01', updatedAt: '2026-11-01T00:00:00Z', completeness: 'task_ready' },
};
const goal: LargePurchaseGoal = {
  id: 'repair_goal', name: 'Synthetic purchase', currency: 'CNY', taskType: 'large_purchase',
  targetAmount: 100_000, targetHorizonMonths: 1, cashReserveFloor: 100_000,
  timingFlexibility: 'fixed', version: 'v1',
};
function authorizedGateway() {
  const gateway = new PrivacyGateway();
  gateway.authorize({ purpose: 'financial_planning', provider: 'mock_provider',
    allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification', 'follow_up'],
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return gateway;
}

function request(): RunRequest {
  return { protocolVersion: '1.0', snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0',
    candidateScenarios: generateCandidateScenarios(goal), safeProfileSummary: deriveSafeProfileSummary(profile),
    safeGoalSummary: deriveSafeGoalSummary(profile, goal) };
}

function createHarness(provider: ModelProvider = new MockModelProvider()) {
  const store = new SessionStore();
  const app = buildApp({ store, provider, staticDistDir: false });
  const tokens = new Map<string, string>();
  const cursors = new Map<string, number>();
  const transport: ClientTransport = {
    async createRun(request) {
      const parentToken = request.parentRunId ? tokens.get(request.parentRunId) : undefined;
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: request,
        headers: parentToken ? { 'x-parent-session-token': parentToken } : {} });
      expect(res.statusCode).toBe(201);
      const data = res.json(); tokens.set(data.runId, data.sessionToken); return data;
    },
    async submitToolResult(id, result) {
      const res = await app.inject({ method: 'POST', url: `/api/runs/${id}/tool-results`, payload: JSON.stringify(result),
        headers: { 'content-type': 'application/json', 'x-session-token': tokens.get(id) ?? '' } });
      expect(res.statusCode).toBe(200); return res.json();
    },
    async cancelRun(id, reason) {
      return (await app.inject({ method: 'POST', url: `/api/runs/${id}/cancel`, payload: { reason },
        headers: { 'x-session-token': tokens.get(id) ?? '' } })).json();
    },
    registerRunSession(id, token, cursor = 0) { tokens.set(id, token); cursors.set(id, cursor); },
    async getCheckpoint(id) { return store.getSession(id)?.getCheckpoint() ?? null; },
    async fetchEvents(id) {
      const events = (store.getSession(id)?.getEventHistory() ?? []).filter(e => e.sequenceNumber > (cursors.get(id) ?? 0));
      if (!events.length) throw new Error('No replayable event while server awaits a tool');
      return events;
    },
  };
  return { store, app, transport, tokens };
}

describe('Repair acceptance regressions', () => {
  it('FIX-01 restores a backup containing a report produced by the actual Agent loop', async () => {
    const { app, transport } = createHarness();
    try {
      const report = await new ClientAgentCoordinator(authorizedGateway(), transport).runPlanningLoop(profile, goal);
      const source = new ClientVault(new MemoryStorage());
      await source.unlock('synthetic-backup-password');
      await source.saveProfile(profile);
      await source.saveSecretJson(VAULT_GOALS_KEY, goal);
      await source.saveSecretJson(VAULT_REPORTS_KEY, [{ ...report, hasUncertainPriorSpend: true }]);
      const backup = await source.exportBackup();
      const restored = new ClientVault(new MemoryStorage());
      await restored.importBackup(backup, 'synthetic-backup-password');
      expect(await restored.loadSecretJson(VAULT_REPORTS_KEY)).toEqual([{ ...report, hasUncertainPriorSpend: true }]);
      expect(await restored.loadProfile()).toEqual(profile);
    } finally { await app.close(); }
  });
  it('FIX-03 resumes a tool whose event was checkpointed before result submission', async () => {
    const h = createHarness();
    try {
      const session = h.store.createSession(request(), new MockModelProvider());
      await session.start();
      const tool = session.getPendingToolRequest();
      if (!tool) throw new Error('Expected a browser tool');
      const calc = evaluateScenarioLocal(profile, goal, generateCandidateScenarios(goal)[0], tool.callId);
      const report = await new ClientAgentCoordinator(authorizedGateway(), h.transport).resumeFromCheckpoint(profile, goal, {
        runId: session.runId, goalId: goal.id, snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0',
        lastSequenceNumber: session.getEventHistory().length, status: 'waiting_for_browser_tool',
        updatedAt: new Date().toISOString(), sessionToken: h.store.getSessionToken(session.runId),
        localEvaluations: { [calc.scenarioId]: calc },
      }, { checkpointStore: new MemoryCheckpointStore() });
      expect(report.runId).toBe(session.runId);
      expect(report.isVerified).toBe(true);
      expect(session.getUsage().toolCallCount).toBe(1);
    } finally { await h.app.close(); }
  });

  it('FIX-04 reserves request budget before provider retries rather than after them', async () => {
    let calls = 0;
    const provider = new OpenAIModelProvider({ apiKey: 'synthetic-only', model: 'synthetic', maxRetries: 2,
      fetchImpl: async () => { calls++; return new Response('synthetic retry', { status: 429 }); } });
    const session = new AgentSession(request(), provider, { stepCount: 1, toolCallCount: 0, modelRequestCount: MAX_MODEL_REQUESTS - 1 });
    await session.start();
    expect(calls).toBe(1);
    expect(session.getUsage().modelRequestCount).toBe(MAX_MODEL_REQUESTS);
    expect(session.getStatus()).toBe('failed');
  });

  it('FIX-05 cancels the server when a browser event fetch is aborted', async () => {
    const h = createHarness();
    const controller = new AbortController();
    let runId = '';
    const transport: ClientTransport = { ...h.transport,
      fetchEvents: async (_id, options) => new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('synthetic aborted fetch')), { once: true });
        queueMicrotask(() => controller.abort());
      }),
    };
    try {
      await expect(new ClientAgentCoordinator(authorizedGateway(), transport).runPlanningLoop(profile, goal, {
        signal: controller.signal, onRunCreated: id => { runId = id; },
      })).rejects.toThrow();
      expect(h.store.getSession(runId)?.getStatus()).toBe('cancelled');
    } finally { await h.app.close(); }
  });

  it('FIX-05 settles a pending user clarification on abort and cancels the server', async () => {
    const h = createHarness(new MockModelProvider({ behavior: 'request_clarification_first' }));
    const controller = new AbortController();
    let runId = '';
    try {
      const run = new ClientAgentCoordinator(authorizedGateway(), h.transport).runPlanningLoop(profile, goal, {
        signal: controller.signal, onRunCreated: id => { runId = id; },
        clarificationHandler: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); },
      });
      const outcome = await Promise.race([run.then(() => 'resolved', () => 'rejected'), new Promise(r => setTimeout(() => r('hung'), 100))]);
      expect(outcome).toBe('rejected');
      expect(h.store.getSession(runId)?.getStatus()).toBe('cancelled');
    } finally { await h.app.close(); }
  });

  it('final review: follow-ups cannot consume model time after the active execution budget is exhausted', async () => {
    const base = new MockModelProvider();
    let time = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    const provider: ModelProvider = { name: base.name,
      async generateStep(input) { const result = await base.generateStep(input); time += 10; return result; },
      answerFollowUp: input => base.answerFollowUp(input),
    };
    try {
      const session = new AgentSession(request(), provider, undefined, 20);
      await session.start();
      const pending = session.getPendingToolRequest();
      if (!pending) throw new Error('Missing tool');
      await session.submitToolResult({ callId: pending.callId, toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? '', status: 'satisfied', isReliable: true,
        evidenceId: 'synthetic_evidence', versionBinding: pending.versionBinding });
      expect(session.getStatus()).toBe('completed');
      expect(session.getUsage().activeElapsedMs).toBe(20);
      await expect(session.answerFollowUp({ intent: 'explain_verdict_and_risk' })).rejects.toThrow(/budget|TIMEOUT/i);
      expect(session.getUsage().modelRequestCount).toBe(2);
    } finally { clock.mockRestore(); }
  });

  it('final review: recovers an unsaved completed report even after later follow-up events', async () => {
    const h = createHarness(); const checkpoints = new MemoryCheckpointStore();
    const controller = new AbortController();
    try {
      const report = await new ClientAgentCoordinator(authorizedGateway(), h.transport)
        .runPlanningLoop(profile, goal, { checkpointStore: checkpoints });
      const session = h.store.getSession(report.runId);
      if (!session) throw new Error('Missing completed session');
      await session.answerFollowUp({ intent: 'explain_verdict_and_risk' });
      const cp = checkpoints.load(goal.id);
      if (!cp) throw new Error('Missing checkpoint');
      const resumed = new ClientAgentCoordinator(authorizedGateway(), h.transport)
        .resumeFromCheckpoint(profile, goal, cp, { signal: controller.signal });
      const outcome = await Promise.race([resumed.then(() => 'completed', () => 'failed'),
        new Promise(resolve => setTimeout(() => resolve('hung'), 200))]);
      expect(outcome).toBe('completed');
      expect(session.getUsage().modelRequestCount).toBe(3);
    } finally { controller.abort(); await h.app.close(); }
  });

  it('final review: HTTP transport can rewind its SSE cursor to zero for completed replay', async () => {
    let sentCursor: string | null = null;
    const transport = createHttpTransport('http://synthetic.invalid', { fetchImpl: async (_url, init) => {
      sentCursor = new Headers(init?.headers).get('Last-Event-ID');
      return new Response(`id: 6\ndata: ${JSON.stringify({ runId: 'run_replay', sequenceNumber: 6,
        timestamp: 1, type: 'completed', payload: {} })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    transport.registerRunSession('run_replay', 'synthetic-token', 6);
    transport.registerRunSession('run_replay', 'synthetic-token', 0);
    const events = await transport.fetchEvents('run_replay');
    expect(sentCursor).toBeNull();
    expect(events.map(event => event.type)).toEqual(['completed']);
  });

});
