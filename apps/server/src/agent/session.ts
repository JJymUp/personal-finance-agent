import crypto from 'node:crypto';
import {
  SafeToolResultSchema,
  sanitizeUntrustedText,
  type RunRequest,
  type AgentStatus,
  type AgentEvent,
  type BrowserToolRequest,
  type SafeToolResult,
  type VerifiedAnalysis,
  type FollowUpRequest,
  type FollowUpResponse,
  type FollowUpIntent,
} from '@maggot/contracts';
import type { ModelProvider } from '../providers/types.js';

export const MAX_TOOL_CALLS = 6;
export const MAX_STEPS = 10;
export const MAX_MODEL_REQUESTS = 16;
export const MAX_FOLLOWUPS = 10;
export const DEFAULT_MAX_DURATION_MS = 120_000; // 2 minutes active model/execution budget

export interface InheritedSessionUsage {
  stepCount: number;
  toolCallCount: number;
  modelRequestCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  activeElapsedMs?: number;
}

export interface SessionEventListener {
  (event: AgentEvent): void;
}

export class AgentSession {
  readonly runId: string;
  readonly request: RunRequest;
  private status: AgentStatus = 'created';
  private sequenceNumber = 0;
  private stepCount = 0;
  private toolCallCount = 0;
  private modelRequestCount = 0;
  private followUpsStarted = 0;
  private followUpInFlight = false;
  private listeners: SessionEventListener[] = [];
  private eventHistory: AgentEvent[] = [];
  private activeStepPromise: Promise<void> | null = null;
  private pendingToolRequest: BrowserToolRequest | null = null;
  private toolHistory: Array<{
    request: BrowserToolRequest;
    result?: SafeToolResult;
  }> = [];
  private completedAnalysis: VerifiedAnalysis | null = null;
  private followUpHistory: Array<{ intent: FollowUpIntent; answer: string }> = [];
  private provider: ModelProvider;

  /** Active execution duration budget (excludes time waiting on browser/user — R05) */
  private accumulatedActiveMs = 0;
  private readonly maxDurationMs: number;
  private abortController = new AbortController();

  /** Accumulated token usage from model responses */
  private promptTokensUsed = 0;
  private completionTokensUsed = 0;

  constructor(
    request: RunRequest,
    provider: ModelProvider,
    inheritedUsage?: InheritedSessionUsage,
    maxDurationMs?: number
  ) {
    // R02: Always assign server-generated unique runId; ignore any client-supplied ID
    this.runId = `run_${crypto.randomUUID()}`;
    this.request = { ...request };
    this.provider = provider;
    this.maxDurationMs = maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    if (inheritedUsage) {
      this.stepCount = inheritedUsage.stepCount;
      this.toolCallCount = inheritedUsage.toolCallCount;
      this.modelRequestCount = inheritedUsage.modelRequestCount ?? inheritedUsage.stepCount;
      this.promptTokensUsed = inheritedUsage.promptTokens ?? 0;
      this.completionTokensUsed = inheritedUsage.completionTokens ?? 0;
      this.accumulatedActiveMs = inheritedUsage.activeElapsedMs ?? 0;
    }
  }

  private reserveModelRetry = (): boolean => {
    if (this.modelRequestCount >= MAX_MODEL_REQUESTS) return false;
    this.modelRequestCount++;
    return true;
  };

  getStatus(): AgentStatus {
    return this.status;
  }

  getEventHistory(): AgentEvent[] {
    return [...this.eventHistory];
  }

  getUsage() {
    return {
      stepCount: this.stepCount,
      toolCallCount: this.toolCallCount,
      modelRequestCount: this.modelRequestCount,
      activeElapsedMs: this.accumulatedActiveMs,
    };
  }

  getTokenUsage() {
    return {
      promptTokens: this.promptTokensUsed,
      completionTokens: this.completionTokensUsed,
      totalTokens: this.promptTokensUsed + this.completionTokensUsed,
    };
  }

  getPendingToolRequest(): BrowserToolRequest | null {
    return this.pendingToolRequest;
  }

  getCompletedAnalysis(): VerifiedAnalysis | null {
    return this.completedAnalysis;
  }

