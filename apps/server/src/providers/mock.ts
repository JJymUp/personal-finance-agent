import { sanitizeUntrustedText, type FollowUpIntent } from '@maggot/contracts';
import type {
  ModelProvider,
  ModelStepInput,
  ModelStepOutput,
  FollowUpInput,
  FollowUpOutput,
} from './types.js';

const FOLLOWUP_INTENT_LABELS: Record<FollowUpIntent, string> = {
  explain_verdict_and_risk: 'verdict and primary liquidity risk',
  compare_candidate_scenarios: 'comparison across evaluated candidate scenarios',
  explain_cash_buffer_impact: 'minimum cash buffer headroom and trajectory impact',
  how_to_improve_feasibility: 'actionable adjustments to improve feasibility',
  clarify_key_assumptions: 'key assumptions and data completeness constraints',
  impact_of_delaying_goal: 'effect of extending the target horizon (if allowed)',
  impact_of_reducing_target: 'effect of scaling down the target amount',
  debt_priority_guidance: 'balancing debt obligations alongside the goal',
};

export interface MockProviderOptions {
  behavior?:
    | 'standard'
    | 'request_clarification_first'
    | 'hallucinate_fake_evidence'
    | 'fail_step'
    | 'unsafe_markup_output';
}

export class MockModelProvider implements ModelProvider {
  name = 'mock_provider';
  private behavior: NonNullable<MockProviderOptions['behavior']>;

  constructor(options: MockProviderOptions = {}) {
    this.behavior = options.behavior ?? 'standard';
  }

  setBehavior(behavior: NonNullable<MockProviderOptions['behavior']>): void {
    this.behavior = behavior;
  }

