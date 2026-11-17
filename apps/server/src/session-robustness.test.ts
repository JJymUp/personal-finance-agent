import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { MockModelProvider } from './providers/mock.js';
import { SessionStore } from './agent/store.js';
import { AgentSession, MAX_TOOL_CALLS, MAX_STEPS } from './agent/session.js';
import { RateLimiter } from './security/rate-limiter.js';
import { DisclosureGuard } from './security/disclosure-guard.js';
import type { RunRequest, AgentEvent } from '@maggot/contracts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minimalRunRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
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
      {
        scenarioId: 'sc_alt',
        scenarioKind: 'reduced_budget',
        adjustmentTier: 'minor_10_pct',
        assumptionCategory: 'cost_reduction',
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
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Agent Session Robustness: Interrupted, Quota, Idempotent (O-04, H-06)', () => {
  let app: FastifyInstance;
  let store: SessionStore;

  beforeEach(async () => {
    store = new SessionStore();
    app = buildApp({ provider: new MockModelProvider({ behavior: 'standard' }), store, skipTokenValidation: true });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('O-04: interrupt() marks session as interrupted, further tool results rejected', async () => {
    // Create run via API
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: minimalRunRequest(),
    });
    expect(createRes.statusCode).toBe(201);
    const { runId } = JSON.parse(createRes.body);

    // Session should be waiting for browser tool
    const session = store.getSession(runId)!;
    expect(session.getStatus()).toBe('waiting_for_browser_tool');

    // Simulate server-side interrupt (e.g. server restart detected on reconnect)
    session.interrupt('server_restart_detected');
    expect(session.getStatus()).toBe('interrupted');

    // Verify interrupted event is in history
    const events = session.getEventHistory();
    const interruptedEvt = events.find((e) => e.type === 'interrupted');
    expect(interruptedEvt).toBeDefined();
    expect(interruptedEvt!.payload.reason).toBe('server_restart_detected');

    // Attempt to submit tool result to interrupted session => should fail
    const pendingInterrupted = session.getPendingToolRequest();
    const toolRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tool-results`,
      payload: {
        callId: pendingInterrupted?.callId ?? 'call_stale',
        toolName: 'evaluate_scenario',
        scenarioId: pendingInterrupted?.params.scenarioId ?? 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_stale_123',
        versionBinding: pendingInterrupted?.versionBinding ?? {
          snapshotVersion: 'snap_1',
          goalVersion: 'v1',
          policyVersion: 'p_1.0',
        },
      },
    });
    expect(toolRes.statusCode).toBe(400);
    expect(JSON.parse(toolRes.body).message).toMatch(/not waiting for a tool/i);
  });

  it('O-04: Tool quota exhaustion stops the run with TOOL_QUOTA_EXHAUSTED', async () => {
    // Create a "loop" provider that keeps requesting tools forever
    class InfiniteLoopProvider extends MockModelProvider {
      private count = 0;
      async generateStep(input: import('./providers/types.js').ModelStepInput) {
        // Always request the same scenario — simulates a runaway loop
        return {
          type: 'request_tool' as const,
          toolRequest: {
            toolName: 'evaluate_scenario' as const,
            params: { scenarioId: input.candidateScenarios[0].scenarioId },
          },
          reasoning: `Step ${++this.count}: still evaluating`,
        };
      }
    }

    const loopStore = new SessionStore();
    const loopApp = buildApp({ provider: new InfiniteLoopProvider(), store: loopStore, skipTokenValidation: true });
    await loopApp.ready();

    const createRes = await loopApp.inject({
      method: 'POST',
      url: '/api/runs',
      payload: minimalRunRequest(),
    });
    expect(createRes.statusCode).toBe(201);
    const { runId } = JSON.parse(createRes.body);

    const session = loopStore.getSession(runId)!;

    // Keep feeding satisfied results to drain the quota
    for (let i = 0; i <= MAX_TOOL_CALLS + 1; i++) {
      const pending = session.getPendingToolRequest();
      if (!pending) break;
      await session.submitToolResult({
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: `ev_loop_${i}`,
        versionBinding: pending.versionBinding,
      });
    }

    expect(session.getStatus()).toBe('failed');
    const failEvent = session.getEventHistory().find((e) => e.type === 'failed')!;
    expect(failEvent.payload.errorCode).toBe('TOOL_QUOTA_EXHAUSTED');

    await loopApp.close();
  });

  it('H-06: Idempotent tool result submission does not advance session twice, and conflicting resubmission fails (R04)', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: minimalRunRequest(),
    });
    const { runId } = JSON.parse(createRes.body);
    const session = store.getSession(runId)!;

    expect(session.getStatus()).toBe('waiting_for_browser_tool');
    const pending = session.getPendingToolRequest()!;
    expect(pending).toBeDefined();

    // Wrong scenarioId / wrong versionBinding rejected cleanly (R04)
    await expect(
      session.submitToolResult({
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: 'wrong_sc',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_bad_1',
        versionBinding: pending.versionBinding,
      })
    ).rejects.toThrow(/Scenario ID mismatch/i);

    await expect(
      session.submitToolResult({
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_bad_2',
        versionBinding: { ...pending.versionBinding, goalVersion: 'v_wrong' },
      })
    ).rejects.toThrow(/Version binding mismatch/i);

    // Submit valid result once
    await session.submitToolResult({
      callId: pending.callId,
      toolName: 'evaluate_scenario',
      scenarioId: pending.params.scenarioId ?? 'sc_orig',
      status: 'satisfied',
      isReliable: true,
      evidenceId: `ev_ok_1`,
      versionBinding: pending.versionBinding,
    });

    // Session advances (completed or waiting for next tool)
    const statusAfterFirst = session.getStatus();
    expect(['completed', 'waiting_for_browser_tool']).toContain(statusAfterFirst);
    const eventsAfterFirst = session.getEventHistory().length;

    // Re-submit the SAME callId with identical result (idempotent) — must NOT advance
    await session.submitToolResult({
      callId: pending.callId,
      toolName: 'evaluate_scenario',
      scenarioId: pending.params.scenarioId ?? 'sc_orig',
      status: 'satisfied',
      isReliable: true,
      evidenceId: `ev_ok_1`,
      versionBinding: pending.versionBinding,
    });

    // Re-submit SAME callId with CONFLICTING result — must throw! (R04)
    await expect(
      session.submitToolResult({
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? 'sc_orig',
        status: 'violated',
        isReliable: true,
        evidenceId: `ev_conflict`,
        versionBinding: pending.versionBinding,
      })
    ).rejects.toThrow(/Conflicting duplicate/i);

    // Status must not change, event count must not grow
    expect(session.getStatus()).toBe(statusAfterFirst);
    expect(session.getEventHistory().length).toBe(eventsAfterFirst);
  });

  it('H-05 / R05: Cancel stops slow in-flight provider cleanly without resurrecting into tool_requested', async () => {
    let signalAborted = false;
    const slowProvider = {
      name: 'slow-mock',
      async generateStep(input: import('./providers/types.js').ModelStepInput) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        signalAborted = Boolean(input.signal?.aborted);
        return {
          type: 'request_tool' as const,
          toolRequest: {
            toolName: 'evaluate_scenario' as const,
            params: { scenarioId: input.candidateScenarios[0].scenarioId },
          },
          reasoning: 'late response after cancel',
        };
      },
    };
    const cancelSession = new AgentSession(minimalRunRequest(), slowProvider);
    const startPromise = cancelSession.start();
    cancelSession.cancel('user_cancelled_mid_flight');
    await startPromise;

    expect(signalAborted).toBe(true);
    expect(cancelSession.getStatus()).toBe('cancelled');
    expect(cancelSession.getEventHistory().some((e) => e.type === 'tool_requested')).toBe(false);
  });

  it('H-05: Stale tool callId from old run is rejected after cancel', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: minimalRunRequest(),
    });
    const { runId } = JSON.parse(createRes.body);
    const session = store.getSession(runId)!;
    const staleCallId = session.getPendingToolRequest()?.callId ?? 'call_stale';

    // Cancel the run
    await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, payload: { reason: 'user_abandoned' } });

    // Try to submit a stale tool result from before cancel
    const submitRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tool-results`,
      payload: {
        callId: staleCallId,
        toolName: 'evaluate_scenario',
        scenarioId: 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_stale',
        versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
      },
    });
    expect(submitRes.statusCode).toBe(400);
    expect(JSON.parse(submitRes.body).message).toContain('cancelled');
  });

  it('H-04: Server-side RunRequest validation rejects unknown fields (P-02)', async () => {
    const rogue = {
      ...minimalRunRequest(),
      sensitiveRawField: 'MY_BANK_ACCOUNT_NO_1234', // forbidden extra field
    };
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: rogue });
    // Zod strict schema must reject unknown fields
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('INVALID_RUN_REQUEST');
  });

  it('H-04: Server-side RunRequest validation rejects sensitive keyword in payload (P-01)', async () => {
    const req = minimalRunRequest();
    // Inject a sensitive keyword into a string field
    req.snapshotVersion = 'snap_SENSITIVE_DO_NOT_UPLOAD';
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: req });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('SECURITY_VIOLATION');
  });
});

