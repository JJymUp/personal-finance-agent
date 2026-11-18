import type { UserProfile } from '../../features/profile/types.js';
import type { LargePurchaseGoal } from '../finance/calculator.js';
import { calculateMonthlySurplus } from '../finance/calculator.js';
import {
  SafeProfileSummarySchema,
  SafeGoalSummarySchema,
  type SafeProfileSummary,
  type SafeGoalSummary,
  type ExpenseShareBucket,
  type DebtServiceShareBucket,
  type CashRunwayBucket,
  type GoalHorizonBucket,
  type CostInSurplusBucket,
  type FamilyBurdenCategory,
} from '@maggot/contracts';

export interface SafeSummaryOptions {
  /** R03: Family burden is omitted by default unless explicitly authorized & requested */
  includeFamilyBurden?: boolean;
  /** Reference date used to compute freshness bucket (defaults to now) */
  referenceDate?: string | Date;
}

function computeFreshnessBucket(
  dataDateStr: string | undefined,
  referenceDate?: string | Date
): SafeProfileSummary['data_quality']['freshness'] {
  if (!dataDateStr) return 'unknown';
  const parsed = Date.parse(dataDateStr.length === 10 ? `${dataDateStr}T00:00:00Z` : dataDateStr);
  if (Number.isNaN(parsed)) return 'unknown';

  const refMs =
    referenceDate instanceof Date
      ? referenceDate.getTime()
      : referenceDate
        ? Date.parse(referenceDate)
        : Date.now();
  const safeRefMs = Number.isNaN(refMs) ? Date.now() : refMs;
  const ageDays = Math.max(0, (safeRefMs - parsed) / (24 * 60 * 60 * 1000));

  if (ageDays <= 7) return 'within_7_days';
  if (ageDays <= 30) return 'within_30_days';
  return 'older_than_30_days';
}

/**
 * Derives a SafeProfileSummary strictly using bucketed intervals.
 * Zero exact amounts, zero account IDs, zero nicknames.
 */
export function deriveSafeProfileSummary(
  profile: UserProfile,
  options: SafeSummaryOptions = {}
): SafeProfileSummary {
  const surplus = calculateMonthlySurplus(profile);
  const { monthlyIncome, monthlyExpenses, monthlyDebtService, isReliable } = surplus;
  const hasKnownIncome =
    profile.monthlyIncome !== undefined &&
    profile.monthlyIncome.status !== 'unknown' &&
    profile.monthlyIncome.amount !== undefined;
  const hasKnownExpenses =
    profile.essentialExpenses !== undefined &&
    profile.essentialExpenses.amount !== undefined;

  // 1. Income Stability
  let incomeStability: SafeProfileSummary['income_stability'] = 'unknown';
  if (profile.monthlyIncome?.status === 'fixed') {
    incomeStability = 'stable';
  } else if (profile.monthlyIncome?.status === 'variable') {
    incomeStability = 'variable';
  }

  // 2. Essential Expense Share Bucket
  let expenseShare: ExpenseShareBucket = 'unknown';
  if (hasKnownIncome && hasKnownExpenses && monthlyIncome > 0) {
    if (monthlyExpenses === 0) {
      expenseShare = 'zero_expenses';
    } else {
      const ratio = monthlyExpenses / monthlyIncome;
      if (ratio <= 0.2) expenseShare = '0_20_pct';
      else if (ratio <= 0.3) expenseShare = '20_30_pct';
      else if (ratio <= 0.4) expenseShare = '30_40_pct';
      else if (ratio <= 0.5) expenseShare = '40_50_pct';
      else if (ratio <= 0.6) expenseShare = '50_60_pct';
      else expenseShare = '60_plus_pct';
    }
  }

  // 3. Debt Service Share Bucket
  let debtShare: DebtServiceShareBucket = 'unknown';
  if (profile.debtStatus === 'unknown') {
    debtShare = 'unknown';
  } else if (profile.debtStatus === 'none' || profile.debts.length === 0) {
    debtShare = 'no_debt';
  } else if (hasKnownIncome && monthlyIncome > 0 && isReliable) {
    const ratio = monthlyDebtService / monthlyIncome;
    if (ratio === 0) debtShare = 'no_debt';
    else if (ratio <= 0.1) debtShare = '0_10_pct';
    else if (ratio <= 0.2) debtShare = '10_20_pct';
    else if (ratio <= 0.3) debtShare = '20_30_pct';
    else if (ratio <= 0.4) debtShare = '30_40_pct';
    else debtShare = '40_plus_pct';
  } else {
    debtShare = 'unknown';
  }

  // 4. Cash Runway Bucket (never treat undefined deposit as zero — R09)
  let cashRunway: CashRunwayBucket = 'unknown';
  if (profile.availableDeposit !== undefined && hasKnownExpenses && profile.debtStatus !== 'unknown') {
    const totalOutflow = monthlyExpenses + monthlyDebtService;
    const deposit = profile.availableDeposit;
    if (totalOutflow > 0) {
      const months = deposit / totalOutflow;
      if (months < 1) cashRunway = 'less_than_1_month';
      else if (months <= 3) cashRunway = '1_3_months';
      else if (months <= 6) cashRunway = '3_6_months';
      else if (months <= 12) cashRunway = '6_12_months';
      else cashRunway = '12_plus_months';
    } else if (deposit > 0) {
      cashRunway = '12_plus_months';
    }
  }

  // 5. Family Burden Category (R03: included ONLY when explicitly authorized/requested)
  let familyCategory: FamilyBurdenCategory | undefined = undefined;
  if (options.includeFamilyBurden) {
    if (profile.family?.hasChildren === true) {
      familyCategory = 'childcare_support';
    } else if (profile.family?.elderCareExpenses && profile.family.elderCareExpenses > 0) {
      familyCategory = 'elderly_support';
    } else if (profile.family?.relationshipStatus === 'partner') {
      familyCategory = 'shared_household';
    } else if (
      profile.family?.relationshipStatus === 'single' &&
      profile.family?.hasChildren === false
    ) {
      familyCategory = 'none';
    }
  }

  // 6. Data Quality
  const completeness =
    profile.metadata.completeness === 'task_ready'
      ? 'user_confirmed_complete'
      : profile.metadata.completeness === 'initialized'
        ? 'user_confirmed_partial'
        : 'draft';

  const rawSummary: SafeProfileSummary = {
    income_stability: incomeStability,
    essential_expense_share: expenseShare,
    debt_service_share: debtShare,
    cash_runway: cashRunway,
    ...(familyCategory ? { family_burden_category: familyCategory } : {}),
    data_quality: {
      completeness,
      freshness: computeFreshnessBucket(profile.metadata.dataDate, options.referenceDate),
    },
  };

  // Strictly validate against schema
  return SafeProfileSummarySchema.parse(rawSummary);
}

