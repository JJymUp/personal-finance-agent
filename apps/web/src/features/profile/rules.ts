import type { UserProfile, ProfileCompleteness, DebtItem } from './types.js';

export interface ProfileValidationResult {
  isValid: boolean;
  completeness: ProfileCompleteness;
  errors: string[];
  warnings: string[];
  deduplicatedExpenses?: {
    rawExpenses: number;
    deductedDebtRepayment: number;
    deduplicatedAmount: number;
  };
  hasScopeConflict: boolean;
  hasOverlapConflict?: boolean;
}

export function parseStrictCalendarDate(
  dateStr: string | undefined
): { year: number; month: number; day: number; utcMs: number } | null {
  if (!dateStr) return null;
  const dateOnly = dateStr.trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, utcMs: d.getTime() };
}

function getDaysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Checks whether the profile meets initialization minimum requirements (U-01)
 * Minimum:
 * - availableDeposit is defined (can be 0)
 * - monthlyIncome status is defined (fixed/variable/unknown)
 * - debtStatus is defined ('none' or 'has_debt' with debts)
 */
export function validateProfile(profile: Partial<UserProfile>): ProfileValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Available Deposit Check (0 is valid!)
  if (profile.availableDeposit === undefined || profile.availableDeposit === null) {
    errors.push('可用存款未填写');
  } else if (profile.availableDeposit < 0 || !Number.isInteger(profile.availableDeposit)) {
    errors.push('可用存款必须是非负整数（分）');
  }

  // 2. Income Check
  if (!profile.monthlyIncome || !profile.monthlyIncome.status) {
    errors.push('收入状态未填写');
  } else {
    if (profile.monthlyIncome.status === 'fixed') {
      if (profile.monthlyIncome.amount === undefined || profile.monthlyIncome.amount === null) {
        errors.push('固定收入必须填写到手金额');
      } else if (profile.monthlyIncome.amount < 0 || !Number.isInteger(profile.monthlyIncome.amount)) {
        errors.push('收入金额必须是非负整数（分）');
      }
    }
  }

  // 3. Debt Check
  if (!profile.debtStatus) {
    errors.push('贷款状态未填写');
  } else if (profile.debtStatus === 'unknown') {
    // Allowed as draft only
    warnings.push('贷款状态暂不清楚，仅可作为草稿保存');
  } else if (profile.debtStatus === 'has_debt') {
    if (!profile.debts || profile.debts.length === 0) {
      errors.push('已选择有贷款，但未提供贷款明细');
    } else {
      for (const debt of profile.debts) {
        if (debt.balance < 0 || !Number.isInteger(debt.balance)) {
          errors.push(`贷款余额必须是非负整数: ${debt.name || debt.id}`);
        }
        if (
          debt.remainingPeriods !== undefined &&
          (debt.remainingPeriods < 0 || !Number.isInteger(debt.remainingPeriods))
        ) {
          errors.push(`贷款剩余期数必须是非负整数: ${debt.name || debt.id}`);
        }
        if (debt.nextPaymentDate && !parseStrictCalendarDate(debt.nextPaymentDate)) {
          errors.push(`贷款下次还款日期格式无效（需 YYYY-MM-DD）: ${debt.name || debt.id}`);
        }
        if (debt.frequency === 'unknown' || debt.frequency === 'irregular') {
          warnings.push(`贷款「${debt.name || debt.id}」为不固定或未知周期，需补充确定计划后才可完成精确测算`);
        }
        if (debt.frequency === 'weekly' && !debt.nextPaymentDate) {
          warnings.push(`周供贷款「${debt.name || debt.id}」缺少下次还款日期，暂无法按日历月准确计算`);
        }
        if (debt.frequency === 'monthly' && debt.repaymentAmount === undefined) {
          warnings.push(`月供贷款「${debt.name || debt.id}」缺少每期还款额`);
        }
      }
    }
  }

  // Determine effective period for debt modeling & deduplication (anchored to dataDate if valid)
  const parsedDataDate = parseStrictCalendarDate(profile.metadata?.dataDate);
  const now = new Date();
  const refYear = parsedDataDate?.year ?? now.getUTCFullYear();
  const refMonth = parsedDataDate?.month ?? now.getUTCMonth() + 1;
  const debtService =
    profile.debtStatus === 'has_debt' && profile.debts
      ? calculateMonthlyDebtService(profile.debts, refYear, refMonth, {
          year: refYear,
          month: refMonth,
        })
      : {
          totalMonthlyDebtService: 0,
          isFullyModeled: profile.debtStatus === 'none',
          unmodeledDebts: [] as string[],
          scheduledPayments: [],
        };

  // 4. Scope Consistency Check (U-04)
  let hasScopeConflict = false;
  if (profile.essentialExpenses && profile.essentialExpenses.scope === 'household') {
    hasScopeConflict = true;
    warnings.push('当前收入为个人口径，生活支出为家庭口径，统计范围存在冲突，需对齐口径');
  }

  // 5. Deduplication Analysis (U-04 / R12: covers both monthly AND weekly period payments)
  let deduplicatedExpenses: ProfileValidationResult['deduplicatedExpenses'] = undefined;
  let hasOverlapConflict = false;
  if (profile.essentialExpenses && profile.essentialExpenses.amount !== undefined) {
    const raw = profile.essentialExpenses.amount;
    if (profile.essentialExpenses.includesDebt && profile.debts && profile.debts.length > 0) {
      const deductedDebt = debtService.totalMonthlyDebtService;
      if (deductedDebt > raw) {
        hasOverlapConflict = true;
        warnings.push('生活费已包含的还款总额超过填报的生活费总额，口径存在冲突，请重新核对');
      }
      deduplicatedExpenses = {
        rawExpenses: raw,
        deductedDebtRepayment: deductedDebt,
        deduplicatedAmount: Math.max(0, raw - deductedDebt),
      };
    }
  }

  // 6. Determine completeness (R09: unknown inputs or unmodeled debts NEVER reach task_ready!)
  const hasKnownIncomeAmount =
    profile.monthlyIncome !== undefined &&
    profile.monthlyIncome.status !== 'unknown' &&
    profile.monthlyIncome.amount !== undefined;
  const hasKnownExpenses =
    profile.essentialExpenses !== undefined &&
    profile.essentialExpenses.amount !== undefined;
  const isDebtReady =
    profile.debtStatus === 'none' ||
    (profile.debtStatus === 'has_debt' &&
      Boolean(profile.debts?.length) &&
      debtService.isFullyModeled);

  let completeness: ProfileCompleteness = 'draft';
  if (errors.length === 0) {
    if (profile.debtStatus === 'unknown' || profile.availableDeposit === undefined) {
      completeness = 'draft';
    } else if (
      hasKnownIncomeAmount &&
      hasKnownExpenses &&
      isDebtReady &&
      !hasScopeConflict &&
      !hasOverlapConflict
    ) {
      completeness = 'task_ready';
    } else {
      completeness = 'initialized';
    }
  }

  return {
    isValid: errors.length === 0,
    completeness,
    errors,
    warnings,
    deduplicatedExpenses,
    hasScopeConflict,
    hasOverlapConflict,
  };
}