// ─── New Security Tests ───────────────────────────────────────────────────────

describe('Security: Session Token, Rate Limiter, TTL Cleanup, ClarificationCallId', () => {
  it('SEC-01: Session token is returned on run creation; correct token allows tool submission', async () => {
    const store = new SessionStore();
    const app = buildApp({ provider: new MockModelProvider({ behavior: 'standard' }), store });
    await app.ready();

    const createRes = await app.inject({ method: 'POST', url: '/api/runs', payload: minimalRunRequest() });
    expect(createRes.statusCode).toBe(201);
    const { runId, sessionToken } = JSON.parse(createRes.body);
    expect(typeof sessionToken).toBe('string');
    expect(sessionToken).toHaveLength(64); // 32 bytes hex

    const session = store.getSession(runId)!;
    const pending = session.getPendingToolRequest()!;

    const goodRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tool-results`,
      headers: { 'x-session-token': sessionToken },
      payload: {
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_sec01',
        versionBinding: pending.versionBinding,
      },
    });
    expect(goodRes.statusCode).toBe(200);

    await app.close();
  });

  it('SEC-02: Tool result submission with wrong token is rejected 403', async () => {
    const store = new SessionStore();
    const app = buildApp({ provider: new MockModelProvider({ behavior: 'standard' }), store });
    await app.ready();

    const createRes = await app.inject({ method: 'POST', url: '/api/runs', payload: minimalRunRequest() });
    const { runId } = JSON.parse(createRes.body);

    const session = store.getSession(runId)!;
    const pending = session.getPendingToolRequest()!;

    const badRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tool-results`,
      headers: { 'x-session-token': 'deadbeef'.repeat(8) }, // wrong 64-char token
      payload: {
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_sec02',
        versionBinding: pending.versionBinding,
      },
    });
    expect(badRes.statusCode).toBe(403);
    expect(JSON.parse(badRes.body).error).toBe('INVALID_SESSION_TOKEN');

    await app.close();
  });

  it('SEC-03: Rate limiter blocks excess run creations per minute', async () => {
    const { RateLimiter } = await import('./security/rate-limiter.js');
    const tightLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const store = new SessionStore();
    const app = buildApp({
      provider: new MockModelProvider({ behavior: 'standard' }),
      store,
      createRunRateLimiter: tightLimiter,
      skipTokenValidation: true,
    });
    await app.ready();

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/runs', payload: minimalRunRequest() });
      expect(res.statusCode).toBe(201);
    }

    const blockedRes = await app.inject({ method: 'POST', url: '/api/runs', payload: minimalRunRequest() });
    expect(blockedRes.statusCode).toBe(429);
    expect(JSON.parse(blockedRes.body).error).toBe('RATE_LIMIT_EXCEEDED');

    await app.close();
  });

  it('SEC-04: SessionStore.cleanup() leaves fresh sessions intact and generates unique server runId', async () => {
    const store = new SessionStore();
    const provider = new MockModelProvider({ behavior: 'standard' });
    const session = store.createSession(minimalRunRequest(), provider);
    // Fresh session should not be cleaned up
    const removed = store.cleanup();
    expect(removed).toBe(0);
    expect(session.runId).toMatch(/^run_/);
    expect(store.getSession(session.runId)).toBeDefined();
  });

  it('SEC-05: Missing parent, bad parent token, and invalid originalClarificationCallId are rejected (R02)', async () => {
    const store = new SessionStore();
    const provider = new MockModelProvider({ behavior: 'standard' });

    // Create a parent session (started so it enters waiting_for_browser_tool with no clarification calls)
    const parent = store.createSession(minimalRunRequest(), provider);
    await parent.start();
    const parentToken = store.getSessionToken(parent.runId)!;

    // Missing parentRunId -> PARENT_SESSION_NOT_FOUND
    expect(() => {
      store.createSession(
        minimalRunRequest({
          parentRunId: 'run_nonexistent_parent',
        }),
        provider,
        { parentSessionToken: parentToken }
      );
    }).toThrow(/Parent session .* does not exist/i);

    // Missing/wrong parentSessionToken -> Unauthorized
    expect(() => {
      store.createSession(
        minimalRunRequest({
          parentRunId: parent.runId,
        }),
        provider
      );
    }).toThrow(/Missing or invalid X-Parent-Session-Token/);

    // Valid parent token, but invalid originalClarificationCallId -> Invalid originalClarificationCallId
    expect(() => {
      store.createSession(
        minimalRunRequest({
          parentRunId: parent.runId,
          originalClarificationCallId: 'call_nonexistent',
        }),
        provider,
        { parentSessionToken: parentToken }
      );
    }).toThrow(/Invalid originalClarificationCallId/);
  });
});

