import { describe, it, expect } from 'vitest';
import { OpenAIModelProvider } from './openai.js';
import { getSafeEnvSummary, type ServerEnvConfig } from '../config/env.js';
import type { ModelStepInput } from './types.js';

function makeBaseInput(): ModelStepInput {
  return {
    runId: 'run_test_1',
    stepNumber: 1,
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
    candidateScenarios: [
      {
        scenarioId: 'car_orig',
        scenarioKind: 'original_plan',
        adjustmentTier: 'none',
        assumptionCategory: 'baseline',
        assumptionVersion: 'v1',
      },
      {
        scenarioId: 'car_reduced',
        scenarioKind: 'reduced_budget',
        adjustmentTier: 'minor_10_pct',
        assumptionCategory: 'cost_reduction',
        assumptionVersion: 'v1',
      },
    ],
    toolHistory: [],
  };
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenAIModelProvider (offline fetch-mocked)', () => {
  const secretKey = 'sk-test-SECRET_KEY_VALUE_12345';

  it('maps valid evaluate_scenario tool call cleanly', async () => {
    const provider = new OpenAIModelProvider({
      apiKey: secretKey,
      model: 'gpt-test',
      baseUrl: 'https://mock.openai.local/v1',
      maxRetries: 0,
      fetchImpl: async () =>
        mockJsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'evaluate_scenario',
                      arguments: JSON.stringify({
                        scenarioId: 'car_orig',
                        reasoning: 'Check baseline scenario first',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
    });

    const out = await provider.generateStep(makeBaseInput());
    expect(out.type).toBe('request_tool');
    if (out.type === 'request_tool') {
      expect(out.toolRequest.toolName).toBe('evaluate_scenario');
      expect(out.toolRequest.params.scenarioId).toBe('car_orig');
    }
  });

  it('rejects unknown scenarioId from model (H-07)', async () => {
    const provider = new OpenAIModelProvider({
      apiKey: secretKey,
      model: 'gpt-test',
      maxRetries: 0,
      fetchImpl: async () =>
        mockJsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'evaluate_scenario',
                      arguments: JSON.stringify({
                        scenarioId: 'invented_scenario',
                        reasoning: 'Hallucinated',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
    });

    const out = await provider.generateStep(makeBaseInput());
    expect(out.type).toBe('error');
    if (out.type === 'error') {
      expect(out.code).toBe('UNKNOWN_SCENARIO_ID');
    }
  });

  it('rejects complete_analysis citing fabricated evidenceId (A-03)', async () => {
    const input = makeBaseInput();
    input.toolHistory.push({
      request: {
        runId: 'run_test_1',
        callId: 'call_1',
        toolName: 'evaluate_scenario',
        params: { scenarioId: 'car_orig' },
        versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
      },
      result: {
        callId: 'call_1',
        toolName: 'evaluate_scenario',
        scenarioId: 'car_orig',
        status: 'satisfied',
        gapHorizon: 'none',
        isReliable: true,
        evidenceId: 'ev_car_orig_pass_call_1',
        versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
      },
    });

    const provider = new OpenAIModelProvider({
      apiKey: secretKey,
      model: 'gpt-test',
      maxRetries: 0,
      fetchImpl: async () =>
        mockJsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: 'complete_analysis',
                      arguments: JSON.stringify({
                        selectedScenarioId: 'car_orig',
                        evidenceId: 'ev_FAKE_HALLUCINATED',
                        verdict: 'viable',
                        tradeOffSummary: 'Preserves buffer.',
                        assumptionsUsed: ['Fixed savings rate'],
                        recommendationTier: 'recommended',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
    });

    const out = await provider.generateStep(input);
    expect(out.type).toBe('error');
    if (out.type === 'error') {
      expect(out.code).toBe('UNVERIFIED_EVIDENCE_REFERENCE');
    }
  });

  it('retries transient HTTP 429 and redacts API key on error output', async () => {
    let calls = 0;
    const provider = new OpenAIModelProvider({
      apiKey: secretKey,
      model: 'gpt-test',
      maxRetries: 1,
      fetchImpl: async () => {
        calls++;
        return new Response(`Rate limit exceeded for key ${secretKey}`, { status: 429 });
      },
    });

    const out = await provider.generateStep(makeBaseInput());
    expect(calls).toBe(2);
    expect(out.type).toBe('error');
    if (out.type === 'error') {
      expect(out.message).not.toContain(secretKey);
      expect(out.message).toContain('[REDACTED]');
    }
  });

  it('getSafeEnvSummary never leaks API key', () => {
    const cfg: ServerEnvConfig = {
      port: 3000,
      host: '127.0.0.1',
      providerMode: 'openai',
      openaiApiKey: secretKey,
      openaiModel: 'gpt-test',
      openaiBaseUrl: 'https://example.test/v1',
      openaiTimeoutMs: 30000,
      openaiMaxRetries: 2,
    };

    const summary = getSafeEnvSummary(cfg);
    expect(summary).toEqual({
      providerMode: 'openai',
      model: 'gpt-test',
      baseUrlHost: 'example.test',
      hasApiKey: true,
    });
    expect(JSON.stringify(summary)).not.toContain(secretKey);
  });

  it('RM-01: retries and self-corrects when tool call arguments fail schema validation', async () => {
    let callIndex = 0;
    const recordedBodies: any[] = [];
    const longAssumption = 'A'.repeat(140); // 140 chars > 120 chars limit!

    const provider = new OpenAIModelProvider({
      apiKey: secretKey,
      model: 'gpt-test',
      maxRetries: 2,
      fetchImpl: async (_url, init) => {
        recordedBodies.push(JSON.parse(init?.body as string));
        callIndex++;
        if (callIndex === 1) {
          // Turn 1: model returns assumption exceeding 120 characters
          return mockJsonResponse({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call_turn1',
                      function: {
                        name: 'complete_analysis',
                        arguments: JSON.stringify({
                          selectedScenarioId: 'car_orig',
                          evidenceId: 'ev_car_orig_pass_call_1',
                          verdict: 'viable',
                          tradeOffSummary: '可行方案',
                          assumptionsUsed: [longAssumption],
                          recommendationTier: 'recommended',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          });
        }
        // Turn 2: model corrects to concise assumption <= 120 chars
        return mockJsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call_turn2',
                    function: {
                      name: 'complete_analysis',
                      arguments: JSON.stringify({
                        selectedScenarioId: 'car_orig',
                        evidenceId: 'ev_car_orig_pass_call_1',
                        verdict: 'viable',
                        tradeOffSummary: '可行方案',
                        assumptionsUsed: ['修正后的假设，符合长度要求'],
                        recommendationTier: 'recommended',
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 40 },
        });
      },
    });

    const input = makeBaseInput();
    input.toolHistory.push({
      request: {
        runId: 'run_test_1',
        callId: 'call_1',
        toolName: 'evaluate_scenario',
        params: { scenarioId: 'car_orig' },
        versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
      },
      result: {
        callId: 'call_1',
        toolName: 'evaluate_scenario',
        scenarioId: 'car_orig',
        status: 'satisfied',
        gapHorizon: 'none',
        isReliable: true,
        evidenceId: 'ev_car_orig_pass_call_1',
        versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
      },
    });

    const out = await provider.generateStep(input);
    expect(callIndex).toBe(2);
    expect(out.type).toBe('complete');
    if (out.type === 'complete') {
      expect(out.analysis.verdict).toBe('viable');
      expect(out.analysis.assumptionsUsed).toEqual(['修正后的假设，符合长度要求']);
      expect(out.usage?.promptTokens).toBe(250);
      expect(out.usage?.completionTokens).toBe(90);
    }

    // Verify feedback message was passed to turn 2
    expect(recordedBodies.length).toBe(2);
    const turn2Messages = recordedBodies[1].messages;
    expect(turn2Messages.some((m: any) => m.role === 'tool' && m.content.includes('Parameter validation error'))).toBe(true);
  });

  it('RM-05: provides evaluated and unevaluated scenarios in follow-up context', async () => {
    let capturedContext: any = null;
    const provider = new OpenAIModelProvider({
      apiKey: secretKey,
      model: 'gpt-test',
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        const userMsg = body.messages.find((m: any) => m.role === 'user');
        capturedContext = JSON.parse(userMsg.content.replace(/^Controlled post-report context JSON:\n/, ''));
        return mockJsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call_f1',
                    function: {
                      name: 'reply_followup',
                      arguments: JSON.stringify({
                        answer: '解释结论',
                        citedEvidenceId: 'ev_123',
                        limitationsNoted: ['仅针对已核算方案'],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      },
    });

    const out = await provider.answerFollowUp({
      runId: 'run_1',
      intent: 'explain_verdict_and_risk',
      safeProfileSummary: makeBaseInput().safeProfileSummary,
      safeGoalSummary: makeBaseInput().safeGoalSummary,
      candidateScenarios: makeBaseInput().candidateScenarios,
      analysis: {
        runId: 'run_1',
        selectedScenarioId: 'car_orig',
        evidenceId: 'ev_123',
        verdict: 'viable',
        tradeOffSummary: '测试',
        assumptionsUsed: ['假设1'],
        recommendationTier: 'recommended',
      },
      toolHistory: [
        {
          request: {
            runId: 'run_1',
            callId: 'c1',
            toolName: 'evaluate_scenario',
            params: { scenarioId: 'car_orig' },
            versionBinding: { snapshotVersion: 's1', goalVersion: 'g1', policyVersion: 'p1' },
          },
          result: {
            callId: 'c1',
            toolName: 'evaluate_scenario',
            scenarioId: 'car_orig',
            status: 'satisfied',
            gapHorizon: 'none',
            isReliable: true,
            evidenceId: 'ev_123',
            versionBinding: { snapshotVersion: 's1', goalVersion: 'g1', policyVersion: 'p1' },
          },
        },
      ],
      priorFollowUps: [],
    });

    expect(out.type).toBe('ok');
    expect(capturedContext).toBeDefined();
    expect(capturedContext.evaluatedScenarios.map((s: any) => s.scenarioId)).toEqual(['car_orig']);
    expect(capturedContext.unevaluatedScenarios.map((s: any) => s.scenarioId)).toEqual(['car_reduced']);
  });
});
