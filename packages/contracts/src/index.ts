import { z } from 'zod';

// ==========================================
// 1. Safe Profile Summary Schemas (Closed, Bucketed)
// ==========================================

export const IncomeStabilitySchema = z.enum(['stable', 'variable', 'unknown']);
export type IncomeStability = z.infer<typeof IncomeStabilitySchema>;

export const ExpenseShareBucketSchema = z.enum([
  '0_20_pct',
  '20_30_pct',
  '30_40_pct',
  '40_50_pct',
  '50_60_pct',
  '60_plus_pct',
  'zero_expenses',
  'unknown',
]);
export type ExpenseShareBucket = z.infer<typeof ExpenseShareBucketSchema>;

export const DebtServiceShareBucketSchema = z.enum([
  'no_debt',
  '0_10_pct',
  '10_20_pct',
  '20_30_pct',
  '30_40_pct',
  '40_plus_pct',
  'unknown',
]);
export type DebtServiceShareBucket = z.infer<typeof DebtServiceShareBucketSchema>;

export const CashRunwayBucketSchema = z.enum([
  'less_than_1_month',
  '1_3_months',
  '3_6_months',
  '6_12_months',
  '12_plus_months',
  'unknown',
]);
export type CashRunwayBucket = z.infer<typeof CashRunwayBucketSchema>;

export const DataCompletenessSchema = z.enum([
  'draft',
  'user_confirmed_partial',
  'user_confirmed_complete',
]);
export type DataCompleteness = z.infer<typeof DataCompletenessSchema>;

export const DataFreshnessSchema = z.enum([
  'within_7_days',
  'within_30_days',
  'older_than_30_days',
  'unknown',
]);
export type DataFreshness = z.infer<typeof DataFreshnessSchema>;

export const FamilyBurdenCategorySchema = z.enum([
  'none',
  'childcare_support',
  'elderly_support',
  'shared_household',
  'unknown',
]);
export type FamilyBurdenCategory = z.infer<typeof FamilyBurdenCategorySchema>;

export const SafeProfileSummarySchema = z
  .object({
    income_stability: IncomeStabilitySchema,
    essential_expense_share: ExpenseShareBucketSchema,
    debt_service_share: DebtServiceShareBucketSchema,
    cash_runway: CashRunwayBucketSchema,
    family_burden_category: FamilyBurdenCategorySchema.optional(),
    data_quality: z
      .object({
        completeness: DataCompletenessSchema,
        freshness: DataFreshnessSchema,
      })
      .strict(),
  })
  .strict();
export type SafeProfileSummary = z.infer<typeof SafeProfileSummarySchema>;

// ==========================================
// 2. Goal Summary Schemas (Closed, Bucketed)
// ==========================================

export const GoalTaskTypeSchema = z.enum([
  'large_purchase',
  'income_reduction',
  'savings_goal',
]);
export type GoalTaskType = z.infer<typeof GoalTaskTypeSchema>;

export const GoalHorizonBucketSchema = z.enum([
  'immediate_within_1_month',
  '1_3_months',
  '3_6_months',
  '6_12_months',
  '12_24_months',
  '24_plus_months',
  'unknown',
]);
export type GoalHorizonBucket = z.infer<typeof GoalHorizonBucketSchema>;

export const CostInSurplusBucketSchema = z.enum([
  'within_3_months',
  '3_6_months',
  '6_12_months',
  '12_24_months',
  '24_plus_months',
  'negative_surplus',
  'unknown',
]);
export type CostInSurplusBucket = z.infer<typeof CostInSurplusBucketSchema>;

export const TimingFlexibilitySchema = z.enum(['fixed', 'flexible', 'unknown']);
export type TimingFlexibility = z.infer<typeof TimingFlexibilitySchema>;

export const SafeGoalSummarySchema = z
  .object({
    task_type: GoalTaskTypeSchema,
    horizon: GoalHorizonBucketSchema,
    cost_in_monthly_surplus: CostInSurplusBucketSchema,
    timing_flexibility: TimingFlexibilitySchema,
  })
  .strict();
