import type { UserProfile } from '../../features/profile/types.js';
import {
  calculateMonthlyDebtService,
  parseStrictCalendarDate,
} from '../../features/profile/rules.js';
import type {
  SafeScenarioDescriptor,
  SafeToolResult,
  ScenarioKind,
  AdjustmentTier,
  GapHorizonBucket,
  GoalTaskType,
  VersionBinding,
  ClarificationFieldCategory,
} from '@maggot/contracts';

/** Safety limit: max 100M yuan in cents */
const MAX_AMOUNT_CENTS = 100_000_000_00;
/** Safety limit: max 30 years horizon */
const MAX_HORIZON_MONTHS = 360;

export type IntraMonthLiquidityStatus =
  | 'not_assessed_monthly_budget'
  | 'verified'
  | 'unknown_missing_dates'
  | 'unknown_same_day_order';

export interface CompetingGoalReserve {
  /** Amount already committed/reserved for another goal (cents) */
  reservedAmount: number;
  /** Months until that goal's reservation is released (0 = already finished) */
  horizonMonths: number;
}

export interface LargePurchaseGoal {
  assessmentScope?: 'monthly_budget';
  id: string;
  name: string;
  currency?: string; // defaults to 'CNY'
  taskType?: GoalTaskType; // defaults to 'large_purchase' for backwards compatibility
  targetAmount: number; // in cents (purchase amount, savings target, or total income shortfall over horizon)
  targetHorizonMonths: number;
  cashReserveFloor: number; // minimum liquid buffer user wants to keep, in cents
  timingFlexibility: 'fixed' | 'flexible';
  version: string;
  /** F-04: Competing goals that compete for the same cash pool */
  competingGoals?: CompetingGoalReserve[];
}

export interface ScenarioCalculationResult {
  assessmentScope?: 'monthly_budget';
  scenarioId: string;
  scenarioKind: ScenarioKind;
  adjustmentTier: AdjustmentTier;
  targetAmount: number; // exact in cents
  targetHorizonMonths: number;
  monthlySurplus: number; // in cents (current month baseline)
  projectedEndingCash: number; // in cents
  minimumProjectedCash: number; // in cents
  cashDeficit: number; // in cents (0 if satisfied)
  isSatisfied: boolean;
  isReliable: boolean;
  isCalculationComplete: boolean;
  missingFieldCategory?: ClarificationFieldCategory;
  intraMonthLiquidityStatus: IntraMonthLiquidityStatus;
  gapHorizon: GapHorizonBucket;
  evidenceId: string;
}

/**
 * Generates candidate scenarios strictly obeying goal taskType and user timing constraints (R13):
 * - Fixed timing NEVER generates delayed_timing
 * - income_reduction NEVER reduces or delays the external income shock; it evaluates user-controlled expense trimming
 */
export function generateCandidateScenarios(goal: LargePurchaseGoal): SafeScenarioDescriptor[] {
  const taskType: GoalTaskType = goal.taskType ?? 'large_purchase';
  const candidates: SafeScenarioDescriptor[] = [
    {
      scenarioId: `${goal.id}_orig`,
      scenarioKind: 'original_plan',
      adjustmentTier: 'none',
      assumptionCategory: 'baseline',
      assumptionVersion: goal.version,
    },
  ];

  if (taskType === 'income_reduction') {
    candidates.push(
      {
        scenarioId: `${goal.id}_trim10`,
        scenarioKind: 'conservative_buffer',
        adjustmentTier: 'minor_10_pct',
        assumptionCategory: 'cash_buffer',
        assumptionVersion: goal.version,
      },
      {
        scenarioId: `${goal.id}_trim20`,
        scenarioKind: 'conservative_buffer',
        adjustmentTier: 'moderate_20_pct',
        assumptionCategory: 'cash_buffer',
        assumptionVersion: goal.version,
      }
    );
    return candidates;
  }

  candidates.push({
    scenarioId: `${goal.id}_reduced`,
    scenarioKind: 'reduced_budget',
    adjustmentTier: 'minor_10_pct',
    assumptionCategory: 'cost_reduction',
    assumptionVersion: goal.version,
  });

  if (goal.timingFlexibility === 'flexible') {
    candidates.push({
      scenarioId: `${goal.id}_delayed`,
      scenarioKind: 'delayed_timing',
      adjustmentTier: 'delay_3_months',
      assumptionCategory: 'schedule_extension',
      assumptionVersion: goal.version,
    });
  }

  return candidates;
}

