import { generateConversation } from './conversation.js';
import type { ConversationRequest, ConversationResponse } from '@maggot/contracts';
import { z } from 'zod';
import type {
  ModelProvider,
  ModelStepInput,
  ModelStepOutput,
  FollowUpInput,
  FollowUpOutput,
} from './types.js';
import {
  VerifiedAnalysisSchema,
  FollowUpResponseSchema,
  sanitizeUntrustedText,
} from '@maggot/contracts';

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

const EvaluateScenarioArgsSchema = z
  .object({
    scenarioId: z.string().min(1).max(64),
    reasoning: z.string().min(1).max(300),
  })
  .strict();

const RequestClarificationArgsSchema = z
  .object({
    fieldCategory: z.enum([
      'family_burden_confirmation',
      'timing_flexibility_confirmation',
      'expense_refinement',
      'income_variability_detail',
    ]),
    reasoning: z.string().min(1).max(300),
  })
  .strict();

const CompleteAnalysisArgsSchema = z
  .object({
    selectedScenarioId: z.string().min(1).max(64),
    evidenceId: z.string().min(1).max(128),
    verdict: z.enum(['viable', 'caution', 'not_viable']),
    tradeOffSummary: z.string().min(1).max(500),
    assumptionsUsed: z.array(z.string().min(1).max(120)).min(1).max(5),
    recommendationTier: z.enum(['recommended', 'alternative', 'rejected']),
  })
  .strict();

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'evaluate_scenario',
      description:
        'Request the browser to locally calculate a candidate financial scenario using exact user figures. Use an exact scenarioId from candidateScenarios.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['scenarioId', 'reasoning'],
        properties: {
          scenarioId: {
            type: 'string',
            description: 'Exact scenarioId from the candidateScenarios list.',
          },
          reasoning: {
            type: 'string',
            maxLength: 300,
            description: 'Concise qualitative reason for evaluating this scenario (Simplified Chinese, <= 300 characters).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description:
        'Ask the user locally in the browser to clarify missing qualitative preference or detail.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['fieldCategory', 'reasoning'],
        properties: {
          fieldCategory: {
            type: 'string',
            enum: [
              'family_burden_confirmation',
              'timing_flexibility_confirmation',
              'expense_refinement',
              'income_variability_detail',
            ],
          },
          reasoning: {
            type: 'string',
            maxLength: 300,
            description: 'Why clarification helps compare scenarios (Simplified Chinese, <= 300 characters).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_analysis',
      description:
        'Finish planning ONLY after evaluating at least one scenario via evaluate_scenario. Must reference a real evidenceId returned in toolHistory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [
          'selectedScenarioId',
          'evidenceId',
          'verdict',
          'tradeOffSummary',
          'assumptionsUsed',
          'recommendationTier',
        ],
        properties: {
          selectedScenarioId: { type: 'string' },
          evidenceId: {
            type: 'string',
            description: 'Exact evidenceId copied verbatim from an evaluate_scenario tool result.',
          },
          verdict: {
            type: 'string',
            enum: ['viable', 'caution', 'not_viable'],
          },
          tradeOffSummary: {
            type: 'string',
            maxLength: 500,
            description:
              'Qualitative trade-off explanation in Simplified Chinese (do NOT fabricate currency amounts or invent percentages; strictly <= 500 characters).',
          },
          assumptionsUsed: {
            type: 'array',
            items: {
              type: 'string',
              maxLength: 120,
              description: 'Concise bullet strictly <= 120 characters in Simplified Chinese.',
            },
            minItems: 1,
            maxItems: 5,
          },
          recommendationTier: {
            type: 'string',
            enum: ['recommended', 'alternative', 'rejected'],
          },
        },
      },
    },
  },
];