export type SafeGoalSummary = z.infer<typeof SafeGoalSummarySchema>;

// ==========================================
// 3. Candidate Scenario Descriptors
// ==========================================

export const ScenarioKindSchema = z.enum([
  'original_plan',
  'reduced_budget',
  'delayed_timing',
  'conservative_buffer',
]);
export type ScenarioKind = z.infer<typeof ScenarioKindSchema>;

export const AdjustmentTierSchema = z.enum([
  'none',
  'minor_10_pct',
  'moderate_20_pct',
  'major_30_pct',
  'delay_3_months',
  'delay_6_months',
  'delay_12_months',
]);
export type AdjustmentTier = z.infer<typeof AdjustmentTierSchema>;

export const AssumptionCategorySchema = z.enum([
  'baseline',
  'cost_reduction',
  'schedule_extension',
  'cash_buffer',
]);
export type AssumptionCategory = z.infer<typeof AssumptionCategorySchema>;

export const SafeScenarioDescriptorSchema = z
  .object({
    scenarioId: z.string().min(1).max(64),
    scenarioKind: ScenarioKindSchema,
    adjustmentTier: AdjustmentTierSchema,
    assumptionCategory: AssumptionCategorySchema,
    assumptionVersion: z.string().min(1).max(32),
  })
  .strict();
export type SafeScenarioDescriptor = z.infer<typeof SafeScenarioDescriptorSchema>;

// ==========================================
// 4. Browser Tool Protocol (Request / Result)
// ==========================================

export const ClarificationFieldCategorySchema = z.enum([
  'family_burden_confirmation',
  'timing_flexibility_confirmation',
  'expense_refinement',
  'income_variability_detail',
]);
export type ClarificationFieldCategory = z.infer<typeof ClarificationFieldCategorySchema>;