export interface ScheduledDebtPayment {
  debtId: string;
  day: number | null; // 1-31 calendar day in target month, or null when no date provided
  amount: number; // cents
}

/**
 * Calculates total monthly debt service for a specific month/year.
 * Handles weekly/monthly forward schedules & remainingPeriods (U-05 / R11), and flags irregular/unknown.
 */
export interface MonthlyDebtServiceResult {
  totalMonthlyDebtService: number; // in cents
  isFullyModeled: boolean;
  unmodeledDebts: string[];
  scheduledPayments: ScheduledDebtPayment[];
}

export function getWeeklyPaymentDaysInMonth(
  anchorDateStr: string,
  targetYear: number,
  targetMonth: number,
  remainingPeriods?: number
): number[] {
  const anchor = parseStrictCalendarDate(anchorDateStr);
  if (!anchor) return [];
  if (remainingPeriods !== undefined && remainingPeriods <= 0) return [];

  const targetStartMs = Date.UTC(targetYear, targetMonth - 1, 1);
  const targetEndMs = Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999);

  // R11: Never step backward before nextPaymentDate! If first future payment is after target month, return []
  if (anchor.utcMs > targetEndMs) {
    return [];
  }

  const weekMs = 7 * 24 * 60 * 60 * 1000;
  let currentMs = anchor.utcMs;
  let periodIdx = 0;

  while (currentMs < targetStartMs) {
    currentMs += weekMs;
    periodIdx++;
    if (remainingPeriods !== undefined && periodIdx >= remainingPeriods) {
      return [];
    }
  }

  const days: number[] = [];
  while (currentMs <= targetEndMs) {
    if (remainingPeriods !== undefined && periodIdx >= remainingPeriods) {
      break;
    }
    days.push(new Date(currentMs).getUTCDate());
    currentMs += weekMs;
    periodIdx++;
  }

  return days;
}

