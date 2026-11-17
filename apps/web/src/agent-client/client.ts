import {
  AgentEventSchema,
  BrowserToolRequestSchema,
  VerifiedAnalysisSchema,
  sanitizeUntrustedText,
  type RunRequest,
  type AgentEvent,
  type BrowserToolRequest,
  type VerifiedAnalysis,
  type FollowUpRequest,
  type FollowUpResponse,
  type ClarificationChoice,
  type RejectionCategory,
  type VersionBinding,
  type SafeScenarioDescriptor,
} from '@maggot/contracts';
import type { UserProfile } from '../features/profile/types.js';
import type {
  LargePurchaseGoal,
  ScenarioCalculationResult,
  IntraMonthLiquidityStatus,
} from '../local/finance/calculator.js';
import {
  generateCandidateScenarios,
  evaluateScenarioLocal,
  toSafeToolResult,
} from '../local/finance/calculator.js';
import { deriveSafeProfileSummary, deriveSafeGoalSummary } from '../local/privacy/summary.js';
import { PrivacyGateway } from '../local/privacy/gateway.js';

export interface LocalFinalReport {
  runId: string;
  verdict: 'viable' | 'caution' | 'not_viable';
  tradeOffSummary: string;
  selectedScenarioId: string;
  evidenceId: string;
  exactTargetAmount: number; // in cents
  exactEndingCash: number; // in cents
  exactMinimumCash: number; // in cents
  exactDeficit: number; // in cents
  assumptionsUsed: string[];
  isVerified: boolean;
  generatedAt: string;
  snapshotVersion: string;
  goalVersion: string;
  candidateScenarioIds: string[];
  intraMonthLiquidityStatus?: IntraMonthLiquidityStatus;
  hasUncertainPriorSpend?: boolean;
}