export const ToolNameSchema = z.enum([
  'evaluate_scenario',
  'request_clarification',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const AuthorizationScopeNameSchema = z.enum([
  'profile_summary',
  'family_summary',
  'goal_summary',
  'scenarios',
  'clarification',
  'follow_up',
]);
export type AuthorizationScopeName = z.infer<typeof AuthorizationScopeNameSchema>;

export const VersionBindingSchema = z
  .object({
    snapshotVersion: z.string().min(1).max(32),
    goalVersion: z.string().min(1).max(32),
    policyVersion: z.string().min(1).max(32),
  })
  .strict();
export type VersionBinding = z.infer<typeof VersionBindingSchema>;

export const BrowserToolRequestSchema = z
  .object({
    runId: z.string().min(1).max(64),
    callId: z.string().min(1).max(64),
    toolName: ToolNameSchema,
    params: z
      .object({
        scenarioId: z.string().min(1).max(64).optional(),
        fieldCategory: ClarificationFieldCategorySchema.optional(),
      })
      .strict(),
    versionBinding: VersionBindingSchema,
  })
  .strict();
export type BrowserToolRequest = z.infer<typeof BrowserToolRequestSchema>;

export const ToolResultStatusSchema = z.enum([
  'satisfied',
  'violated',
  'unknown',
  'user_refused',
]);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

export const GapHorizonBucketSchema = z.enum([
  'none',
  'immediate',
  '1_3_months',
  '3_6_months',
  '6_12_months',
  '12_plus_months',
]);
export type GapHorizonBucket = z.infer<typeof GapHorizonBucketSchema>;

/** Closed enum choices for structured privacy-safe clarifications (zero free text — R01) */
export const ClarificationChoiceSchema = z.enum([
  'timing_flexible',
  'timing_fixed',
  'family_none',
  'family_shared_household',
  'family_childcare_support',
  'family_elderly_support',
  'expense_confirmed_accurate',
  'expense_includes_debt_adjusted',
  'income_moderately_variable',
  'income_highly_variable',
  'user_updated_profile',
  'user_confirmed',
]);
export type ClarificationChoice = z.infer<typeof ClarificationChoiceSchema>;

/** Closed enum categories for clarification refusals (zero free text — R01) */
export const RejectionCategorySchema = z.enum([
  'prefer_not_to_share_family',
  'prefer_not_to_share_flexibility',
  'prefer_not_to_refine_expense',
  'prefer_not_to_share_income_detail',
  'user_declined_clarification',
]);
export type RejectionCategory = z.infer<typeof RejectionCategorySchema>;

export const EvaluateScenarioToolResultSchema = z
  .object({
    callId: z.string().min(1).max(64),
    toolName: z.literal('evaluate_scenario'),
    scenarioId: z.string().min(1).max(64),
    status: z.enum(['satisfied', 'violated', 'unknown']),
    gapHorizon: GapHorizonBucketSchema.optional(),
    isReliable: z.boolean(),
    missingFieldCategory: ClarificationFieldCategorySchema.optional(),
    evidenceId: z.string().min(1).max(128),
    versionBinding: VersionBindingSchema,
  })
  .strict();

export const RequestClarificationToolResultSchema = z
  .object({
    callId: z.string().min(1).max(64),
    toolName: z.literal('request_clarification'),
    fieldCategory: ClarificationFieldCategorySchema,
    status: z.enum(['satisfied', 'unknown', 'user_refused']),
    clarificationChoice: ClarificationChoiceSchema.optional(),
    rejectionCategory: RejectionCategorySchema.optional(),
    evidenceId: z.string().min(1).max(128),
    versionBinding: VersionBindingSchema,
  })
  .strict();

/** Discriminated union bound by toolName & versionBinding (R01 / R04 / P-02) */
export const SafeToolResultSchema = z
  .discriminatedUnion('toolName', [
    EvaluateScenarioToolResultSchema,
    RequestClarificationToolResultSchema,
  ])
  .superRefine((val, ctx) => {
    if (val.toolName === 'request_clarification') {
      if (val.status === 'user_refused' && !val.rejectionCategory) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'rejectionCategory is required when clarification status is user_refused',
        });
      }
      if (val.status === 'user_refused' && val.clarificationChoice) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'clarificationChoice must be omitted when clarification is refused',
        });
      }
      if (val.status === 'satisfied' && !val.clarificationChoice) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'clarificationChoice is required when clarification status is satisfied',
        });
      }
    }
  });
export type SafeToolResult = z.infer<typeof SafeToolResultSchema>;

// ==========================================
// 5. Run Lifecycle & Requests
// ==========================================