  async generateStep(input: ModelStepInput): Promise<ModelStepOutput> {
    if (this.behavior === 'fail_step') {
      return {
        type: 'error',
        code: 'MODEL_INFERENCE_FAILED',
        message: 'Simulated model failure for robustness testing',
      };
    }

    if (this.behavior === 'request_clarification_first' && input.toolHistory.length === 0) {
      // Once clarification is requested, transition subsequent steps/runs to standard
      this.behavior = 'standard';
      return {
        type: 'request_tool',
        toolRequest: {
          toolName: 'request_clarification',
          params: {
            fieldCategory: 'timing_flexibility_confirmation',
          },
        },
        reasoning: 'Need to clarify timing flexibility before evaluating delayed purchase options',
      };
    }

    // Standard flow:
    // 1. If no tool evaluated yet, request evaluation of the first candidate scenario (original plan)
    if (input.toolHistory.length === 0) {
      const origScenario =
        input.candidateScenarios.find((s) => s.scenarioKind === 'original_plan') ??
        input.candidateScenarios[0];
      return {
        type: 'request_tool',
        toolRequest: {
          toolName: 'evaluate_scenario',
          params: {
            scenarioId: origScenario.scenarioId,
          },
        },
        reasoning: 'Evaluating baseline feasibility of original purchase plan against local cash buffer',
      };
    }

    // 2. Check last tool result
    const lastTool = input.toolHistory[input.toolHistory.length - 1];
    const hasRefusedClarification = input.toolHistory.some(
      (t) =>
        t.request.toolName === 'request_clarification' && t.result?.status === 'user_refused'
    );

    if (lastTool.request.toolName === 'evaluate_scenario' && lastTool.result) {
      const lastStatus = lastTool.result.status;
      const lastScenarioId = lastTool.request.params.scenarioId;

      const evaluatedCount = input.toolHistory.filter(
        (t) => t.request.toolName === 'evaluate_scenario'
      ).length;

      // If original plan was violated and an alternative scenario exists, try alternative
      if (lastStatus === 'violated' && evaluatedCount === 1) {
        const altScenario = input.candidateScenarios.find((s) => s.scenarioId !== lastScenarioId);
        if (altScenario) {
          return {
            type: 'request_tool',
            toolRequest: {
              toolName: 'evaluate_scenario',
              params: {
                scenarioId: altScenario.scenarioId,
              },
            },
            reasoning: 'Original plan breaches cash buffer; evaluating alternative adjustment scenario',
          };
        }
      }

      // Finish and return verified analysis referencing actual evidence ID
      const chosenScenarioId = lastScenarioId!;
      let evidenceId = lastTool.result.evidenceId;

      if (this.behavior === 'hallucinate_fake_evidence') {
        // Deliberately hallucinate a non-existent evidence ID to test client-side verification
        evidenceId = 'ev_HALLUCINATED_FAKE_123';
      }

      const isEvaluatedReliable =
        lastTool.result.toolName === 'evaluate_scenario' ? lastTool.result.isReliable : false;
      const verdict =
        lastStatus === 'satisfied' && isEvaluatedReliable ? 'viable' : 'caution';
      let tradeOffSummary =
        verdict === 'viable'
          ? 'Based on verified local cashflow, this scenario preserves your required cash buffer.'
          : lastStatus === 'unknown' || !isEvaluatedReliable
            ? 'Insufficient or partially modeled financial inputs; treat projection as tentative until missing items are confirmed.'
            : 'Based on verified local cashflow, this scenario experiences a temporary cash deficit.';

      if (this.behavior === 'unsafe_markup_output') {
        tradeOffSummary =
          'Result <script>alert(1)</script> ![track](https://evil.example/px.png) preserves buffer [click](https://evil.example/phish)';
      }

      const assumptionsUsed = [
        'Fixed monthly savings rate',
        'No additional unscheduled debt incurred',
      ];
      if (!isEvaluatedReliable || lastStatus === 'unknown') {
        assumptionsUsed.push('Contains incomplete/unmodeled cashflow or schedule inputs');
      }
      if (hasRefusedClarification) {
        assumptionsUsed.push(
          'User declined optional clarification; analysis reflects bounded assumptions only'
        );
      }

      return {
        type: 'complete',
        modelAttempts: 1,
        analysis: {
          runId: input.runId,
          selectedScenarioId: chosenScenarioId,
          evidenceId,
          verdict,
          tradeOffSummary: sanitizeUntrustedText(tradeOffSummary),
          assumptionsUsed,
          recommendationTier: verdict === 'viable' ? 'recommended' : 'alternative',
        },
      };
    }

    // Fallback if last tool was clarification (including user_refused!)
    if (lastTool.request.toolName === 'request_clarification') {
      const nextScenario = input.candidateScenarios[0];
      const wasRefused = lastTool.result?.status === 'user_refused';
      return {
        type: 'request_tool',
        modelAttempts: 1,
        toolRequest: {
          toolName: 'evaluate_scenario',
          params: {
            scenarioId: nextScenario.scenarioId,
          },
        },
        reasoning: wasRefused
          ? 'User declined clarification; proceeding with baseline scenario using conservative assumptions'
          : 'Clarification received, now evaluating scenario',
      };
    }

    return {
      type: 'error',
      modelAttempts: 1,
      code: 'UNEXPECTED_AGENT_STATE',
      message: 'Agent reached an unhandled tool loop state',
    };
  }

  async answerFollowUp(input: FollowUpInput): Promise<FollowUpOutput> {
    const topic = FOLLOWUP_INTENT_LABELS[input.intent] ?? input.intent;
    const verdictNote =
      input.analysis.verdict === 'viable'
        ? 'the selected plan remains within your local reserve floor based on verified calculations'
        : 'the selected plan involves a constraint risk or unmodeled inputs and warrants caution';

    return {
      type: 'ok',
      modelAttempts: 1,
      response: {
        runId: input.runId,
        answer: sanitizeUntrustedText(
          `Regarding ${topic}: ${verdictNote}. Key trade-off: ${input.analysis.tradeOffSummary} (Only controlled qualitative summaries and structured intents are visible on the server; exact balances remain strictly on your device.)`
        ),
        citedEvidenceId: input.analysis.evidenceId,
        limitationsNoted: [
          'Server follow-up accepts structured intents and bucketed summaries only, never exact amounts.',
          ...input.analysis.assumptionsUsed.slice(0, 2),
        ],
      },
    };
  }
}