describe('Security & Governance: TTL Expiry, Run Timeout, Token Tracking', () => {
  it('SEC-06: SessionStore.cleanup() interrupts and removes sessions inactive past 30m TTL', async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionStore();
      const provider = new MockModelProvider({ behavior: 'standard' });
      const session = store.createSession(minimalRunRequest(), provider);
      await session.start();
      expect(session.getStatus()).toBe('waiting_for_browser_tool');

      // Advance time past 30 minutes
      vi.advanceTimersByTime(31 * 60 * 1000);
      const removed = store.cleanup();

      expect(removed).toBe(1);
      expect(session.getStatus()).toBe('interrupted');
      expect(store.getSession(session.runId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('SEC-07: AgentSession enforces active execution budget timeout with TIMEOUT_EXCEEDED', async () => {
    vi.useFakeTimers();
    try {
      const slowComputeProvider = {
        name: 'slow-compute',
        async generateStep(input: import('./providers/types.js').ModelStepInput) {
          vi.advanceTimersByTime(1500);
          return {
            type: 'request_tool' as const,
            toolRequest: {
              toolName: 'evaluate_scenario' as const,
              params: { scenarioId: input.candidateScenarios[0].scenarioId },
            },
            reasoning: 'slow active compute',
          };
        },
      };
      const session = new AgentSession(
        minimalRunRequest(),
        slowComputeProvider,
        undefined,
        1000 // 1 second max active duration
      );

      await session.start();

      expect(session.getStatus()).toBe('failed');
      const failEvt = session.getEventHistory().find((e) => e.type === 'failed');
      expect(failEvt?.payload.errorCode).toBe('TIMEOUT_EXCEEDED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('SEC-08: AgentSession accumulates token usage from model steps', async () => {
    const provider = {
      name: 'usage-mock',
      async generateStep(input: import('./providers/types.js').ModelStepInput) {
        if (input.toolHistory.length === 0) {
          return {
            type: 'request_tool' as const,
            toolRequest: {
              toolName: 'evaluate_scenario' as const,
              params: { scenarioId: input.candidateScenarios[0].scenarioId },
            },
            reasoning: 'step 1',
            usage: { promptTokens: 120, completionTokens: 30 },
          };
        }
        return {
          type: 'complete' as const,
          analysis: {
            runId: input.runId,
            selectedScenarioId: input.candidateScenarios[0].scenarioId,
            evidenceId: input.toolHistory[0].result!.evidenceId,
            verdict: 'viable' as const,
            tradeOffSummary: 'ok',
            assumptionsUsed: ['baseline'],
            recommendationTier: 'recommended' as const,
          },
          usage: { promptTokens: 200, completionTokens: 50 },
        };
      },
    };

    const session = new AgentSession(minimalRunRequest(), provider);
    await session.start();
    const pending = session.getPendingToolRequest()!;
    await session.submitToolResult({
      callId: pending.callId,
      toolName: 'evaluate_scenario',
      scenarioId: pending.params.scenarioId ?? 'sc_orig',
      status: 'satisfied',
      isReliable: true,
      evidenceId: 'ev_usage_1',
      versionBinding: pending.versionBinding,
    });

    expect(session.getStatus()).toBe('completed');
    const tokenUsage = session.getTokenUsage();
    expect(tokenUsage.promptTokens).toBe(320);
    expect(tokenUsage.completionTokens).toBe(80);
    expect(tokenUsage.totalTokens).toBe(400);
    expect(session.getCheckpoint().tokenUsage.totalTokens).toBe(400);
  });
});

describe('Privacy & Robustness: P-06 Disclosure Guard & P-08 Output Sanitization', () => {
  it('P-06: DisclosureGuard blocks rapid cross-session threshold probing including IP rotation of X-Client-Id (R02)', async () => {
    const { DisclosureGuard } = await import('./security/disclosure-guard.js');
    const guard = new DisclosureGuard({
      windowMs: 60_000,
      maxRunsPerWindow: 20,
      maxDistinctProbesPerWindow: 2,
    });
    const store = new SessionStore();
    const app = buildApp({
      provider: new MockModelProvider({ behavior: 'standard' }),
      store,
      disclosureGuard: guard,
      skipTokenValidation: true,
    });
    await app.ready();

    // Probe 1
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'x-client-id': 'prober_1' },
      payload: minimalRunRequest({ goalVersion: 'v1' }),
    });
    expect(r1.statusCode).toBe(201);

    // Probe 2 with rotated X-Client-Id from SAME IP
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'x-client-id': 'prober_2' },
      payload: minimalRunRequest({ goalVersion: 'v2' }),
    });
    expect(r2.statusCode).toBe(201);

    // Probe 3 with yet another X-Client-Id from SAME IP still hits IP budget -> 429
    const r3 = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { 'x-client-id': 'prober_3' },
      payload: minimalRunRequest({ goalVersion: 'v3' }),
    });
    expect(r3.statusCode).toBe(429);
    expect(JSON.parse(r3.body).error).toBe('DISCLOSURE_BUDGET_EXCEEDED');

    await app.close();
  });

  it('P-08: Server strips <script>, remote markdown images, and external URLs from model analysis', async () => {
    const store = new SessionStore();
    const provider = new MockModelProvider({ behavior: 'standard' });
    const app = buildApp({ provider, store, skipTokenValidation: true });
    await app.ready();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: minimalRunRequest(),
    });
    const { runId } = JSON.parse(createRes.body);
    const session = store.getSession(runId)!;
    const pending = session.getPendingToolRequest()!;

    // Switch mock to return dangerous markup on completion step
    provider.setBehavior('unsafe_markup_output');

    await session.submitToolResult({
      callId: pending.callId,
      toolName: 'evaluate_scenario',
      scenarioId: pending.params.scenarioId ?? 'sc_orig',
      status: 'satisfied',
      isReliable: true,
      evidenceId: 'ev_p08_1',
      versionBinding: pending.versionBinding,
    });

    expect(session.getStatus()).toBe('completed');
    const analysis = session.getCompletedAnalysis()!;
    expect(analysis.tradeOffSummary).not.toContain('<script>');
    expect(analysis.tradeOffSummary).not.toContain('https://evil.example');
    expect(analysis.tradeOffSummary).toContain('[image blocked: track]');
    expect(analysis.tradeOffSummary).toContain('[external link blocked]');

    await app.close();
  });

  it('RM-02: submitToolResult with { waitStep: false } returns promptly without blocking on step execution', async () => {
    const provider = new MockModelProvider();
    const store = new SessionStore();
    const app = buildApp({
      provider,
      store,
      createRunRateLimiter: new RateLimiter({ windowMs: 60000, maxRequests: 100 }),
      toolResultRateLimiter: new RateLimiter({ windowMs: 60000, maxRequests: 100 }),
      disclosureGuard: new DisclosureGuard(),
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: minimalRunRequest(),
    });
    const { runId } = JSON.parse(createRes.body);
    const session = store.getSession(runId)!;
    const pending = session.getPendingToolRequest()!;

    // Non-blocking submission
    await session.submitToolResult(
      {
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        evidenceId: 'ev_rm02_1',
        versionBinding: pending.versionBinding,
      },
      { waitStep: false }
    );

    // Waiting for active step completes cleanly
    await session.waitForActiveStep();
    expect(session.getStatus()).toBe('completed');

    await app.close();
  });

  it('RM-02: HTTP POST /api/runs/:runId/tool-results responds 200 OK promptly', async () => {
    const provider = new MockModelProvider();
    const store = new SessionStore();
    const app = buildApp({
      provider,
      store,
      createRunRateLimiter: new RateLimiter({ windowMs: 60000, maxRequests: 100 }),
      toolResultRateLimiter: new RateLimiter({ windowMs: 60000, maxRequests: 100 }),
      disclosureGuard: new DisclosureGuard(),
    });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: minimalRunRequest(),
    });
    const { runId, sessionToken } = JSON.parse(createRes.body);
    const session = store.getSession(runId)!;
    const pending = session.getPendingToolRequest()!;

    const postRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/tool-results`,
      headers: { 'x-session-token': sessionToken },
      payload: {
        callId: pending.callId,
        toolName: 'evaluate_scenario',
        scenarioId: pending.params.scenarioId ?? 'sc_orig',
        status: 'satisfied',
        isReliable: true,
        missingFieldCategory: 'income_variability_detail',
        evidenceId: 'ev_rm02_http',
        versionBinding: pending.versionBinding,
      },
    });

    expect(postRes.statusCode).toBe(200);
    const body = JSON.parse(postRes.body);
    expect(body.ok).toBe(true);
    expect(body.runId).toBe(runId);

    await session.waitForActiveStep();
    expect(session.getStatus()).toBe('completed');

    await app.close();
  });
});
