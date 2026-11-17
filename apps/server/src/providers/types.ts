import type {
  SafeProfileSummary,
  SafeGoalSummary,
  SafeScenarioDescriptor,
  SafeToolResult,
  VerifiedAnalysis,
  BrowserToolRequest,
  FollowUpResponse,
  FollowUpIntent,
} from '@maggot/contracts';

export interface ModelStepInput {
  runId: string;
  stepNumber: number;
  safeProfileSummary: SafeProfileSummary;
  safeGoalSummary: SafeGoalSummary;
  candidateScenarios: SafeScenarioDescriptor[];
  toolHistory: Array<{
    request: BrowserToolRequest;
    result?: SafeToolResult;
  }>;
  signal?: AbortSignal;
  /** Reserves one additional actual request before a retry; false means budget exhausted. */
  reserveRetry?: () => boolean;
}

export interface FollowUpInput {
  runId: string;
  intent: FollowUpIntent;
  selectedScenarioId?: string;
  focusScenarioId?: string;
  safeProfileSummary: SafeProfileSummary;
  safeGoalSummary: SafeGoalSummary;
  candidateScenarios?: SafeScenarioDescriptor[];
  analysis: VerifiedAnalysis;
  toolHistory: Array<{
    request: BrowserToolRequest;
    result?: SafeToolResult;
  }>;
  priorFollowUps: Array<{ intent: FollowUpIntent; answer: string }>;
  signal?: AbortSignal;
  /** Reserves one additional actual request before a retry; false means budget exhausted. */
  reserveRetry?: () => boolean;
}

export type FollowUpOutput =
  | {
      type: 'ok';
      response: FollowUpResponse;
      usage?: { promptTokens: number; completionTokens: number };
      modelAttempts?: number;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      modelAttempts?: number;
    };

export type ModelStepOutput =
  | {
      type: 'request_tool';
      toolRequest: {
        toolName: 'evaluate_scenario' | 'request_clarification';
        params: {
          scenarioId?: string;
          fieldCategory?:
            | 'family_burden_confirmation'
            | 'timing_flexibility_confirmation'
            | 'expense_refinement'
            | 'income_variability_detail';
        };
      };
      reasoning: string;
      usage?: { promptTokens: number; completionTokens: number };
      modelAttempts?: number;
    }
  | {
      type: 'complete';
      analysis: VerifiedAnalysis;
      usage?: { promptTokens: number; completionTokens: number };
      modelAttempts?: number;
    }
  | {
      type: 'error';
      message: string;
      code: string;
      modelAttempts?: number;
    };

export interface ModelProvider {
  name: string;
  generateStep(input: ModelStepInput): Promise<ModelStepOutput>;
  answerFollowUp?(input: FollowUpInput): Promise<FollowUpOutput>;
}