/**
 * F-02: Validates that all debts and optional goal share a single currency.
 * Rejects silent cross-currency addition.
 */
export function assertSingleCurrency(profile: UserProfile, goal?: LargePurchaseGoal): string {
  const baseCurrency = (profile.currency ?? 'CNY').toUpperCase();
  for (const debt of profile.debts) {
    if (debt.currency && debt.currency.toUpperCase() !== baseCurrency) {
      throw new Error(
        `Currency mismatch (F-02): debt "${debt.name ?? debt.id}" is in ${debt.currency.toUpperCase()}, expected ${baseCurrency}`
      );
    }
  }
  if (goal?.currency && goal.currency.toUpperCase() !== baseCurrency) {
    throw new Error(
      `Currency mismatch (F-02): goal "${goal.name}" is in ${goal.currency.toUpperCase()}, expected ${baseCurrency}`
    );
  }
  return baseCurrency;
}

function getProfileReferenceYm(profile: UserProfile): { year: number; month: number } {
  const parsed = parseStrictCalendarDate(profile.metadata?.dataDate);
  if (parsed) return { year: parsed.year, month: parsed.month };
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function getDaysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Calculates monthly net cash surplus from profile for a specific year/month.
 * Handles weekly/monthly forward schedules, period-accurate debt deduplication (R12),
 * family detail expenses, and reliability checks (R09).
 */
export function calculateMonthlySurplus(
  profile: UserProfile,
  year?: number,
  month?: number,
  referenceYm?: { year: number; month: number }
): {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyDebtService: number;
  monthlySurplus: number;
  isReliable: boolean;
  isCalculationComplete: boolean;
  hasOverlapConflict: boolean;
  scheduledDebtPayments: ReturnType<typeof calculateMonthlyDebtService>['scheduledPayments'];
} {
  assertSingleCurrency(profile);
  const ref = referenceYm ?? getProfileReferenceYm(profile);
  const y = year ?? ref.year;
  const m = month ?? ref.month;

  const hasIncomeAmount =
    profile.monthlyIncome !== undefined &&
    profile.monthlyIncome.status !== 'unknown' &&
    profile.monthlyIncome.amount !== undefined;
  const hasExpensesAmount =
    profile.essentialExpenses !== undefined && profile.essentialExpenses.amount !== undefined;
  const hasDeposit = profile.availableDeposit !== undefined;
  const hasDebtStatus = profile.debtStatus !== 'unknown';

  const income = hasIncomeAmount ? profile.monthlyIncome!.amount! : 0;
  const rawExpenses = hasExpensesAmount ? profile.essentialExpenses!.amount! : 0;

  const debtResult =
    profile.debtStatus === 'has_debt'
      ? calculateMonthlyDebtService(profile.debts, y, m, ref)
      : {
          totalMonthlyDebtService: 0,
          isFullyModeled: profile.debtStatus === 'none',
          unmodeledDebts: [] as string[],
          scheduledPayments: [],
        };
  const monthlyDebtService = debtResult.totalMonthlyDebtService;

  let hasOverlapConflict = false;
  let expenses = rawExpenses;

  // R12: Deduplicate using actual period debt service (includes both monthly and weekly payments)
  if (profile.essentialExpenses?.includesDebt && profile.debts.length > 0) {
    if (monthlyDebtService > rawExpenses) {
      hasOverlapConflict = true;
    }
    expenses = Math.max(0, rawExpenses - monthlyDebtService);
  }

  // R12: Add explicit un-included family expenses if specified
  if (
    profile.family?.childcareExpenses &&
    profile.family.childcareExpenses > 0 &&
    profile.family.childcareIncludedInEssential === false
  ) {
    expenses += profile.family.childcareExpenses;
  }
  if (
    profile.family?.elderCareExpenses &&
    profile.family.elderCareExpenses > 0 &&
    profile.family.elderCareIncludedInEssential === false
  ) {
    expenses += profile.family.elderCareExpenses;
  }

  const monthlySurplus = income - expenses - monthlyDebtService;
  const isCalculationComplete =
    hasDeposit &&
    hasIncomeAmount &&
    hasExpensesAmount &&
    hasDebtStatus &&
    debtResult.isFullyModeled &&
    !hasOverlapConflict;

  const isReliable = profile.monthlyIncome?.status === 'fixed' && isCalculationComplete;

  return {
    monthlyIncome: income,
    monthlyExpenses: expenses,
    monthlyDebtService,
    monthlySurplus,
    isReliable,
    isCalculationComplete,
    hasOverlapConflict,
    scheduledDebtPayments: debtResult.scheduledPayments,
  };
}

function toGapHorizonBucket(month: number): GapHorizonBucket {
  if (month <= 1) return 'immediate';
  if (month <= 3) return '1_3_months';
  if (month <= 6) return '3_6_months';
  if (month <= 12) return '6_12_months';
  return '12_plus_months';
}

/** Step N calendar months cleanly in (year, month 1-12) arithmetic without Date.setMonth overflow */
function stepYearMonth(startYear: number, startMonth: number, addMonthsCount: number): { year: number; month: number } {
  const zeroBased = startYear * 12 + (startMonth - 1) + addMonthsCount;
  return {
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
  };
}

/**
 * Local deterministic evaluation of a scenario against the user profile and goal.
 * Handles R09 unknown propagation, R10 calendar-date intra-month liquidity, R11 debt end-dates,
 * R12 weekly deduplication, R13 constraint adherence, and F-04 competing goals.
 */
export function evaluateScenarioLocal(
  profile: UserProfile,
  goal: LargePurchaseGoal,
  scenario: SafeScenarioDescriptor,
  callId?: string
): ScenarioCalculationResult {
  assertSingleCurrency(profile, goal);

  if (goal.targetAmount > MAX_AMOUNT_CENTS) {
    throw new Error(
      `Goal targetAmount ${goal.targetAmount} exceeds safety limit of ${MAX_AMOUNT_CENTS} (100M yuan)`
    );
  }
  if (goal.targetHorizonMonths > MAX_HORIZON_MONTHS) {
    throw new Error(
      `Goal targetHorizonMonths ${goal.targetHorizonMonths} exceeds safety limit of ${MAX_HORIZON_MONTHS} (30 years)`
    );
  }

  const taskType: GoalTaskType = goal.taskType ?? 'large_purchase';

  // R13: Reject constraint-violating scenarios
  if (goal.timingFlexibility === 'fixed' && scenario.scenarioKind === 'delayed_timing') {
    throw new Error(
      `Constraint Violation (R13): scenario "${scenario.scenarioId}" uses delayed_timing for a fixed-timing goal`
    );
  }
  if (
    taskType === 'income_reduction' &&
    (scenario.scenarioKind === 'reduced_budget' || scenario.scenarioKind === 'delayed_timing')
  ) {
    throw new Error(
      `Constraint Violation (R13): income_reduction scenario cannot alter external income shock via "${scenario.scenarioKind}"`
    );
  }

  if (goal.assessmentScope === 'monthly_budget') {
    const baseline = calculateMonthlySurplus(profile);
    let target = goal.targetAmount;
    let months = goal.targetHorizonMonths;
    let surplus = baseline.monthlySurplus;
    if (scenario.scenarioKind === 'reduced_budget') target = Math.round(target * (scenario.adjustmentTier === 'moderate_20_pct' ? 0.8 : 0.9));
    if (scenario.scenarioKind === 'delayed_timing') months += scenario.adjustmentTier === 'delay_6_months' ? 6 : 3;
    if (scenario.scenarioKind === 'conservative_buffer') surplus += Math.round(baseline.monthlyExpenses * (scenario.adjustmentTier === 'moderate_20_pct' ? 0.2 : 0.1));
    const initial = (profile.availableDeposit ?? 0) - (goal.competingGoals ?? []).reduce((sum,g) => sum + g.reservedAmount,0);
    const beforeGoal = initial + surplus * months;
    const ending = taskType === 'savings_goal' ? beforeGoal : beforeGoal - target;
    const minimum = Math.min(initial, beforeGoal, ending);
    const required = goal.cashReserveFloor + (taskType === 'savings_goal' ? target : 0);
    const deficit = Math.max(0, required - ending, goal.cashReserveFloor - minimum);
    const complete = baseline.isCalculationComplete && profile.essentialExpenses?.scope !== 'household';
    const reliable = complete && baseline.isReliable;
    return { assessmentScope:'monthly_budget', scenarioId:scenario.scenarioId, scenarioKind:scenario.scenarioKind,
      adjustmentTier:scenario.adjustmentTier,targetAmount:target,targetHorizonMonths:months,monthlySurplus:surplus,
      projectedEndingCash:ending,minimumProjectedCash:minimum,cashDeficit:deficit,isSatisfied:complete && deficit===0,
      isReliable:reliable,isCalculationComplete:complete,
      ...(!complete ? {missingFieldCategory:'expense_refinement' as const} : {}),
      intraMonthLiquidityStatus:'not_assessed_monthly_budget',gapHorizon:deficit>0?toGapHorizonBucket(Math.max(1,months)):'none',
      evidenceId:`ev_${scenario.scenarioId}_${callId ?? Date.now().toString(36)}` };
  }

  const snapshotDate = parseStrictCalendarDate(profile.metadata.dataDate);
  const refYm = getProfileReferenceYm(profile);
  const baseline = calculateMonthlySurplus(profile, refYm.year, refYm.month, refYm);
  const reserveFloor = goal.cashReserveFloor ?? 0;

  // F-04: Competing goals reduce available initial cash while still active
  let initialCash = profile.availableDeposit ?? 0;
  if (goal.competingGoals && goal.competingGoals.length > 0) {
    for (const competing of goal.competingGoals) {
      if (competing.horizonMonths > 0 && competing.reservedAmount > 0) {
        initialCash = Math.max(0, initialCash - competing.reservedAmount);
      }
    }
  }

  const baseHorizon = goal.targetHorizonMonths;
  let effectiveTarget = goal.targetAmount;
  let effectiveHorizon = baseHorizon;
  let expenseScale = 1;

  if (scenario.scenarioKind === 'reduced_budget') {
    if (scenario.adjustmentTier === 'minor_10_pct') {
      effectiveTarget = Math.round(goal.targetAmount * 0.9);
    } else if (scenario.adjustmentTier === 'moderate_20_pct') {
      effectiveTarget = Math.round(goal.targetAmount * 0.8);
    }
  } else if (scenario.scenarioKind === 'delayed_timing') {
    if (scenario.adjustmentTier === 'delay_3_months') {
      effectiveHorizon += 3;
    } else if (scenario.adjustmentTier === 'delay_6_months') {
      effectiveHorizon += 6;
    }
  } else if (scenario.scenarioKind === 'conservative_buffer') {
    if (scenario.adjustmentTier === 'minor_10_pct') {
      expenseScale = 0.9;
    } else if (scenario.adjustmentTier === 'moderate_20_pct') {
      expenseScale = 0.8;
    }
  }

  let runningCash = initialCash;
  let minCash = initialCash;
  let gapHorizon: GapHorizonBucket = 'none';
  let intraMonthLiquidityStatus: IntraMonthLiquidityStatus = snapshotDate ? 'verified' : 'unknown_missing_dates';
  let allCompleteAcrossHorizon = baseline.isCalculationComplete;
  let allReliableAcrossHorizon = baseline.isReliable;

  const monthlyIncomeDrop =
    taskType === 'income_reduction' && baseHorizon > 0
      ? Math.round(effectiveTarget / baseHorizon)
      : 0;

  const incomePayDay = profile.monthlyIncome?.payDay;
  const expensePaymentDay = profile.essentialExpenses?.paymentDay;

  for (let m = 1; m <= effectiveHorizon; m++) {
    // Step months cleanly starting from the anchor month (m=1 is current/first planning month = refYm + (m - 1))
    const { year: calYear, month: calMonth } = stepYearMonth(refYm.year, refYm.month, m - 1);
    const daysInMonth = getDaysInUtcMonth(calYear, calMonth);
    const monthRes = calculateMonthlySurplus(profile, calYear, calMonth, refYm);

    allCompleteAcrossHorizon = allCompleteAcrossHorizon && monthRes.isCalculationComplete;
    allReliableAcrossHorizon = allReliableAcrossHorizon && monthRes.isReliable;

    const scaledExpenses = Math.round(monthRes.monthlyExpenses * expenseScale);
    const effectiveIncome = Math.max(0, monthRes.monthlyIncome - monthlyIncomeDrop);
    const purchaseDelta = taskType === 'large_purchase' && m === effectiveHorizon ? effectiveTarget : 0;

    // Determine whether intra-month dates are fully known for all active non-zero flows
    const hasMissingIncomeDate = effectiveIncome > 0 && incomePayDay === undefined;
    const hasMissingExpenseDate = scaledExpenses > 0 && expensePaymentDay === undefined;
    const hasMissingDebtDate = monthRes.scheduledDebtPayments.some((p) => p.amount > 0 && p.day === null);

    if (hasMissingIncomeDate || hasMissingExpenseDate || hasMissingDebtDate) {
      if (intraMonthLiquidityStatus === 'verified') {
        intraMonthLiquidityStatus = 'unknown_missing_dates';
      }
      // Even when some dates are unknown, exclude the flows we KNOW are already
      // represented in the snapshot. Unknown dates remain an unverified estimate.
      const alreadyOccurred = (day: number | null | undefined) =>
        m === 1 && snapshotDate !== null && day !== null && day !== undefined &&
        Math.min(day, daysInMonth) <= snapshotDate.day;
      const futureIncome = alreadyOccurred(incomePayDay) ? 0 : effectiveIncome;
      const futureExpenses = alreadyOccurred(expensePaymentDay) ? 0 : scaledExpenses;
      const futureDebt = monthRes.scheduledDebtPayments
        .filter(payment => !alreadyOccurred(payment.day))
        .reduce((sum, payment) => sum + payment.amount, 0);
      runningCash += futureIncome - futureExpenses - futureDebt - purchaseDelta;
      if (runningCash < minCash) {
        minCash = runningCash;
      }
      if (runningCash < reserveFloor && gapHorizon === 'none') {
        gapHorizon = toGapHorizonBucket(m);
      }
      continue;
    }

    // Build chronological daily events within (calYear, calMonth)
    const dayEvents = new Map<number, { inflow: number; outflow: number }>();
    const addFlow = (day: number, delta: number, plannedPurchase = false) => {
      const clampedDay = Math.max(1, Math.min(day, daysInMonth));
      // The opening balance is as of the end of dataDate, so recurring flows already
      // reflected in that balance must not be counted again. A planned purchase is new.
      if (!plannedPurchase && m === 1 && snapshotDate && clampedDay <= snapshotDate.day) return;
      const cur = dayEvents.get(clampedDay) ?? { inflow: 0, outflow: 0 };
      if (delta >= 0) cur.inflow += delta;
      else cur.outflow += Math.abs(delta);
      dayEvents.set(clampedDay, cur);
    };

    if (effectiveIncome > 0 && incomePayDay !== undefined) {
      addFlow(incomePayDay, effectiveIncome);
    }
    if (scaledExpenses > 0 && expensePaymentDay !== undefined) {
      addFlow(expensePaymentDay, -scaledExpenses);
    }
    for (const p of monthRes.scheduledDebtPayments) {
      if (p.amount > 0 && p.day !== null) {
        addFlow(p.day, -p.amount);
      }
    }
    if (purchaseDelta > 0) {
      addFlow(daysInMonth, -purchaseDelta, true);
    }

    const sortedDays = [...dayEvents.keys()].sort((a, b) => a - b);
    for (const day of sortedDays) {
      const ev = dayEvents.get(day)!;
      if (ev.inflow > 0 && ev.outflow > 0) {
        // R10: Check whether same-day ordering matters relative to reserveFloor!
        const conservativeMid = runningCash - ev.outflow;
        const optimisticMid = runningCash + ev.inflow;
        const afterBoth = runningCash + ev.inflow - ev.outflow;
        if (conservativeMid < reserveFloor && Math.min(optimisticMid, afterBoth) >= reserveFloor) {
          intraMonthLiquidityStatus = 'unknown_same_day_order';
          allReliableAcrossHorizon = false;
        }
        if (conservativeMid < minCash) {
          minCash = conservativeMid;
        }
        if (conservativeMid < reserveFloor && gapHorizon === 'none') {
          gapHorizon = toGapHorizonBucket(m);
        }
        runningCash = afterBoth;
      } else {
        runningCash += ev.inflow - ev.outflow;
        if (runningCash < minCash) {
          minCash = runningCash;
        }
        if (runningCash < reserveFloor && gapHorizon === 'none') {
          gapHorizon = toGapHorizonBucket(m);
        }
      }
    }
  }

  let cashDeficit: number;
  let arithmeticSatisfied: boolean;

  if (taskType === 'savings_goal') {
    const requiredTotal = reserveFloor + effectiveTarget;
    cashDeficit = Math.max(0, requiredTotal - runningCash, reserveFloor - minCash);
    arithmeticSatisfied = minCash >= reserveFloor && runningCash >= requiredTotal;
    if (!arithmeticSatisfied && gapHorizon === 'none') {
      gapHorizon = toGapHorizonBucket(effectiveHorizon);
    }
  } else {
    cashDeficit = Math.max(0, reserveFloor - minCash);
    arithmeticSatisfied = minCash >= reserveFloor;
  }

  // R09 / R10: Unmodeled inputs or same-day execution uncertainty MUST NOT return isSatisfied: true!
  const isSatisfied =
    allCompleteAcrossHorizon &&
    intraMonthLiquidityStatus === 'verified' &&
    arithmeticSatisfied;

  const isReliable = allReliableAcrossHorizon && intraMonthLiquidityStatus === 'verified';

  let missingFieldCategory: ClarificationFieldCategory | undefined;
  if (!isReliable || !allCompleteAcrossHorizon) {
    if (profile.monthlyIncome?.status === 'variable') {
      missingFieldCategory = 'income_variability_detail';
    } else if (!allCompleteAcrossHorizon || intraMonthLiquidityStatus === 'unknown_missing_dates') {
      missingFieldCategory = 'expense_refinement';
    } else if ((goal.timingFlexibility as string) === 'unknown') {
      missingFieldCategory = 'timing_flexibility_confirmation';
    }
  }

  const evidenceSuffix = callId ? callId : Date.now().toString(36);
  const evidenceId = `ev_${scenario.scenarioId}_${isSatisfied ? 'pass' : 'fail'}_${evidenceSuffix}`;

  return {
    scenarioId: scenario.scenarioId,
    scenarioKind: scenario.scenarioKind,
    adjustmentTier: scenario.adjustmentTier,
    targetAmount: effectiveTarget,
    targetHorizonMonths: effectiveHorizon,
    monthlySurplus: baseline.monthlySurplus,
    projectedEndingCash: runningCash,
    minimumProjectedCash: minCash,
    cashDeficit,
    isSatisfied,
    isReliable,
    isCalculationComplete: allCompleteAcrossHorizon,
    missingFieldCategory,
    intraMonthLiquidityStatus,
    gapHorizon,
    evidenceId,
  };
}

/**
 * Converts a local ScenarioCalculationResult to SafeToolResult with full versionBinding (R04 / R09)
 */
export function toSafeToolResult(
  callId: string,
  calc: ScenarioCalculationResult,
  versionBinding: VersionBinding
): SafeToolResult {
  const status =
    !calc.isCalculationComplete || (calc.assessmentScope !== 'monthly_budget' && calc.intraMonthLiquidityStatus !== 'verified')
      ? 'unknown'
      : calc.isSatisfied
        ? 'satisfied'
        : 'violated';

  return {
    callId,
    toolName: 'evaluate_scenario',
    scenarioId: calc.scenarioId,
    status,
    gapHorizon: calc.gapHorizon,
    isReliable: calc.isReliable,
    ...(calc.assessmentScope ? {assessmentScope:calc.assessmentScope} : {}),
    ...(calc.missingFieldCategory ? { missingFieldCategory: calc.missingFieldCategory } : {}),
    evidenceId: calc.evidenceId,
    versionBinding,
  };
}