  /**
   * Returns the tool history — used by SessionStore for clarification call ID verification.
   * Does NOT expose raw financial data (tool params/results contain only safe summaries).
   */
  getToolHistory(): Array<{ request: BrowserToolRequest; result?: SafeToolResult }> {
    return [...this.toolHistory];
  }

  addEventListener(listener: SessionEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emitEvent(type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
    this.sequenceNumber++;
    const event: AgentEvent = {
      runId: this.runId,
      sequenceNumber: this.sequenceNumber,
      timestamp: Date.now(),
      type,
      payload,
    };
    this.eventHistory.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error in event listener', err);
      }
    }
    return event;
  }

  private setStatus(newStatus: AgentStatus): void {
    const oldStatus = this.status;
    this.status = newStatus;
    this.emitEvent('status_changed', { from: oldStatus, to: newStatus });
  }

  /**
   * Starts or resumes the agent execution loop
   */
  async start(): Promise<void> {
    if (this.status !== 'created') {
      throw new Error(`Cannot start session in state: ${this.status}`);
    }

    this.setStatus('running');
    const stepPromise = this.step();
    this.activeStepPromise = stepPromise;
    await stepPromise;
  }

  /**
   * Advances one step of model thinking / tool requesting
   */
  private async step(): Promise<void> {
    if (this.status !== 'running') {
      return;
    }

    this.stepCount++;

    // 0. Per-run active duration budget check (excludes waiting-for-user time — R05)
    const remainingMs = this.maxDurationMs - this.accumulatedActiveMs;
    if (remainingMs <= 0) {
      this.setStatus('failed');
      this.emitEvent('failed', {
        errorCode: 'TIMEOUT_EXCEEDED',
        message: `Run exceeded maximum active execution budget of ${this.maxDurationMs}ms`,
      });
      return;
    }

    // 1. Quota & limit checks
    if (this.stepCount > MAX_STEPS) {
      this.setStatus('failed');
      this.emitEvent('failed', {
        errorCode: 'MAX_STEPS_EXCEEDED',
        message: `Exceeded maximum allowed steps (${MAX_STEPS})`,
      });
      return;
    }

    if (this.modelRequestCount >= MAX_MODEL_REQUESTS) {
      this.setStatus('failed');
      this.emitEvent('failed', {
        errorCode: 'MODEL_BUDGET_EXHAUSTED',
        message: `Exceeded maximum model requests budget (${MAX_MODEL_REQUESTS})`,
      });
      return;
    }

    if (this.toolCallCount > MAX_TOOL_CALLS) {
      this.setStatus('failed');
      this.emitEvent('failed', {
        errorCode: 'TOOL_QUOTA_EXHAUSTED',
        message: `Exceeded maximum tool calls limit (${MAX_TOOL_CALLS})`,
      });
      return;
    }

    const stepStartedAt = Date.now();
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(new Error('TIMEOUT_EXCEEDED'));
    }, remainingMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    const stepSignal = AbortSignal.any([this.abortController.signal, timeoutController.signal]);

    // 2. Call model provider
    try {
      this.modelRequestCount++; // Reserve the first request before any asynchronous work.
      const stepOutput = await this.provider.generateStep({
        runId: this.runId,
        stepNumber: this.stepCount,
        safeProfileSummary: this.request.safeProfileSummary,
        safeGoalSummary: this.request.safeGoalSummary,
        candidateScenarios: this.request.candidateScenarios,
        toolHistory: this.toolHistory,
        signal: stepSignal,
        reserveRetry: this.reserveModelRetry,
      });

      this.accumulatedActiveMs += Date.now() - stepStartedAt;


      // R05: Critical guard — never let a late provider response resurrect cancelled/interrupted state!
      if (this.status !== 'running') {
        return;
      }

      if (timeoutController.signal.aborted || this.accumulatedActiveMs > this.maxDurationMs) {
        this.setStatus('failed');
        this.emitEvent('failed', {
          errorCode: 'TIMEOUT_EXCEEDED',
          message: `Run exceeded maximum active execution budget of ${this.maxDurationMs}ms`,
        });
        return;
      }

      // Accumulate token usage if reported
      if ('usage' in stepOutput && stepOutput.usage) {
        this.promptTokensUsed += stepOutput.usage.promptTokens;
        this.completionTokensUsed += stepOutput.usage.completionTokens;
      }

      if (stepOutput.type === 'error') {
        this.setStatus('failed');
        this.emitEvent('failed', {
          errorCode: stepOutput.code,
          message: stepOutput.message,
        });
        return;
      }

      if (stepOutput.type === 'request_tool') {
        // R05: Enforce tool quota strictly BEFORE issuing a 7th tool call!
        if (this.toolCallCount >= MAX_TOOL_CALLS) {
          this.setStatus('failed');
          this.emitEvent('failed', {
            errorCode: 'TOOL_QUOTA_EXHAUSTED',
            message: `Exceeded maximum tool calls limit (${MAX_TOOL_CALLS})`,
          });
          return;
        }

        this.toolCallCount++;
        const callId = `call_${crypto.randomUUID()}`;
        const toolRequest: BrowserToolRequest = {
          runId: this.runId,
          callId,
          toolName: stepOutput.toolRequest.toolName,
          params: stepOutput.toolRequest.params,
          versionBinding: {
            snapshotVersion: this.request.snapshotVersion,
            goalVersion: this.request.goalVersion,
            policyVersion: this.request.policyVersion,
          },
        };

        this.pendingToolRequest = toolRequest;
        this.toolHistory.push({ request: toolRequest });

        this.setStatus('waiting_for_browser_tool');
        this.emitEvent('tool_requested', {
          toolRequest,
          reasoning: stepOutput.reasoning,
        });
        return;
      }

      if (stepOutput.type === 'complete') {
        // R09 / A-02 defense-in-depth at session level
        const citedTool = this.toolHistory.find(
          (t) =>
            t.request.toolName === 'evaluate_scenario' &&
            t.request.params.scenarioId === stepOutput.analysis.selectedScenarioId &&
            t.result?.evidenceId === stepOutput.analysis.evidenceId
        );
        if (
          !citedTool ||
          (stepOutput.analysis.verdict === 'viable' &&
            citedTool.result?.toolName === 'evaluate_scenario' &&
            (citedTool.result.status !== 'satisfied' || !citedTool.result.isReliable))
        ) {
          this.setStatus('failed');
          this.emitEvent('failed', {
            errorCode: 'UNVERIFIED_OR_UNRELIABLE_ANALYSIS',
            message: 'Model attempted to complete without matching satisfied reliable evidence',
          });
          return;
        }

        const sanitizedAnalysis: VerifiedAnalysis = {
          ...stepOutput.analysis,
          runId: this.runId,
          tradeOffSummary: sanitizeUntrustedText(stepOutput.analysis.tradeOffSummary),
          assumptionsUsed: stepOutput.analysis.assumptionsUsed.map((a) =>
            sanitizeUntrustedText(a)
          ),
        };
        this.completedAnalysis = sanitizedAnalysis;
        this.setStatus('completed');
        this.emitEvent('completed', {
          verifiedAnalysis: sanitizedAnalysis,
        });
        return;
      }
    } catch (err) {
      this.accumulatedActiveMs += Date.now() - stepStartedAt;
      if (this.status !== 'running') {
        return;
      }
      if (timeoutController.signal.aborted) {
        this.setStatus('failed');
        this.emitEvent('failed', {
          errorCode: 'TIMEOUT_EXCEEDED',
          message: `Run exceeded maximum active execution budget of ${this.maxDurationMs}ms`,
        });
        return;
      }
      this.setStatus('failed');
      this.emitEvent('failed', {
        errorCode: 'INTERNAL_ERROR',
        message: (err as Error).message,
      });
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * Feeds tool result from client back to the session.
   * Enforces strict discriminated union validation, tool/param/version matching, and idempotency (R04).
   * Supports options.waitStep = false to return immediately while running step in background (RM-02).
   */
  async submitToolResult(
    rawResult: SafeToolResult,
    options?: { waitStep?: boolean }
  ): Promise<void> {
    if (this.status === 'cancelled') {
      throw new Error('Run has been cancelled. Late tool results rejected.');
    }

    const parsedRes = SafeToolResultSchema.safeParse(rawResult);
    if (!parsedRes.success) {
      throw new Error(`Invalid SafeToolResult schema: ${parsedRes.error.message}`);
    }
    const result = parsedRes.data;

    // R04: Check already-submitted results for idempotency vs conflicting content
    const existing = this.toolHistory.find(
      (t) => t.request.callId === result.callId && t.result !== undefined
    );
    if (existing) {
      if (JSON.stringify(existing.result) === JSON.stringify(result)) {
        return; // True idempotent resubmission
      }
      throw new Error(
        `Conflicting duplicate tool result for callId ${result.callId} rejected`
      );
    }

    if (this.status !== 'waiting_for_browser_tool') {
      throw new Error(`Session is not waiting for a tool: current state is ${this.status}`);
    }

    if (!this.pendingToolRequest || this.pendingToolRequest.callId !== result.callId) {
      throw new Error(
        `Tool call ID mismatch. Expected ${this.pendingToolRequest?.callId}, got ${result.callId}`
      );
    }

    // R04: Strictly verify toolName matches pending request
    if (result.toolName !== this.pendingToolRequest.toolName) {
      throw new Error(
        `Tool name mismatch for callId ${result.callId}: expected ${this.pendingToolRequest.toolName}, got ${result.toolName}`
      );
    }

    // R04: Strictly verify params match pending request
    if (result.toolName === 'evaluate_scenario') {
      if (result.scenarioId !== this.pendingToolRequest.params.scenarioId) {
        throw new Error(
          `Scenario ID mismatch: expected ${this.pendingToolRequest.params.scenarioId}, got ${result.scenarioId}`
        );
      }
    } else if (result.toolName === 'request_clarification') {
      if (result.fieldCategory !== this.pendingToolRequest.params.fieldCategory) {
        throw new Error(
          `Clarification fieldCategory mismatch: expected ${this.pendingToolRequest.params.fieldCategory}, got ${result.fieldCategory}`
        );
      }
    }

    // R04: Strictly verify versionBinding matches active run versions
    const expectedVer = this.pendingToolRequest.versionBinding;
    if (
      result.versionBinding.snapshotVersion !== expectedVer.snapshotVersion ||
      result.versionBinding.goalVersion !== expectedVer.goalVersion ||
      result.versionBinding.policyVersion !== expectedVer.policyVersion
    ) {
      throw new Error(
        `Version binding mismatch: expected ${JSON.stringify(expectedVer)}, got ${JSON.stringify(result.versionBinding)}`
      );
    }

    // Attach result to history
    const historyItem = this.toolHistory.find((t) => t.request.callId === result.callId);
    if (historyItem) {
      historyItem.result = result;
    }

    this.pendingToolRequest = null;
    this.setStatus('running');

    const stepPromise = this.step().catch((err) => {
      if (this.status === 'running') {
        this.setStatus('failed');
        this.emitEvent('failed', {
          errorCode: 'INTERNAL_ERROR',
          message: (err as Error).message,
        });
      }
    });
    this.activeStepPromise = stepPromise;

    if (options?.waitStep !== false) {
      await stepPromise;
    }
  }

  async waitForActiveStep(): Promise<void> {
    if (this.activeStepPromise) {
      await this.activeStepPromise;
    }
  }

  /**
   * Cancels the run session atomically and aborts any in-flight model call
   */
  cancel(reason: string): void {
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(this.status)) {
      return;
    }
    this.pendingToolRequest = null;
    this.setStatus('cancelled');
    this.abortController.abort(new Error(reason));
    this.emitEvent('cancelled', { reason });
  }

  /**
   * Handles a controlled post-report structured follow-up intent (R01 / P-03).
   */
  async answerFollowUp(followUpReq: FollowUpRequest): Promise<FollowUpResponse> {
    if (this.status !== 'completed' || !this.completedAnalysis) {
      throw new Error(`Follow-up requires a completed run (current status: ${this.status})`);
    }
    if (this.followUpInFlight) throw new Error('A follow-up is already in progress for this run');
    const remainingMs = this.maxDurationMs - this.accumulatedActiveMs;
    if (remainingMs <= 0) throw new Error('TIMEOUT_EXCEEDED: active execution budget exhausted');
    if (this.followUpsStarted >= MAX_FOLLOWUPS) {
      throw new Error(`Exceeded maximum follow-up turns (${MAX_FOLLOWUPS}) for this run`);
    }
    if (this.modelRequestCount >= MAX_MODEL_REQUESTS) {
      throw new Error(`Exceeded maximum model requests budget (${MAX_MODEL_REQUESTS})`);
    }
    if (!this.provider.answerFollowUp) {
      throw new Error(`Provider ${this.provider.name} does not support follow-up conversation`);
    }

    const validScenarioIds = new Set(this.request.candidateScenarios.map((s) => s.scenarioId));
    if (followUpReq.selectedScenarioId && !validScenarioIds.has(followUpReq.selectedScenarioId)) {
      throw new Error(`Unknown selectedScenarioId: ${followUpReq.selectedScenarioId}`);
    }
    if (followUpReq.focusScenarioId && !validScenarioIds.has(followUpReq.focusScenarioId)) {
      throw new Error(`Unknown focusScenarioId: ${followUpReq.focusScenarioId}`);
    }

    this.modelRequestCount++;
    this.followUpsStarted++;
    this.followUpInFlight = true;
    const startedAt = Date.now();
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), remainingMs);
    timer.unref?.();
    let out;
    try {
      out = await this.provider.answerFollowUp({
        runId: this.runId,
        intent: followUpReq.intent,
        selectedScenarioId: followUpReq.selectedScenarioId,
        focusScenarioId: followUpReq.focusScenarioId,
        safeProfileSummary: this.request.safeProfileSummary,
        safeGoalSummary: this.request.safeGoalSummary,
        candidateScenarios: this.request.candidateScenarios,
        analysis: this.completedAnalysis,
        toolHistory: this.toolHistory,
        priorFollowUps: [...this.followUpHistory],
        signal: AbortSignal.any([this.abortController.signal, timeoutController.signal]),
        reserveRetry: this.reserveModelRetry,
      });

      if (timeoutController.signal.aborted || Date.now() - startedAt > remainingMs) {
        throw new Error('TIMEOUT_EXCEEDED: active execution budget exhausted');
      }
    } finally {
      this.accumulatedActiveMs += Date.now() - startedAt;
      clearTimeout(timer);
      this.followUpInFlight = false;
    }

    if (out.type === 'error') {
      throw new Error(`Follow-up generation failed (${out.code}): ${out.message}`);
    }

    if (out.usage) {
      this.promptTokensUsed += out.usage.promptTokens;
      this.completionTokensUsed += out.usage.completionTokens;
    }

    const cleanResponse: FollowUpResponse = {
      ...out.response,
      runId: this.runId,
      answer: sanitizeUntrustedText(out.response.answer),
      limitationsNoted: out.response.limitationsNoted.map((l) => sanitizeUntrustedText(l)),
    };

    this.followUpHistory.push({
      intent: followUpReq.intent,
      answer: cleanResponse.answer,
    });

    this.emitEvent('analysis_chunk', {
      followUpTurn: this.followUpHistory.length,
      citedEvidenceId: cleanResponse.citedEvidenceId,
    });

    return cleanResponse;
  }

  /**
   * Marks run as interrupted (e.g. server restart or client reconnect timeout)
   */
  interrupt(reason: string): void {
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(this.status)) {
      return;
    }
    this.setStatus('interrupted');
    this.abortController.abort(new Error(reason));
    this.emitEvent('interrupted', { reason });
  }

  /**
   * Returns a recoverable checkpoint snapshot for browser persistence.
   * Does NOT include any raw financial data — only session coordination state.
   */
  getCheckpoint(): {
    runId: string;
    status: AgentStatus;
    snapshotVersion: string;
    goalVersion: string;
    policyVersion: string;
    pendingCallId: string | null;
    usageSoFar: {
      stepCount: number;
      toolCallCount: number;
      modelRequestCount: number;
      activeElapsedMs: number;
    };
    tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
    eventCount: number;
    elapsedMs: number;
  } {
    return {
      runId: this.runId,
      status: this.status,
      snapshotVersion: this.request.snapshotVersion,
      goalVersion: this.request.goalVersion,
      policyVersion: this.request.policyVersion,
      pendingCallId: this.pendingToolRequest?.callId ?? null,
      usageSoFar: this.getUsage(),
      tokenUsage: this.getTokenUsage(),
      eventCount: this.eventHistory.length,
      elapsedMs: this.accumulatedActiveMs,
    };
  }
}
