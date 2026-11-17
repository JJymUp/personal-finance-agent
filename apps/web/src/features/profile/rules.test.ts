import { describe, it, expect } from 'vitest';
import {
  validateProfile,
  calculateMonthlyDebtService,
  countWeeklyOccurrencesInMonth,
} from './rules.js';
import type { UserProfile } from './types.js';

describe('Profile Rules & Acceptance Criteria (U-01 ~ U-05)', () => {
  it('U-01: Handles no debt, zero deposit, zero income, nickname skipped, and unknown income', () => {
    // 1. Minimum initialized case: zero deposit, zero fixed income, no debt
    const zeroProfile: Partial<UserProfile> = {
      availableDeposit: 0,
      monthlyIncome: { status: 'fixed', amount: 0 },
      debtStatus: 'none',
      debts: [],
    };
    const resZero = validateProfile(zeroProfile);
    expect(resZero.isValid).toBe(true);
    expect(resZero.completeness).toBe('initialized');
    expect(resZero.errors).toHaveLength(0);

    // 2. Variable income with estimated amount and nickname skipped
    const varProfile: Partial<UserProfile> = {
      availableDeposit: 500000, // 5,000.00
      monthlyIncome: { status: 'variable', isEstimate: true },
      debtStatus: 'none',
      debts: [],
    };
    const resVar = validateProfile(varProfile);
    expect(resVar.isValid).toBe(true);
    expect(resVar.completeness).toBe('initialized');

    // 3. Unknown debt status allows draft saving only, not initialized!
    const draftProfile: Partial<UserProfile> = {
      availableDeposit: 100000,
      monthlyIncome: { status: 'unknown' },
      debtStatus: 'unknown',
      debts: [],
    };
    const resDraft = validateProfile(draftProfile);
    expect(resDraft.isValid).toBe(true);
    expect(resDraft.completeness).toBe('draft');
    expect(resDraft.warnings).toContain('贷款状态暂不清楚，仅可作为草稿保存');
  });

  it('U-02: Profile without essential expenses is initialized but not task-ready', () => {
    const basicProfile: Partial<UserProfile> = {
      availableDeposit: 2000000,
      monthlyIncome: { status: 'fixed', amount: 1500000 },
      debtStatus: 'none',
      debts: [],
      // essentialExpenses is omitted!
    };

    const res = validateProfile(basicProfile);
    expect(res.isValid).toBe(true);
    expect(res.completeness).toBe('initialized');
    // Not task ready!
    expect(res.completeness).not.toBe('task_ready');
  });

  it('U-03: Single with children, partnered without children, and family info refused', () => {
    // 1. Single with children
    const singleWithKids: Partial<UserProfile> = {
      availableDeposit: 1000000,
      monthlyIncome: { status: 'fixed', amount: 800000 },
      debtStatus: 'none',
      debts: [],
      family: {
        relationshipStatus: 'single',
        hasChildren: true,
        childcareExpenses: 200000,
      },
    };
    const res1 = validateProfile(singleWithKids);
    expect(res1.isValid).toBe(true);

    // 2. Partnered without children
    const partneredNoKids: Partial<UserProfile> = {
      availableDeposit: 1000000,
      monthlyIncome: { status: 'fixed', amount: 800000 },
      debtStatus: 'none',
      debts: [],
      family: {
        relationshipStatus: 'partner',
        hasChildren: false,
      },
    };
    const res2 = validateProfile(partneredNoKids);
    expect(res2.isValid).toBe(true);

    // 3. Family info refused / prefer not to say
    const preferNotToSay: Partial<UserProfile> = {
      availableDeposit: 1000000,
      monthlyIncome: { status: 'fixed', amount: 800000 },
      debtStatus: 'none',
      debts: [],
      family: {
        relationshipStatus: 'prefer_not_to_say',
      },
    };
    const res3 = validateProfile(preferNotToSay);
    expect(res3.isValid).toBe(true);
  });

  it('U-04: Deduplication when living expenses includes debt repayment, and scope conflict detection', () => {
    // Case 1: Deduplication when expenses includes debt
    const profileWithOverlap: Partial<UserProfile> = {
      availableDeposit: 1000000,
      monthlyIncome: { status: 'fixed', amount: 1000000 },
      debtStatus: 'has_debt',
      debts: [
        {
          id: 'loan-1',
          name: 'Car loan',
          balance: 5000000,
          repaymentAmount: 200000, // 2,000 monthly
          frequency: 'monthly',
        },
      ],
      essentialExpenses: {
        amount: 500000, // 5,000 reported, but includes debt!
        includesDebt: true,
        scope: 'individual',
      },
    };

    const res1 = validateProfile(profileWithOverlap);
    expect(res1.isValid).toBe(true);
    expect(res1.deduplicatedExpenses).toBeDefined();
    expect(res1.deduplicatedExpenses?.rawExpenses).toBe(500000);
    expect(res1.deduplicatedExpenses?.deductedDebtRepayment).toBe(200000);
    expect(res1.deduplicatedExpenses?.deduplicatedAmount).toBe(300000);

    // Case 2: Scope conflict (individual income vs household expenses)
    const profileScopeConflict: Partial<UserProfile> = {
      availableDeposit: 1000000,
      monthlyIncome: { status: 'fixed', amount: 1000000 },
      debtStatus: 'none',
      debts: [],
      essentialExpenses: {
        amount: 600000,
        scope: 'household', // Conflict with personal income
      },
    };

    const res2 = validateProfile(profileScopeConflict);
    expect(res2.hasScopeConflict).toBe(true);
    expect(res2.completeness).not.toBe('task_ready');
  });

  it('U-05: Weekly repayments calculated by calendar dates, never 4 weeks = 1 month', () => {
    // In October 2026, let's check weekly payment occurrences
    // Anchor: 2026-10-01 is a Thursday
    // Thursdays in Oct 2026: Oct 1, 8, 15, 22, 29 => exactly 5 occurrences!
    const countOct = countWeeklyOccurrencesInMonth('2026-10-01', 2026, 10);
    expect(countOct).toBe(5);

    // In November 2026: Nov 5, 12, 19, 26 => exactly 4 occurrences!
    const countNov = countWeeklyOccurrencesInMonth('2026-10-01', 2026, 11);
    expect(countNov).toBe(4);

    const weeklyDebt = [
      {
        id: 'weekly-loan',
        name: 'Weekly peer debt',
        balance: 100000,
        repaymentAmount: 5000, // 50.00 weekly
        frequency: 'weekly' as const,
        nextPaymentDate: '2026-10-01',
      },
    ];

    const octDebtResult = calculateMonthlyDebtService(weeklyDebt, 2026, 10);
    expect(octDebtResult.isFullyModeled).toBe(true);
    expect(octDebtResult.totalMonthlyDebtService).toBe(25000); // 5 * 5000

    const novDebtResult = calculateMonthlyDebtService(weeklyDebt, 2026, 11);
    expect(novDebtResult.isFullyModeled).toBe(true);
    expect(novDebtResult.totalMonthlyDebtService).toBe(20000); // 4 * 5000

    // Irregular repayments are flagged as unmodeled
    const irregularDebt = [
      {
        id: 'irregular-loan',
        name: 'Borrowing from friend',
        balance: 100000,
        frequency: 'irregular' as const,
      },
    ];
    const irregResult = calculateMonthlyDebtService(irregularDebt, 2026, 10);
    expect(irregResult.isFullyModeled).toBe(false);
    expect(irregResult.unmodeledDebts).toContain('Borrowing from friend');
  });

  it('R11/R12: Weekly debts never back-project before nextPaymentDate, stop after remainingPeriods, and reject unmodeled debts from task_ready', () => {
    const futureWeekly = [
      {
        id: 'future-w',
        name: 'Deferred weekly loan',
        balance: 500_000,
        repaymentAmount: 25_000,
        frequency: 'weekly' as const,
        nextPaymentDate: '2026-12-10',
        remainingPeriods: 3,
      },
    ];

    // Earlier months before nextPaymentDate must have 0 repayments
    expect(countWeeklyOccurrencesInMonth('2026-12-10', 2026, 11)).toBe(0);
    expect(calculateMonthlyDebtService(futureWeekly, 2026, 11).totalMonthlyDebtService).toBe(0);

    // Dec 10, 17, 24 = 3 occurrences (4th Dec 31 stops due to remainingPeriods=3)
    const decRes = calculateMonthlyDebtService(futureWeekly, 2026, 12);
    expect(decRes.totalMonthlyDebtService).toBe(75_000);
    // Jan 2027 has 0 left
    expect(calculateMonthlyDebtService(futureWeekly, 2027, 1).totalMonthlyDebtService).toBe(0);

    // Invalid calendar date (Feb 30) flagged unmodeled and blocks task_ready
    const badProfile: UserProfile = {
      availableDeposit: 500_000,
      monthlyIncome: { status: 'fixed', amount: 800_000 },
      debtStatus: 'has_debt',
      debts: [
        {
          id: 'bad-w',
          name: 'Invalid date debt',
          balance: 100_000,
          repaymentAmount: 10_000,
          frequency: 'weekly',
          nextPaymentDate: '2026-02-30',
        },
      ],
      essentialExpenses: { amount: 200_000, scope: 'individual' },
      metadata: {
        version: 1,
        dataDate: '2026-11-11T00:00:00Z',
        completeness: 'task_ready',
        updatedAt: '2026-11-11T00:00:00Z',
      },
    };
    const val = validateProfile(badProfile);
    expect(val.completeness).not.toBe('task_ready');
    expect(val.errors.some((e) => e.includes('Invalid date debt'))).toBe(true);
  });
});