/**
 * Derives a SafeGoalSummary for a large purchase
 */
export function deriveSafeGoalSummary(
  profile: UserProfile,
  goal: LargePurchaseGoal
): SafeGoalSummary {
  const { monthlySurplus } = calculateMonthlySurplus(profile);
  const hasCompleteCashflow =
    profile.monthlyIncome !== undefined &&
    profile.monthlyIncome.status !== 'unknown' &&
    profile.monthlyIncome.amount !== undefined &&
    profile.essentialExpenses?.amount !== undefined &&
    profile.debtStatus !== 'unknown';

  // Horizon Bucket
  let horizon: GoalHorizonBucket = 'unknown';
  const h = goal.targetHorizonMonths;
  if (h <= 1) horizon = 'immediate_within_1_month';
  else if (h <= 3) horizon = '1_3_months';
  else if (h <= 6) horizon = '3_6_months';
  else if (h <= 12) horizon = '6_12_months';
  else if (h <= 24) horizon = '12_24_months';
  else horizon = '24_plus_months';

  // Cost in surplus bucket
  let costInSurplus: CostInSurplusBucket = 'unknown';
  if (!hasCompleteCashflow) {
    costInSurplus = 'unknown';
  } else if (monthlySurplus <= 0) {
    costInSurplus = 'negative_surplus';
  } else {
    const ratio = goal.targetAmount / monthlySurplus;
    if (ratio <= 3) costInSurplus = 'within_3_months';
    else if (ratio <= 6) costInSurplus = '3_6_months';
    else if (ratio <= 12) costInSurplus = '6_12_months';
    else if (ratio <= 24) costInSurplus = '12_24_months';
    else costInSurplus = '24_plus_months';
  }

  const rawGoal: SafeGoalSummary = {
    task_type: goal.taskType ?? 'large_purchase',
    ...(goal.assessmentScope ? {assessment_scope:goal.assessmentScope} : {}),
    horizon,
    cost_in_monthly_surplus: costInSurplus,
    timing_flexibility: goal.timingFlexibility === 'flexible' ? 'flexible' : 'fixed',
  };

  return SafeGoalSummarySchema.parse(rawGoal);
}