export interface ServerCheckpointStatus {
  runId: string;
  status: string;
  pendingCallId: string | null;
  eventCount?: number;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ClientTransport {
  createRun(
    request: RunRequest,
    options?: { signal?: AbortSignal }
  ): Promise<{ runId: string; status: string; sessionToken?: string }>;
  submitToolResult(
    runId: string,
    result: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<{ status: string }>;
  cancelRun(runId: string, reason: string): Promise<{ status: string }>;
  fetchEvents(runId: string, options?: { signal?: AbortSignal }): Promise<AgentEvent[]>;
  sendFollowUp?(runId: string, request: FollowUpRequest): Promise<FollowUpResponse>;
  registerRunSession?(runId: string, sessionToken: string, lastSequenceNumber?: number): void;
  getCheckpoint?(
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ServerCheckpointStatus | null>;
}

export interface LocalCheckpoint {
  runId: string;
  goalId: string;
  snapshotVersion: string;
  goalVersion: string;
  policyVersion?: string;
  lastSequenceNumber: number;
  status: string;
  updatedAt: string;
  /** Stored ONLY inside AES-GCM encrypted DexieCheckpointStore (R06 / R08) */
  sessionToken?: string;
  candidateScenarioIds?: string[];
  knownTokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  localEvaluations?: Record<string, ScenarioCalculationResult>;
  hasUncertainSpend?: boolean;
}

export interface CheckpointStore {
  save(checkpoint: LocalCheckpoint): Promise<void> | void;
  load(goalId: string): Promise<LocalCheckpoint | null> | LocalCheckpoint | null;
  clear(goalId: string): Promise<void> | void;
}

export class MemoryCheckpointStore implements CheckpointStore {
  private checkpoints = new Map<string, LocalCheckpoint>();

  save(checkpoint: LocalCheckpoint): void {
    this.checkpoints.set(checkpoint.goalId, { ...checkpoint });
  }

  load(goalId: string): LocalCheckpoint | null {
    return this.checkpoints.get(goalId) ?? null;
  }

  clear(goalId: string): void {
    this.checkpoints.delete(goalId);
  }
}

export interface StructuredClarificationDecision {
  action: 'answer' | 'modify_input' | 'decline';
  clarificationChoice?: ClarificationChoice;
  rejectionCategory?: RejectionCategory;
  updatedProfile?: UserProfile;
  updatedGoal?: LargePurchaseGoal;
}

export interface PlanningLoopOptions {
  onEvent?: (event: AgentEvent) => void;
  onRunCreated?: (runId: string, sessionToken?: string) => void;
  checkpointStore?: CheckpointStore;
  parentRunId?: string;
  originalClarificationCallId?: string;
  signal?: AbortSignal;
  includeFamilySummary?: boolean;
  /** R14: Re-verify current live browser profile/goal versions before tools and report acceptance */
  getCurrentVersions?: () => { snapshotVersion: string; goalVersion: string; policyVersion?: string };
  /** R06: Explicit user confirmation required before starting a fresh run when server state was lost */
  confirmRestartOnLostServerState?: boolean;
  hasUncertainPriorSpend?: boolean;
  clarificationHandler?: (request: BrowserToolRequest) => Promise<StructuredClarificationDecision>;
}

function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new Error('Planning run aborted while waiting for input')); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

const DEFAULT_POLICY_VERSION = 'p_1.0';

export class ClientAgentCoordinator {
  private gateway: PrivacyGateway;
  private transport: ClientTransport;
  private targetProvider: string;
  private localEvaluations = new Map<string, ScenarioCalculationResult>();

  constructor(
    gateway: PrivacyGateway,
    transport: ClientTransport,
    targetProvider = 'mock_provider'
  ) {
    this.gateway = gateway;
    this.transport = transport;
    this.targetProvider = targetProvider;
  }

  /** Clear local cached evaluations (called on vault lock per R08) */
  clearSensitiveState(): void {
    this.localEvaluations.clear();
  }

  /** Checks if a scenario has been evaluated locally within the current coordinator session */
  hasEvaluatedScenario(scenarioId: string): boolean {
    return this.localEvaluations.has(scenarioId);
  }

  /**
   * Resumes planning from an encrypted local checkpoint (R06):
   * 1. Rejects if profile snapshot or goal version changed (F-06 / O-05).
   * 2. If server run is still alive & authenticated via sessionToken, reconnects directly to SSE (zero duplicate spend!).
   * 3. If server state was lost (e.g. restart/TTL), persists interrupted state and requires explicit confirmRestartOnLostServerState.
   */
  async resumeFromCheckpoint(
    profile: UserProfile,
    goal: LargePurchaseGoal,
    checkpoint: LocalCheckpoint,
    options: Omit<PlanningLoopOptions, 'parentRunId' | 'originalClarificationCallId'> = {}
  ): Promise<LocalFinalReport> {
    const currentSnapshot = `snap_${profile.metadata.version}`;
    if (checkpoint.snapshotVersion !== currentSnapshot || checkpoint.goalVersion !== goal.version) {
      throw new Error(
        `Checkpoint invalidated by data/goal update (expected ${checkpoint.snapshotVersion}/${checkpoint.goalVersion}, got ${currentSnapshot}/${goal.version})`
      );
    }

    // Rehydrate locally computed evaluations bound to the checkpointed run
    if (checkpoint.localEvaluations) {
      for (const [scId, calc] of Object.entries(checkpoint.localEvaluations)) {
        this.localEvaluations.set(scId, calc);
      }
    }

    if (checkpoint.sessionToken && this.transport.registerRunSession) {
      this.transport.registerRunSession(
        checkpoint.runId,
        checkpoint.sessionToken,
        checkpoint.lastSequenceNumber
      );
    }

    if (checkpoint.sessionToken && this.transport.registerRunSession && this.transport.getCheckpoint) {

      const serverState = await this.transport.getCheckpoint(checkpoint.runId, {
        signal: options.signal,
      });

      if (
        serverState &&
        (serverState.status === 'running' ||
          serverState.status === 'waiting_for_browser_tool' ||
          serverState.status === 'completed')
      ) {
        // Server session still alive -> direct authenticated reconnection without launching a new run!
        const candidateScenarios = generateCandidateScenarios(goal);
        const versionBinding: VersionBinding = {
          snapshotVersion: checkpoint.snapshotVersion,
          goalVersion: checkpoint.goalVersion,
          policyVersion: checkpoint.policyVersion ?? DEFAULT_POLICY_VERSION,
        };
        if (options.onRunCreated) {
          options.onRunCreated(checkpoint.runId, checkpoint.sessionToken);
        }
        // A received event is not necessarily an acknowledged tool action. Replay the
        // pending/terminal event when the page stopped between checkpoint and submission.
        const replayFrom = serverState.status === 'completed' ? 0 : serverState.pendingCallId
          ? Math.min(checkpoint.lastSequenceNumber, Math.max(0, (serverState.eventCount ?? checkpoint.lastSequenceNumber) - 1))
          : checkpoint.lastSequenceNumber;
        this.transport.registerRunSession(checkpoint.runId, checkpoint.sessionToken, replayFrom);
        return this.driveRunLoop(
          checkpoint.runId,
          checkpoint.sessionToken,
          profile,
          goal,
          candidateScenarios,
          versionBinding,
          replayFrom,
          options
        );
      }

      if (!serverState) {
        // Server lost state (restart or TTL expiry) — never silently pretend budget carried over! (R06)
        if (options.checkpointStore) {
          await options.checkpointStore.save({
            ...checkpoint,
            status: 'interrupted',
            hasUncertainSpend: true,
            updatedAt: new Date().toISOString(),
          });
        }
        if (!options.confirmRestartOnLostServerState) {
          throw new Error(
            'SERVER_SESSION_LOST: 服务端任务已过期或服务已重启，无法确认原预算余额。请明确确认后以全新分析重新规划。'
          );
        }
        return this.runPlanningLoop(profile, goal, {
          ...options,
          hasUncertainPriorSpend: true,
        });
      }
    }

    // Server session still exists in cancelled/clarifying continuation state -> link parentRunId
    return this.runPlanningLoop(profile, goal, {
      ...options,
      parentRunId: checkpoint.runId,
    });
  }

  /**
   * Starts a new planning run and executes the complete verified tool loop.
   */
  async runPlanningLoop(
    profile: UserProfile,
    goal: LargePurchaseGoal,
    options: PlanningLoopOptions = {}
  ): Promise<LocalFinalReport> {
    if (options.signal?.aborted) {
      throw new Error('Planning run aborted before start');
    }
    this.localEvaluations.clear();

    const candidateScenarios = generateCandidateScenarios(goal);
    const includeFamily =
      options.includeFamilySummary ?? this.gateway.hasScope('family_summary');
    const safeProfile = deriveSafeProfileSummary(profile, {
      includeFamilyBurden: includeFamily,
    });
    const safeGoal = deriveSafeGoalSummary(profile, goal);
    const snapshotVersion = `snap_${profile.metadata.version}`;
    const policyVersion = DEFAULT_POLICY_VERSION;
    const versionBinding: VersionBinding = {
      snapshotVersion,
      goalVersion: goal.version,
      policyVersion,
    };

    const rawRunRequest: RunRequest = {
      protocolVersion: '1.0',
      snapshotVersion,
      goalVersion: goal.version,
      policyVersion,
      candidateScenarios,
      safeProfileSummary: safeProfile,
      safeGoalSummary: safeGoal,
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.originalClarificationCallId
        ? { originalClarificationCallId: options.originalClarificationCallId }
        : {}),
    };

    const authorizedRunRequest = this.gateway.inspectAndAuthorizeRunRequest(
      rawRunRequest,
      this.targetProvider
    );

    const { runId, sessionToken } = await this.transport.createRun(authorizedRunRequest, {
      signal: options.signal,
    });
    if (options.onRunCreated) {
      options.onRunCreated(runId, sessionToken);
    }

    return this.driveRunLoop(
      runId,
      sessionToken,
      profile,
      goal,
      candidateScenarios,
      versionBinding,
      0,
      options
    );
  }

  private assertLiveVersionsUnchanged(
    expected: VersionBinding,
    options: PlanningLoopOptions
  ): void {
    if (!options.getCurrentVersions) return;
    const live = options.getCurrentVersions();
    if (live.snapshotVersion !== expected.snapshotVersion || live.goalVersion !== expected.goalVersion) {
      throw new Error(
        `VersionConflict (R14): 画像或目标在任务执行期间已变更（运行绑定 ${expected.snapshotVersion}/${expected.goalVersion}，当前为 ${live.snapshotVersion}/${live.goalVersion}），已终止使用旧运行结果`
      );
    }
  }

  private async driveRunLoop(
    runId: string,
    sessionToken: string | undefined,
    profile: UserProfile,
    goal: LargePurchaseGoal,
    candidateScenarios: SafeScenarioDescriptor[],
    versionBinding: VersionBinding,
    initialLastSeq: number,
    options: PlanningLoopOptions
  ): Promise<LocalFinalReport> {
    try {
      return await this.executeRunLoop(runId, sessionToken, profile, goal, candidateScenarios, versionBinding, initialLastSeq, options);
    } catch (error) {
      if (options.signal?.aborted) {
        // Cancellation is a separate request; never reuse the already-aborted signal.
        await this.transport.cancelRun(runId, 'client_aborted_or_locked').catch(() => undefined);
        this.clearSensitiveState();
      }
      throw error;
    }
  }

  private async executeRunLoop(
    runId: string,
    sessionToken: string | undefined,
    profile: UserProfile,
    goal: LargePurchaseGoal,
    candidateScenarios: SafeScenarioDescriptor[],
    versionBinding: VersionBinding,
    initialLastSeq: number,
    options: PlanningLoopOptions
  ): Promise<LocalFinalReport> {
    const saveCp = async (lastSeq: number, status: string) => {
      if (!options.checkpointStore) return;
      const evalObj: Record<string, ScenarioCalculationResult> = {};
      for (const [k, v] of this.localEvaluations.entries()) {
        evalObj[k] = v;
      }
      await options.checkpointStore.save({
        runId,
        goalId: goal.id,
        snapshotVersion: versionBinding.snapshotVersion,
        goalVersion: versionBinding.goalVersion,
        policyVersion: versionBinding.policyVersion,
        lastSequenceNumber: lastSeq,
        status,
        updatedAt: new Date().toISOString(),
        ...(sessionToken ? { sessionToken } : {}),
        candidateScenarioIds: candidateScenarios.map((s) => s.scenarioId),
        localEvaluations: evalObj,
        ...(options.hasUncertainPriorSpend ? { hasUncertainSpend: true } : {}),
      });
    };

    await saveCp(initialLastSeq, 'running');

    let isFinished = false;
    let verifiedAnalysis: VerifiedAnalysis | null = null;
    let lastProcessedSeq = initialLastSeq;

    while (!isFinished) {
      if (options.signal?.aborted) {
        await this.transport.cancelRun(runId, 'client_aborted_or_locked').catch(() => undefined);
        await saveCp(lastProcessedSeq, 'cancelled');
        throw new Error('Planning run aborted by client');
      }

      const events = await this.transport.fetchEvents(runId, { signal: options.signal });
      for (const rawEvent of events) {
        // R04: Strictly parse & validate every incoming event with Zod
        const event = AgentEventSchema.parse(rawEvent);
        if (event.runId !== runId) {
          throw new Error(`Cross-run event rejected: expected ${runId}, got ${event.runId}`);
        }
        if (event.sequenceNumber <= lastProcessedSeq) {
          continue;
        }
        lastProcessedSeq = event.sequenceNumber;

        if (options.onEvent) {
          options.onEvent(event);
        }

        if (event.type === 'tool_requested') {
          // R04: Validate toolRequest strictly with Zod & verify runId + versionBinding
          const toolReq = BrowserToolRequestSchema.parse(event.payload.toolRequest);
          if (toolReq.runId !== runId) {
            throw new Error(`Tool request runId mismatch: expected ${runId}, got ${toolReq.runId}`);
          }
          if (
            toolReq.versionBinding.snapshotVersion !== versionBinding.snapshotVersion ||
            toolReq.versionBinding.goalVersion !== versionBinding.goalVersion ||
            toolReq.versionBinding.policyVersion !== versionBinding.policyVersion
          ) {
            throw new Error(
              `VersionBinding mismatch on tool request: expected ${JSON.stringify(versionBinding)}, got ${JSON.stringify(toolReq.versionBinding)}`
            );
          }

          // R14: Check live browser store hasn't mutated underneath this in-flight run
          this.assertLiveVersionsUnchanged(versionBinding, options);

          if (toolReq.toolName === 'evaluate_scenario') {
            const scenarioId = toolReq.params.scenarioId;
            const scenario = candidateScenarios.find((s) => s.scenarioId === scenarioId);
            if (!scenario) {
              throw new Error(`Requested scenario ${scenarioId} not found in candidate list`);
            }

            const calc = evaluateScenarioLocal(profile, goal, scenario, toolReq.callId);
            this.localEvaluations.set(scenario.scenarioId, calc);

            const safeResult = toSafeToolResult(toolReq.callId, calc, versionBinding);
            const authorizedResult = this.gateway.inspectAndAuthorizeToolResult(
              safeResult,
              this.targetProvider
            );

            await saveCp(event.sequenceNumber - 1, 'waiting_for_browser_tool');
            await this.transport.submitToolResult(runId, authorizedResult, {
              signal: options.signal,
            });
          } else if (toolReq.toolName === 'request_clarification') {
            const fieldCategory =
              toolReq.params.fieldCategory ?? 'timing_flexibility_confirmation';

            if (options.clarificationHandler) {
              const res = await awaitWithAbort(options.clarificationHandler(toolReq), options.signal);
              if (options.signal?.aborted) {
                await this.transport.cancelRun(runId, 'aborted_during_clarification').catch(() => undefined);
                throw new Error('Planning run aborted during clarification');
              }

              if (res.action === 'modify_input' && (res.updatedGoal || res.updatedProfile)) {
                const nextProfile = res.updatedProfile ?? profile;
                const nextGoal = res.updatedGoal ?? goal;
                this.localEvaluations.clear();
                await this.transport.cancelRun(runId, 'input_updated');
                await saveCp(event.sequenceNumber, 'cancelled');
                return this.runPlanningLoop(nextProfile, nextGoal, {
                  ...options,
                  parentRunId: runId,
                  originalClarificationCallId: toolReq.callId,
                });
              } else if (res.action === 'decline') {
                const refusedClarification = {
                  callId: toolReq.callId,
                  toolName: 'request_clarification' as const,
                  fieldCategory,
                  status: 'user_refused' as const,
                  evidenceId: `ev_refused_${toolReq.callId}`,
                  rejectionCategory: res.rejectionCategory ?? ('user_declined_clarification' as const),
                  versionBinding,
                };
                const authorizedResult = this.gateway.inspectAndAuthorizeToolResult(
                  refusedClarification,
                  this.targetProvider
                );
                await saveCp(event.sequenceNumber - 1, 'waiting_for_browser_tool');
                await this.transport.submitToolResult(runId, authorizedResult, {
                  signal: options.signal,
                });
              } else {
                const safeClarification = {
                  callId: toolReq.callId,
                  toolName: 'request_clarification' as const,
                  fieldCategory,
                  status: 'satisfied' as const,
                  evidenceId: `ev_clarify_${toolReq.callId}`,
                  clarificationChoice: res.clarificationChoice ?? ('user_confirmed' as const),
                  versionBinding,
                };
                const authorizedResult = this.gateway.inspectAndAuthorizeToolResult(
                  safeClarification,
                  this.targetProvider
                );
                await saveCp(event.sequenceNumber - 1, 'waiting_for_browser_tool');
                await this.transport.submitToolResult(runId, authorizedResult, {
                  signal: options.signal,
                });
              }
            } else {
              // Non-interactive structured default fallback (only closed enum)
              const safeClarification = {
                callId: toolReq.callId,
                toolName: 'request_clarification' as const,
                fieldCategory,
                status: 'satisfied' as const,
                evidenceId: `ev_clarify_${toolReq.callId}`,
                clarificationChoice: 'user_confirmed' as const,
                versionBinding,
              };
              const authorizedResult = this.gateway.inspectAndAuthorizeToolResult(
                safeClarification,
                this.targetProvider
              );
              await saveCp(event.sequenceNumber - 1, 'waiting_for_browser_tool');
              await this.transport.submitToolResult(runId, authorizedResult, {
                signal: options.signal,
              });
            }
          }
        } else if (event.type === 'completed') {
          const parsedAnalysis = VerifiedAnalysisSchema.parse(event.payload.verifiedAnalysis);
          if (parsedAnalysis.runId !== runId) {
            throw new Error(
              `Cross-run analysis rejected: expected ${runId}, got ${parsedAnalysis.runId}`
            );
          }
          // R14: Refuse accepting completion if profile/goal changed while run was in-flight
          this.assertLiveVersionsUnchanged(versionBinding, options);
          verifiedAnalysis = parsedAnalysis;
          await saveCp(event.sequenceNumber, 'completed');
          isFinished = true;
          break;
        } else if (event.type === 'failed') {
          await saveCp(event.sequenceNumber, 'failed');
          throw new Error(`Agent run failed: ${JSON.stringify(event.payload)}`);
        } else if (event.type === 'cancelled' || event.type === 'interrupted') {
          await saveCp(event.sequenceNumber, event.type);
          throw new Error(`Agent run was ${event.type}: ${JSON.stringify(event.payload)}`);
        }
      }

      if (!isFinished) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (!verifiedAnalysis) {
      throw new Error('Run completed without verified analysis');
    }

    // 5. Client-Side Verification (A-03 / H-07 / R09 / R10)
    const localCalc = this.localEvaluations.get(verifiedAnalysis.selectedScenarioId);
    if (!localCalc) {
      throw new Error(
        `Security Exception: Analysis references uncalculated scenario: ${verifiedAnalysis.selectedScenarioId}`
      );
    }

    if (localCalc.evidenceId !== verifiedAnalysis.evidenceId) {
      throw new Error(
        `Security Exception (A-03): Hallucinated evidence ID detected! Local: ${localCalc.evidenceId}, Received: ${verifiedAnalysis.evidenceId}`
      );
    }

    if ((!localCalc.isSatisfied || !localCalc.isReliable) && verifiedAnalysis.verdict === 'viable') {
      throw new Error(
        'Security Exception (A-03 / R09): Contradictory recommendation! Local calculation is unsatisfied or unreliable, but model reported viable.'
      );
    }

    return {
      runId,
      verdict: verifiedAnalysis.verdict,
      tradeOffSummary: sanitizeUntrustedText(verifiedAnalysis.tradeOffSummary),
      selectedScenarioId: verifiedAnalysis.selectedScenarioId,
      evidenceId: verifiedAnalysis.evidenceId,
      exactTargetAmount: localCalc.targetAmount,
      exactEndingCash: localCalc.projectedEndingCash,
      exactMinimumCash: localCalc.minimumProjectedCash,
      exactDeficit: localCalc.cashDeficit,
      assumptionsUsed: verifiedAnalysis.assumptionsUsed.map((a) => sanitizeUntrustedText(a)),
      isVerified: true,
      generatedAt: new Date().toISOString(),
      snapshotVersion: versionBinding.snapshotVersion,
      goalVersion: versionBinding.goalVersion,
      candidateScenarioIds: candidateScenarios.map((s) => s.scenarioId),
      intraMonthLiquidityStatus: localCalc.intraMonthLiquidityStatus,
      ...(options.hasUncertainPriorSpend ? { hasUncertainPriorSpend: true } : {}),
    };
  }

  /**
   * R01 / P-03 / R14: Post-report structured follow-up intent.
   * Blocks free-text questions, verifies report freshness against live versions,
   * and validates returned evidenceId citation + P-08 sanitization.
   */
  async askFollowUp(
    profile: UserProfile,
    report: LocalFinalReport,
    followUpRequest: FollowUpRequest,
    liveGoalVersion?: string
  ): Promise<FollowUpResponse> {
    if (!this.transport.sendFollowUp) {
      throw new Error('Transport does not support follow-up conversation');
    }

    // R14: Reject follow-ups against stale reports whose profile/goal changed
    const currentSnap = `snap_${profile.metadata.version}`;
    if (
      report.snapshotVersion !== currentSnap ||
      (liveGoalVersion !== undefined && report.goalVersion !== liveGoalVersion)
    ) {
      throw new Error(
        'ReportStaleError (R14): 当前画像或目标版本已更新，请重新评估生成新报告后再进行追问'
      );
    }

    const authorizedReq = this.gateway.inspectAndAuthorizeFollowUp(
      {
        ...followUpRequest,
        selectedScenarioId: followUpRequest.selectedScenarioId ?? report.selectedScenarioId,
      },
      this.targetProvider,
      report.candidateScenarioIds
    );

    const res = await this.transport.sendFollowUp(report.runId, authorizedReq);
    if (res.citedEvidenceId !== report.evidenceId) {
      throw new Error(
        `Security Exception (A-03): Follow-up cited unverified evidenceId ${res.citedEvidenceId} (expected ${report.evidenceId})`
      );
    }

    return {
      ...res,
      answer: sanitizeUntrustedText(res.answer),
      limitationsNoted: res.limitationsNoted.map((l) => sanitizeUntrustedText(l)),
    };
  }
}