export const AgentStatusSchema = z.enum([
  'created',
  'running',
  'waiting_for_browser_tool',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Server-generated runId only — client cannot specify or overwrite runId (R02) */
export const RunRequestSchema = z
  .object({
    protocolVersion: z.literal('1.0'),
    snapshotVersion: z.string().min(1).max(32),
    goalVersion: z.string().min(1).max(32),
    policyVersion: z.string().min(1).max(32),
    candidateScenarios: z.array(SafeScenarioDescriptorSchema).min(1).max(3),
    safeProfileSummary: SafeProfileSummarySchema,
    safeGoalSummary: SafeGoalSummarySchema,
    parentRunId: z.string().min(1).max(64).optional(),
    originalClarificationCallId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;

// ==========================================
// 6. Verified Analysis & Agent Events
// ==========================================

export const VerifiedAnalysisSchema = z
  .object({
    runId: z.string().min(1).max(64),
    selectedScenarioId: z.string().min(1).max(64),
    evidenceId: z.string().min(1).max(128),
    verdict: z.enum(['viable', 'caution', 'not_viable']),
    tradeOffSummary: z.string().min(1).max(512),
    assumptionsUsed: z.array(z.string().max(128)).max(10),
    recommendationTier: z.enum(['recommended', 'alternative', 'rejected']),
  })
  .strict();
export type VerifiedAnalysis = z.infer<typeof VerifiedAnalysisSchema>;

export const AgentEventTypeSchema = z.enum([
  'status_changed',
  'tool_requested',
  'analysis_chunk',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const AgentEventSchema = z
  .object({
    runId: z.string().min(1).max(64),
    sequenceNumber: z.number().int().positive(),
    timestamp: z.number().int().positive(),
    type: AgentEventTypeSchema,
    payload: z.record(z.unknown()),
  })
  .strict();
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// ==========================================
// 7. Post-Report Controlled Follow-up (R01 / P-03)
// ==========================================

/** Closed enum of post-report follow-up intents — zero arbitrary free-text outbound (R01) */
export const FollowUpIntentSchema = z.enum([
  'explain_verdict_and_risk',
  'compare_candidate_scenarios',
  'explain_cash_buffer_impact',
  'how_to_improve_feasibility',
  'clarify_key_assumptions',
  'impact_of_delaying_goal',
  'impact_of_reducing_target',
  'debt_priority_guidance',
]);
export type FollowUpIntent = z.infer<typeof FollowUpIntentSchema>;

export const SAFE_SCENARIO_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const FollowUpRequestSchema = z
  .object({
    intent: FollowUpIntentSchema,
    selectedScenarioId: z.string().regex(SAFE_SCENARIO_ID_RE).optional(),
    focusScenarioId: z.string().regex(SAFE_SCENARIO_ID_RE).optional(),
  })
  .strict();
export type FollowUpRequest = z.infer<typeof FollowUpRequestSchema>;

export const FollowUpResponseSchema = z
  .object({
    runId: z.string().min(1).max(64),
    answer: z.string().min(1).max(1500),
    citedEvidenceId: z.string().min(1).max(128),
    limitationsNoted: z.array(z.string().max(160)).max(5),
  })
  .strict();
export type FollowUpResponse = z.infer<typeof FollowUpResponseSchema>;

// ==========================================
// 8. P-08 Output Sanitizer
// ==========================================

const SCRIPT_TAG_RE = /<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)]+)\s*\)/g;
const MD_REMOTE_LINK_RE = /\[([^\]]+)\]\(\s*(https?:\/\/[^)\s]+|javascript:[^)]+|data:[^)]+)\s*\)/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()]+/gi;
const DANGEROUS_SCHEME_RE = /(?:javascript|vbscript|data):/gi;

const HAS_SCRIPT_RE = /<\s*script[^>]*>/i;
const HAS_HTML_RE = /<\/?[a-z][^>]*>/i;
const HAS_MD_IMAGE_RE = /!\[[^\]]*\]\(\s*[^)]+\s*\)/;
const HAS_BARE_URL_RE = /\bhttps?:\/\/[^\s<>()]+/i;
const HAS_DANGEROUS_SCHEME_RE = /(?:javascript|vbscript|data):/i;

export function hasDangerousMarkup(text: string): boolean {
  return (
    HAS_SCRIPT_RE.test(text) ||
    HAS_HTML_RE.test(text) ||
    HAS_MD_IMAGE_RE.test(text) ||
    HAS_BARE_URL_RE.test(text) ||
    HAS_DANGEROUS_SCHEME_RE.test(text)
  );
}

export function sanitizeUntrustedText(text: string): string {
  return text
    .replace(SCRIPT_TAG_RE, '')
    .replace(MD_IMAGE_RE, (_m, alt: string) =>
      alt ? `[image blocked: ${alt.trim()}]` : '[image blocked]'
    )
    .replace(MD_REMOTE_LINK_RE, (_m, label: string) => `${label} [external link blocked]`)
    .replace(HTML_TAG_RE, '')
    .replace(DANGEROUS_SCHEME_RE, '[blocked-scheme]:')
    .replace(BARE_URL_RE, '[external url blocked]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