export function countWeeklyOccurrencesInMonth(
  anchorDateStr: string,
  targetYear: number,
  targetMonth: number,
  remainingPeriods?: number
): number {
  return getWeeklyPaymentDaysInMonth(anchorDateStr, targetYear, targetMonth, remainingPeriods).length;
}

export function calculateMonthlyDebtService(
  debts: DebtItem[],
  year: number,
  month: number, // 1-12
  referenceYm?: { year: number; month: number }
): MonthlyDebtServiceResult {
  let total = 0;
  let isFullyModeled = true;
  const unmodeledDebts: string[] = [];
  const scheduledPayments: ScheduledDebtPayment[] = [];
  const daysInTargetMonth = getDaysInUtcMonth(year, month);

  for (const debt of debts) {
    if (debt.remainingPeriods !== undefined && debt.remainingPeriods <= 0) {
      continue;
    }

    if (debt.frequency === 'monthly') {
      if (debt.repaymentAmount === undefined || debt.repaymentAmount < 0 || !Number.isInteger(debt.repaymentAmount)) {
        isFullyModeled = false;
        unmodeledDebts.push(debt.name || debt.id);
        continue;
      }

      if (debt.nextPaymentDate) {
        const anchor = parseStrictCalendarDate(debt.nextPaymentDate);
        if (!anchor) {
          isFullyModeled = false;
          unmodeledDebts.push(debt.name || debt.id);
          continue;
        }
        const monthDiff = (year - anchor.year) * 12 + (month - anchor.month);
        if (monthDiff < 0) {
          // Payment has not started yet (R11)
          continue;
        }
        if (debt.remainingPeriods !== undefined && monthDiff >= debt.remainingPeriods) {
          // Loan already finished before this month (R11)
          continue;
        }
        total += debt.repaymentAmount;
        scheduledPayments.push({
          debtId: debt.id,
          day: Math.min(anchor.day, daysInTargetMonth),
          amount: debt.repaymentAmount,
        });
      } else {
        // No anchor date: check remainingPeriods relative to reference month if provided
        if (debt.remainingPeriods !== undefined && referenceYm) {
          const monthDiff = (year - referenceYm.year) * 12 + (month - referenceYm.month);
          if (monthDiff < 0 || monthDiff >= debt.remainingPeriods) {
            continue;
          }
        }
        total += debt.repaymentAmount;
        scheduledPayments.push({
          debtId: debt.id,
          day: null,
          amount: debt.repaymentAmount,
        });
      }
    } else if (debt.frequency === 'weekly') {
      if (
        debt.repaymentAmount === undefined ||
        debt.repaymentAmount < 0 ||
        !Number.isInteger(debt.repaymentAmount) ||
        !debt.nextPaymentDate
      ) {
        isFullyModeled = false;
        unmodeledDebts.push(debt.name || debt.id);
        continue;
      }

      const anchor = parseStrictCalendarDate(debt.nextPaymentDate);
      if (!anchor) {
        isFullyModeled = false;
        unmodeledDebts.push(debt.name || debt.id);
        continue;
      }

      const days = getWeeklyPaymentDaysInMonth(
        debt.nextPaymentDate,
        year,
        month,
        debt.remainingPeriods
      );
      total += days.length * debt.repaymentAmount;
      for (const day of days) {
        scheduledPayments.push({
          debtId: debt.id,
          day,
          amount: debt.repaymentAmount,
        });
      }
    } else {
      // Irregular or unknown
      isFullyModeled = false;
      unmodeledDebts.push(debt.name || debt.id);
    }
  }

  return {
    totalMonthlyDebtService: total,
    isFullyModeled,
    unmodeledDebts,
    scheduledPayments,
  };
}