const SYSTEM_PROMPT = [
  'You are a strict privacy-preserving personal financial planning coordinator.',
  'You ONLY see bucketed profile/goal summaries and pre-approved candidateScenarios. You NEVER have exact user balances, incomes, or dates.',
  'IMPORTANT: All qualitative text (tradeOffSummary, reasoning, assumptionsUsed) MUST be written in Simplified Chinese (简体中文).',
  'When assessment_scope is monthly_budget, evaluate constant monthly income/expenses without asking for payday or debit dates. All conclusions concern monthly affordability estimates only, not daily liquidity; state this scope in the answer.',
  'Workflow rules:',
  '1. At each step, invoke EXACTLY ONE tool from: evaluate_scenario, request_clarification, complete_analysis.',
  '2. Usually start by calling evaluate_scenario on the baseline original_plan scenarioId.',
  '3. If evaluate_scenario returns missingFieldCategory (or isReliable=false with status=unknown), call request_clarification for that fieldCategory to reduce uncertainty, unless previously refused.',
  '4. If original_plan returns status="violated" and alternative scenarios (reduced_budget / delayed_timing) have not been evaluated yet, evaluate an alternative scenario before completing.',
  '5. If a previous request_clarification returned status="user_refused", NEVER re-ask it — respect the refusal, proceed with scenario evaluation, and record that limitation in assumptionsUsed.',
  '6. Call complete_analysis ONLY after at least one evaluate_scenario tool result exists in toolHistory.',
  '7. In complete_analysis:',
  '   - evidenceId MUST copy verbatim the exact evidenceId returned by evaluate_scenario for selectedScenarioId.',
  '   - NEVER invent currency amounts, balances, or fake numbers in tradeOffSummary, and never include HTML/scripts/remote URLs.',
  '   - If the selected scenario has status="violated", status="unknown", or isReliable=false, verdict MUST NOT be "viable" (use "caution" or "not_viable").',
  '   - Strict length constraints: tradeOffSummary must be <= 500 characters; each bullet in assumptionsUsed must be <= 120 characters (strictly 1 to 5 bullets).',
].join('\n');

const FOLLOWUP_TOOL = [
  {
    type: 'function',
    function: {
      name: 'reply_followup',
      description:
        'Provide a concise, privacy-preserving follow-up answer grounded strictly in verified analysis and evidenceId.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'citedEvidenceId', 'limitationsNoted'],
        properties: {
          answer: {
            type: 'string',
            maxLength: 1400,
            description:
              'Qualitative explanation in Simplified Chinese addressing the user question without fabricating currency numbers or remote URLs (strictly <= 1400 characters).',
          },
          citedEvidenceId: {
            type: 'string',
            description: 'Must copy the verified evidenceId from verifiedAnalysis.',
          },
          limitationsNoted: {
            type: 'array',
            items: {
              type: 'string',
              maxLength: 150,
              description: 'Concise limitation note strictly <= 150 characters in Simplified Chinese.',
            },
            minItems: 1,
            maxItems: 5,
          },
        },
      },
    },
  },
];

const FollowUpToolArgsSchema = z
  .object({
    answer: z.string().min(1).max(1400),
    citedEvidenceId: z.string().min(1).max(128),
    limitationsNoted: z.array(z.string().min(1).max(150)).min(1).max(5),
  })
  .strict();

function sanitizeSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]');
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export class OpenAIModelProvider implements ModelProvider {
  readonly name: string;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchImpl: typeof fetch;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) {
      throw new Error('OpenAIModelProvider requires a non-empty apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.name = `openai:${options.model}`;
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateConversation(input: ConversationRequest, signal?: AbortSignal): Promise<ConversationResponse> {
    return generateConversation({ apiKey:this.apiKey,model:this.model,baseUrl:this.baseUrl,timeoutMs:this.timeoutMs,fetchImpl:this.fetchImpl },input,signal);
  }

  async generateStep(input: ModelStepInput): Promise<ModelStepOutput> {
    const contextPayload = {
      stepNumber: input.stepNumber,
      safeProfileSummary: input.safeProfileSummary,
      safeGoalSummary: input.safeGoalSummary,
      candidateScenarios: input.candidateScenarios,
      toolHistory: input.toolHistory.map((item) => ({
        toolName: item.request.toolName,
        params: item.request.params,
        result: item.result ?? null,
      })),
    };

    const requestBody = {
      model: this.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Current safe planning state JSON:\n${JSON.stringify(contextPayload, null, 2)}`,
        },
      ],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'required',
    };

    let lastError = 'Unknown model provider failure';
    let attempts = 0;
    let accumulatedPromptTokens = 0;
    let accumulatedCompletionTokens = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (input.signal?.aborted) {
        return {
          type: 'error',
          code: 'RUN_ABORTED',
          message: 'Run aborted before model request',
          modelAttempts: attempts,
        };
      }
      if (attempt > 0 && input.reserveRetry && !input.reserveRetry()) {
        return { type: 'error', code: 'MODEL_BUDGET_EXHAUSTED', message: 'Model request budget exhausted before retry', modelAttempts: attempts };
      }
      attempts++;
      try {
        const timeoutSig = AbortSignal.timeout(this.timeoutMs);
        const signal = input.signal
          ? AbortSignal.any([input.signal, timeoutSig])
          : timeoutSig;

        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!res.ok) {
          const errText = sanitizeSecret(await res.text().catch(() => ''), this.apiKey).slice(0, 300);
          lastError = `HTTP ${res.status}: ${errText || res.statusText}`;
          if (!input.signal?.aborted && isRetryableStatus(res.status) && attempt < this.maxRetries) {
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          return {
            type: 'error',
            code: `MODEL_HTTP_${res.status}`,
            message: lastError,
            modelAttempts: attempts,
          };
        }

        const data = (await res.json()) as {
          choices?: Array<{
            message?: {
              tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
          };
        };

        if (
          data.usage &&
          typeof data.usage.prompt_tokens === 'number' &&
          typeof data.usage.completion_tokens === 'number'
        ) {
          accumulatedPromptTokens += data.usage.prompt_tokens;
          accumulatedCompletionTokens += data.usage.completion_tokens;
        }

        const toolCallObj = data.choices?.[0]?.message?.tool_calls?.[0];
        const toolCall = toolCallObj?.function;
        const toolCallId = toolCallObj?.id ?? 'call_0';
        if (!toolCall?.name || !toolCall.arguments) {
          return {
            type: 'error',
            code: 'INVALID_MODEL_OUTPUT',
            message: 'Model did not return a structured tool_call',
            modelAttempts: attempts,
          };
        }

        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(toolCall.arguments);
        } catch {
          if (attempt < this.maxRetries) {
            requestBody.messages.push({
              role: 'assistant',
              content: null as unknown as string,
              tool_calls: [
                {
                  id: toolCallId,
                  type: 'function',
                  function: { name: toolCall.name, arguments: toolCall.arguments },
                },
              ],
            } as any);
            requestBody.messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({
                status: 'error',
                code: 'INVALID_MODEL_JSON',
                message: 'Arguments were not valid JSON. Please return valid JSON matching tool parameters.',
              }),
            } as any);
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          return {
            type: 'error',
            code: 'INVALID_MODEL_JSON',
            message: 'Model tool arguments were not valid JSON',
            modelAttempts: attempts,
          };
        }

        const stepOut = this.validateAndMapToolCall(toolCall.name, parsedArgs, input);
        if (
          stepOut.type === 'error' &&
          (stepOut.code === 'INVALID_TOOL_ARGS' || stepOut.code === 'INVALID_ANALYSIS_SCHEMA')
        ) {
          if (attempt < this.maxRetries) {
            requestBody.messages.push({
              role: 'assistant',
              content: null as unknown as string,
              tool_calls: [
                {
                  id: toolCallId,
                  type: 'function',
                  function: { name: toolCall.name, arguments: toolCall.arguments },
                },
              ],
            } as any);
            requestBody.messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({
                status: 'error',
                code: stepOut.code,
                message: `Parameter validation error: ${stepOut.message}. Please strictly observe character length limits (each bullet in assumptionsUsed <= 120 chars, tradeOffSummary <= 500 chars, Simplified Chinese language) and schema requirements, then invoke the tool again.`,
              }),
            } as any);
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
        }

        const usage =
          accumulatedPromptTokens > 0 || accumulatedCompletionTokens > 0
            ? {
                promptTokens: accumulatedPromptTokens,
                completionTokens: accumulatedCompletionTokens,
              }
            : undefined;

        return {
          ...stepOut,
          ...(usage && (stepOut.type === 'request_tool' || stepOut.type === 'complete')
            ? { usage }
            : {}),
          modelAttempts: attempts,
        };
      } catch (err) {
        if (input.signal?.aborted) {
          return {
            type: 'error',
            code: 'RUN_ABORTED',
            message: 'Run aborted while awaiting model response',
            modelAttempts: attempts,
          };
        }
        const msg = sanitizeSecret((err as Error).message || 'Request failed', this.apiKey);
        lastError = msg;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        return {
          type: 'error',
          code: 'MODEL_NETWORK_OR_TIMEOUT',
          message: lastError,
          modelAttempts: attempts,
        };
      }
    }

    return {
      type: 'error',
      code: 'MODEL_RETRY_EXHAUSTED',
      message: lastError,
      modelAttempts: attempts,
    };
  }

  private validateAndMapToolCall(
    toolName: string,
    rawArgs: unknown,
    input: ModelStepInput
  ): ModelStepOutput {
    const validScenarioIds = new Set(input.candidateScenarios.map((s) => s.scenarioId));

    if (toolName === 'evaluate_scenario') {
      const parsed = EvaluateScenarioArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          type: 'error',
          code: 'INVALID_TOOL_ARGS',
          message: `Invalid evaluate_scenario arguments: ${parsed.error.message}`,
        };
      }
      if (!validScenarioIds.has(parsed.data.scenarioId)) {
        return {
          type: 'error',
          code: 'UNKNOWN_SCENARIO_ID',
          message: `Model selected unknown scenarioId: ${parsed.data.scenarioId}`,
        };
      }
      return {
        type: 'request_tool',
        toolRequest: {
          toolName: 'evaluate_scenario',
          params: { scenarioId: parsed.data.scenarioId },
        },
        reasoning: parsed.data.reasoning,
      };
    }

    if (toolName === 'request_clarification') {
      const parsed = RequestClarificationArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          type: 'error',
          code: 'INVALID_TOOL_ARGS',
          message: `Invalid request_clarification arguments: ${parsed.error.message}`,
        };
      }
      return {
        type: 'request_tool',
        toolRequest: {
          toolName: 'request_clarification',
          params: { fieldCategory: parsed.data.fieldCategory },
        },
        reasoning: parsed.data.reasoning,
      };
    }

    if (toolName === 'complete_analysis') {
      const parsed = CompleteAnalysisArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          type: 'error',
          code: 'INVALID_TOOL_ARGS',
          message: `Invalid complete_analysis arguments: ${parsed.error.message}`,
        };
      }

      if (!validScenarioIds.has(parsed.data.selectedScenarioId)) {
        return {
          type: 'error',
          code: 'UNKNOWN_SCENARIO_ID',
          message: `Analysis selected unknown scenarioId: ${parsed.data.selectedScenarioId}`,
        };
      }

      // Verify model references real local calculation evidence from toolHistory
      const matchingTool = input.toolHistory.find(
        (t) =>
          t.request.toolName === 'evaluate_scenario' &&
          t.request.params.scenarioId === parsed.data.selectedScenarioId &&
          t.result?.evidenceId === parsed.data.evidenceId
      );

      if (!matchingTool) {
        return {
          type: 'error',
          code: 'UNVERIFIED_EVIDENCE_REFERENCE',
          message: `Analysis cited unverified evidenceId ${parsed.data.evidenceId} for scenario ${parsed.data.selectedScenarioId}`,
        };
      }

      // R09 / A-02: Do not allow model to claim viable when evaluation was not satisfied or was unreliable
      const evalResult = matchingTool.result;
      if (
        parsed.data.verdict === 'viable' &&
        evalResult?.toolName === 'evaluate_scenario' &&
        (evalResult.status !== 'satisfied' || !evalResult.isReliable)
      ) {
        return {
          type: 'error',
          code: 'UNRELIABLE_OR_VIOLATED_VIABLE_CLAIM',
          message: `Analysis claimed verdict=viable when evaluated scenario status=${evalResult.status}, isReliable=${evalResult.isReliable}`,
        };
      }

      const cleanTradeOff = sanitizeUntrustedText(parsed.data.tradeOffSummary);
      const cleanAssumptions = parsed.data.assumptionsUsed
        .map((a) => sanitizeUntrustedText(a))
        .filter((a) => a.length > 0);

      if (!cleanTradeOff || cleanAssumptions.length === 0) {
        return {
          type: 'error',
          code: 'UNSAFE_MODEL_OUTPUT',
          message: 'Analysis output became empty after P-08 sanitization',
        };
      }

      const fullAnalysis = VerifiedAnalysisSchema.safeParse({
        runId: input.runId,
        ...parsed.data,
        tradeOffSummary: cleanTradeOff,
        assumptionsUsed: cleanAssumptions,
      });
      if (!fullAnalysis.success) {
        return {
          type: 'error',
          code: 'INVALID_ANALYSIS_SCHEMA',
          message: fullAnalysis.error.message,
        };
      }

      return {
        type: 'complete',
        analysis: fullAnalysis.data,
      };
    }

    return {
      type: 'error',
      code: 'DISALLOWED_TOOL',
      message: `Model attempted to call disallowed tool: ${toolName}`,
    };
  }

  async answerFollowUp(input: FollowUpInput): Promise<FollowUpOutput> {
    const evaluatedScenarioIds = new Set(
      input.toolHistory
        .filter((t) => t.request.toolName === 'evaluate_scenario' && t.result)
        .map((t) => t.request.params.scenarioId)
    );

    const context = {
      safeProfileSummary: input.safeProfileSummary,
      safeGoalSummary: input.safeGoalSummary,
      verifiedAnalysis: input.analysis,
      evaluatedTools: input.toolHistory.map((t) => ({
        toolName: t.request.toolName,
        params: t.request.params,
        result: t.result ?? null,
      })),
      evaluatedScenarios: input.toolHistory
        .filter((t) => t.request.toolName === 'evaluate_scenario' && t.result)
        .map((t) => ({
          scenarioId: t.request.params.scenarioId,
          result: t.result,
        })),
      unevaluatedScenarios: (input.candidateScenarios ?? [])
        .filter((s) => !evaluatedScenarioIds.has(s.scenarioId))
        .map((s) => ({
          scenarioId: s.scenarioId,
          scenarioKind: s.scenarioKind,
          adjustmentTier: s.adjustmentTier,
        })),
      priorFollowUps: input.priorFollowUps,
      followUpIntent: input.intent,
      selectedScenarioId: input.selectedScenarioId ?? input.analysis.selectedScenarioId,
      ...(input.focusScenarioId ? { focusScenarioId: input.focusScenarioId } : {}),
    };

    const requestBody = {
      model: this.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You answer structured post-report follow-up intents in a strict privacy-preserving financial planner.',
            'IMPORTANT: All text in answer and limitationsNoted MUST be written in Simplified Chinese (简体中文).',
            'You NEVER see exact currency amounts, balances, or dates — only closed-enum followUpIntent, bucketed summaries, and verifiedAnalysis.',
            'Call reply_followup once. Copy verifiedAnalysis.evidenceId verbatim as citedEvidenceId.',
            'Strict length bounds: answer <= 1400 characters; each item in limitationsNoted <= 150 characters (1 to 5 items).',
            'When asked about an unevaluated scenario (listed under unevaluatedScenarios), explain clearly that this alternative was not calculated locally during this planning run, and note that running a scenario evaluation or re-planning run is required for exact comparison. Note this clearly in limitationsNoted.',
            'Never fabricate currency amounts, never load remote URLs/images/scripts, and clearly note analysis limitations.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Controlled post-report context JSON:\n${JSON.stringify(context, null, 2)}`,
        },
      ],
      tools: FOLLOWUP_TOOL,
      tool_choice: 'required',
    };

    let lastError = 'Unknown follow-up failure';
    let attempts = 0;
    let accumulatedPromptTokens = 0;
    let accumulatedCompletionTokens = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (input.signal?.aborted) {
        return {
          type: 'error',
          code: 'RUN_ABORTED',
          message: 'Follow-up aborted',
          modelAttempts: attempts,
        };
      }
      if (attempt > 0 && input.reserveRetry && !input.reserveRetry()) {
        return { type: 'error', code: 'MODEL_BUDGET_EXHAUSTED', message: 'Model request budget exhausted before retry', modelAttempts: attempts };
      }
      attempts++;
      try {
        const timeoutSig = AbortSignal.timeout(this.timeoutMs);
        const signal = input.signal
          ? AbortSignal.any([input.signal, timeoutSig])
          : timeoutSig;

        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal,
        });

        if (!res.ok) {
          const errText = sanitizeSecret(await res.text().catch(() => ''), this.apiKey).slice(0, 300);
          lastError = `HTTP ${res.status}: ${errText || res.statusText}`;
          if (!input.signal?.aborted && isRetryableStatus(res.status) && attempt < this.maxRetries) {
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          return {
            type: 'error',
            code: `MODEL_HTTP_${res.status}`,
            message: lastError,
            modelAttempts: attempts,
          };
        }

        const data = (await res.json()) as {
          choices?: Array<{
            message?: {
              tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        if (
          data.usage &&
          typeof data.usage.prompt_tokens === 'number' &&
          typeof data.usage.completion_tokens === 'number'
        ) {
          accumulatedPromptTokens += data.usage.prompt_tokens;
          accumulatedCompletionTokens += data.usage.completion_tokens;
        }

        const toolCallObj = data.choices?.[0]?.message?.tool_calls?.[0];
        const fn = toolCallObj?.function;
        const toolCallId = toolCallObj?.id ?? 'call_followup_0';
        if (!fn || fn.name !== 'reply_followup' || !fn.arguments) {
          return {
            type: 'error',
            code: 'INVALID_FOLLOWUP_OUTPUT',
            message: 'Model did not return reply_followup tool call',
            modelAttempts: attempts,
          };
        }

        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(fn.arguments);
        } catch {
          if (attempt < this.maxRetries) {
            requestBody.messages.push({
              role: 'assistant',
              content: null as unknown as string,
              tool_calls: [
                {
                  id: toolCallId,
                  type: 'function',
                  function: { name: fn.name, arguments: fn.arguments },
                },
              ],
            } as any);
            requestBody.messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({
                status: 'error',
                code: 'INVALID_MODEL_JSON',
                message: 'Arguments were not valid JSON. Please return valid JSON object matching tool parameters.',
              }),
            } as any);
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          return {
            type: 'error',
            code: 'INVALID_FOLLOWUP_ARGS',
            message: 'Model tool arguments were not valid JSON',
            modelAttempts: attempts,
          };
        }

        const argsRes = FollowUpToolArgsSchema.safeParse(parsedArgs);
        if (!argsRes.success) {
          if (attempt < this.maxRetries) {
            requestBody.messages.push({
              role: 'assistant',
              content: null as unknown as string,
              tool_calls: [
                {
                  id: toolCallId,
                  type: 'function',
                  function: { name: fn.name, arguments: fn.arguments },
                },
              ],
            } as any);
            requestBody.messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: JSON.stringify({
                status: 'error',
                code: 'INVALID_FOLLOWUP_ARGS',
                message: `Parameter validation error: ${argsRes.error.message}. Please strictly observe character length limits (answer <= 1400 chars, each limitationsNoted <= 150 chars, Simplified Chinese) and try again.`,
              }),
            } as any);
            await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          return {
            type: 'error',
            code: 'INVALID_FOLLOWUP_ARGS',
            message: argsRes.error.message,
            modelAttempts: attempts,
          };
        }

        if (argsRes.data.citedEvidenceId !== input.analysis.evidenceId) {
          return {
            type: 'error',
            code: 'UNVERIFIED_EVIDENCE_REFERENCE',
            message: `Follow-up cited ${argsRes.data.citedEvidenceId}, expected ${input.analysis.evidenceId}`,
            modelAttempts: attempts,
          };
        }

        const validated = FollowUpResponseSchema.safeParse({
          runId: input.runId,
          answer: sanitizeUntrustedText(argsRes.data.answer),
          citedEvidenceId: argsRes.data.citedEvidenceId,
          limitationsNoted: argsRes.data.limitationsNoted.map((l) => sanitizeUntrustedText(l)),
        });

        if (!validated.success) {
          return {
            type: 'error',
            code: 'INVALID_FOLLOWUP_SCHEMA',
            message: validated.error.message,
            modelAttempts: attempts,
          };
        }

        const usage =
          accumulatedPromptTokens > 0 || accumulatedCompletionTokens > 0
            ? {
                promptTokens: accumulatedPromptTokens,
                completionTokens: accumulatedCompletionTokens,
              }
            : undefined;

        return {
          type: 'ok',
          response: validated.data,
          ...(usage ? { usage } : {}),
          modelAttempts: attempts,
        };
      } catch (err) {
        if (input.signal?.aborted) {
          return {
            type: 'error',
            code: 'RUN_ABORTED',
            message: 'Follow-up aborted',
            modelAttempts: attempts,
          };
        }
        lastError = sanitizeSecret((err as Error).message || 'Follow-up failed', this.apiKey);
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        return {
          type: 'error',
          code: 'MODEL_NETWORK_OR_TIMEOUT',
          message: lastError,
          modelAttempts: attempts,
        };
      }
    }

    return {
      type: 'error',
      code: 'MODEL_RETRY_EXHAUSTED',
      message: lastError,
      modelAttempts: attempts,
    };
  }
}
