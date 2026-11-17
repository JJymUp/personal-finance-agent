import { describe, it, expect } from 'vitest';
import {
  evaluateScenarioLocal,
  generateCandidateScenarios,
  calculateMonthlySurplus,
  toSafeToolResult,
  type LargePurchaseGoal,
} from './calculator.js';
import type { UserProfile } from '../../features/profile/types.js';

describe('Local Finance Calculator Acceptance (F-01, F-02, F-04, F-05, F-06)', () => {
  const baseProfile: UserProfile = {
    nickname: 'LocalUser',
    availableDeposit: 1000000, // 10,000.00
    monthlyIncome: { status: 'fixed', amount: 500000, payDay: 11 }, // 5,000.00
    debtStatus: 'has_debt',
    debts: [
      {
        id: 'debt-1',
        name: 'Auto Loan',
        balance: 2000000,
        repaymentAmount: 100000, // 1,000.00
        frequency: 'monthly', nextPaymentDate: '2026-11-20',
      },
    ],
    essentialExpenses: {
      amount: 300000, // 3,000.00
      includesDebt: false,
      scope: 'individual', paymentDay: 15,
    },
    metadata: {
      version: 1,
      dataDate: '2026-11-10T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-10T00:00:00Z',
    },
  };

  const carGoal: LargePurchaseGoal = {
    id: 'car_goal_01',
    name: 'Used Car',
    targetAmount: 600000, // 6,000.00
    targetHorizonMonths: 6,
    cashReserveFloor: 500000, // 5,000.00 cash floor
    timingFlexibility: 'flexible',
    version: 'v1',
  };

  it('F-01: Zero income, negative surplus, zero expenses handled without division by zero', () => {
    const zeroProfile: UserProfile = {
      ...baseProfile,
      availableDeposit: 0,
      monthlyIncome: { status: 'fixed', amount: 0 },
      debts: [],
      debtStatus: 'none',
      essentialExpenses: { amount: 0, scope: 'individual' },
    };

    const surplus = calculateMonthlySurplus(zeroProfile);
    expect(surplus.monthlyIncome).toBe(0);
    expect(surplus.monthlyExpenses).toBe(0);
    expect(surplus.monthlySurplus).toBe(0);

    const scenarios = generateCandidateScenarios(carGoal);
    const result = evaluateScenarioLocal(zeroProfile, carGoal, scenarios[0], 'call_test_f01');
    expect(result.isSatisfied).toBe(false);
    expect(result.cashDeficit).toBeGreaterThan(0);
  });

  it('F-02: Matches independent expected arithmetic values with cents precision', () => {
    // Independent calculation:
    // Initial cash: 10,000
    // Monthly income: 5,000
    // Essential expenses: 3,000
    // Debt payment: 1,000
    // Monthly surplus: 5,000 - 3,000 - 1,000 = 1,000
    // Horizon: 6 months
    // Cash before purchase: 10,000 + 6 * 1,000 = 16,000
    // Car purchase: 6,000
    // Ending cash: 16,000 - 6,000 = 10,000
    // Minimum cash reserve floor: 5,000
    // Result: 10,000 >= 5,000 => satisfied, zero deficit!
    const surplus = calculateMonthlySurplus(baseProfile);
    expect(surplus.monthlySurplus).toBe(100000); // 1,000.00 in cents

    const scenarios = generateCandidateScenarios(carGoal);
    const originalPlan = scenarios.find((s) => s.scenarioKind === 'original_plan')!;
    const calc = evaluateScenarioLocal(baseProfile, carGoal, originalPlan, 'call_test_f02');

    expect(calc.projectedEndingCash).toBe(1000000); // 10,000.00 in cents
    expect(calc.cashDeficit).toBe(0);
    expect(calc.isSatisfied).toBe(true);
    expect(calc.evidenceId).toMatch(/^ev_car_goal_01_orig_pass_/);
  });

  it('F-05: Boundary discrimination for two profiles in the exact same summary bucket', () => {
    // Both profiles have the same ratio range, but one just satisfies and the other breaches
    // Goal: 8,000 cost, 5,000 reserve floor, 6 months horizon
    const strictGoal: LargePurchaseGoal = {
      ...carGoal,
      targetAmount: 800000, // 8,000.00
    };
    const scenarios = generateCandidateScenarios(strictGoal);
    const orig = scenarios[0];

    // Profile A: availableDeposit = 7,100 (surplus 1,000 * 6 = 6,000 -> 13,100 - 8,000 = 5,100 >= 5,000) => pass!
    const profilePass: UserProfile = {
      ...baseProfile,
      availableDeposit: 710000,
    };
    const resA = evaluateScenarioLocal(profilePass, strictGoal, orig);
    expect(resA.isSatisfied).toBe(true);
    expect(resA.cashDeficit).toBe(0);

    // Profile B: availableDeposit = 6,900 (surplus 1,000 * 6 = 6,000 -> 12,900 - 8,000 = 4,900 < 5,000) => fail!
    const profileFail: UserProfile = {
      ...baseProfile,
      availableDeposit: 690000,
    };
    const resB = evaluateScenarioLocal(profileFail, strictGoal, orig);
    expect(resB.isSatisfied).toBe(false);
    expect(resB.cashDeficit).toBe(10000); // 100.00 deficit
  });

  it('F-06: Goal versioning and scenario invalidation', () => {
    const v1Goal: LargePurchaseGoal = { ...carGoal, version: 'v1' };
    const v2Goal: LargePurchaseGoal = { ...carGoal, version: 'v2', targetAmount: 900000 };

    const sc1 = generateCandidateScenarios(v1Goal)[0];
    const sc2 = generateCandidateScenarios(v2Goal)[0];

    expect(sc1.assumptionVersion).toBe('v1');
    expect(sc2.assumptionVersion).toBe('v2');
    expect(sc1.assumptionVersion).not.toBe(sc2.assumptionVersion);
  });
});

describe('Calculator Improvements: F-04 Competing Goals, U-05 Weekly Calendar, Safety Limits', () => {
  const baseProfile: UserProfile = {
    nickname: 'LocalUser',
    availableDeposit: 1_000_000, // 10,000.00
    monthlyIncome: { status: 'fixed', amount: 500_000, payDay: 11 }, // 5,000.00
    debtStatus: 'has_debt',
    debts: [
      {
        id: 'debt-1',
        name: 'Auto Loan',
        balance: 2_000_000,
        repaymentAmount: 100_000, // 1,000.00
        frequency: 'monthly', nextPaymentDate: '2026-11-20',
      },
    ],
    essentialExpenses: {
      amount: 300_000, // 3,000.00
      includesDebt: false,
      scope: 'individual', paymentDay: 15,
    },
    metadata: {
      version: 1,
      dataDate: '2026-11-10T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-10T00:00:00Z',
    },
  };

  it('F-04: Competing goal reservation reduces available initial cash', () => {
    const goalWithoutCompetition: LargePurchaseGoal = {
      id: 'goal_f04',
      name: 'Car Upgrade',
      targetAmount: 600_000, // 6,000
      targetHorizonMonths: 6,
      cashReserveFloor: 500_000, // 5,000
      timingFlexibility: 'flexible',
      version: 'v1',
    };

    const goalWithCompetition: LargePurchaseGoal = {
      ...goalWithoutCompetition,
      competingGoals: [
        { reservedAmount: 600_000, horizonMonths: 6 }, // 6,000 reserved elsewhere -> initial drops from 10,000 to 4,000
      ],
    };

    const scenarios = generateCandidateScenarios(goalWithCompetition);
    const resWithout = evaluateScenarioLocal(baseProfile, goalWithoutCompetition, scenarios[0], 'call_no_comp');
    const resWith = evaluateScenarioLocal(baseProfile, goalWithCompetition, scenarios[0], 'call_with_comp');

    // Without competition: 10,000 + 6,000 - 6,000 = 10,000 (>= 5,000) -> satisfied
    expect(resWithout.isSatisfied).toBe(true);
    // With competition: 4,000 + 6,000 - 6,000 = 4,000 (< 5,000 reserve floor) -> violated
    expect(resWith.isSatisfied).toBe(false);
    expect(resWith.projectedEndingCash).toBe(400_000);
    expect(resWith.cashDeficit).toBe(100_000);
  });

  it('U-05: Per-month weekly debt payment calendar accounts for 4 vs 5 occurrence months', () => {
    // Weekly debt starting on a Friday (e.g., 2026-01-02)
    const weeklyProfile: UserProfile = {
      ...baseProfile,
      availableDeposit: 500_000,
      monthlyIncome: { status: 'fixed', amount: 800_000 }, // 8,000
      essentialExpenses: { amount: 200_000, scope: 'individual' }, // 2,000
      debts: [
        {
          id: 'weekly_debt',
          name: 'Weekly Loan',
          balance: 1_000_000,
          repaymentAmount: 100_000, // 1,000 per week
          frequency: 'weekly',
          nextPaymentDate: '2026-01-02T00:00:00Z',
        },
      ],
    };

    // May 2026 has 5 Fridays (1, 8, 15, 22, 29), June 2026 has 4 Fridays (5, 12, 19, 26)
    const maySurplus = calculateMonthlySurplus(weeklyProfile, 2026, 5);
    const juneSurplus = calculateMonthlySurplus(weeklyProfile, 2026, 6);

    expect(maySurplus.monthlyDebtService).toBe(500_000); // 5 weeks * 1,000
    expect(juneSurplus.monthlyDebtService).toBe(400_000); // 4 weeks * 1,000
    expect(maySurplus.monthlySurplus).toBe(100_000); // 8,000 - 2,000 - 5,000 = 1,000
    expect(juneSurplus.monthlySurplus).toBe(200_000); // 8,000 - 2,000 - 4,000 = 2,000
  });

  it('Safety limits: rejects targetAmount > 100M yuan or horizon > 360 months', () => {
    const tooExpensive: LargePurchaseGoal = {
      id: 'g_huge',
      name: 'Huge',
      targetAmount: 100_000_000_00 + 1,
      targetHorizonMonths: 12,
      cashReserveFloor: 0,
      timingFlexibility: 'fixed',
      version: 'v1',
    };
    const tooLong: LargePurchaseGoal = {
      id: 'g_long',
      name: 'Long',
      targetAmount: 100_000,
      targetHorizonMonths: 361,
      cashReserveFloor: 0,
      timingFlexibility: 'fixed',
      version: 'v1',
    };

    const sc1 = generateCandidateScenarios(tooExpensive)[0];
    const sc2 = generateCandidateScenarios(tooLong)[0];

    expect(() => evaluateScenarioLocal(baseProfile, tooExpensive, sc1)).toThrow(/safety limit/);
    expect(() => evaluateScenarioLocal(baseProfile, tooLong, sc2)).toThrow(/safety limit/);
  });
});

describe('F-02: Multi-currency explicit blocking', () => {
  it('rejects mixing USD debt or USD goal with CNY profile without conversion', () => {
    const cnyProfile: UserProfile = {
      nickname: 'MultiCurUser',
      currency: 'CNY',
      availableDeposit: 1_000_000,
      monthlyIncome: { status: 'fixed', amount: 500_000 },
      debtStatus: 'has_debt',
      debts: [
        {
          id: 'usd_debt',
          name: 'USD Card',
          currency: 'USD',
          balance: 500_000,
          repaymentAmount: 50_000,
          frequency: 'monthly',
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

    expect(() => calculateMonthlySurplus(cnyProfile)).toThrow(/Currency mismatch \(F-02\)/);

    const cleanProfile: UserProfile = { ...cnyProfile, debtStatus: 'none', debts: [] };
    const usdGoal: LargePurchaseGoal = {
      id: 'g_usd',
      name: 'Overseas Purchase',
      currency: 'USD',
      targetAmount: 100_000,
      targetHorizonMonths: 6,
      cashReserveFloor: 100_000,
      timingFlexibility: 'flexible',
      version: 'v1',
    };
    const sc = generateCandidateScenarios(usdGoal)[0];
    expect(() => evaluateScenarioLocal(cleanProfile, usdGoal, sc)).toThrow(
      /Currency mismatch \(F-02\)/
    );
  });
});

describe('R09 ~ R13 Calculator Soundness Regressions', () => {
  it('R09: Unknown deposit or unmodeled debt makes scenario unreliable and emits tool status unknown', () => {
    const unknownDebtProfile: UserProfile = {
      nickname: 'UUser',
      availableDeposit: 2_000_000,
      monthlyIncome: { status: 'fixed', amount: 1_000_000 },
      debtStatus: 'unknown',
      debts: [],
      essentialExpenses: { amount: 400_000, scope: 'individual' },
      metadata: {
        version: 1,
        dataDate: '2026-11-11T00:00:00Z',
        completeness: 'initialized',
        updatedAt: '2026-11-11T00:00:00Z',
      },
    };
    const goal: LargePurchaseGoal = {
      id: 'g_r09',
      name: 'R09 Goal',
      targetAmount: 300_000,
      targetHorizonMonths: 6,
      cashReserveFloor: 100_000,
      timingFlexibility: 'flexible',
      version: 'v1',
    };
    const sc = generateCandidateScenarios(goal)[0];
    const calc = evaluateScenarioLocal(unknownDebtProfile, goal, sc);
    expect(calc.isReliable).toBe(false);
    expect(calc.isCalculationComplete).toBe(false);
    expect(calc.isSatisfied).toBe(false);

    const safe = toSafeToolResult('call_r09', calc, {
      snapshotVersion: 'snap_1',
      goalVersion: 'v1',
      policyVersion: 'p_1.0',
    });
    expect(safe.status).toBe('unknown');
    expect(safe.toolName === 'evaluate_scenario' && safe.isReliable).toBe(false);
  });

  it('R10: Detects intra-month timing dip when rent falls before payday vs same-day ambiguity', () => {
    const dipProfile: UserProfile = {
      nickname: 'DipUser',
      availableDeposit: 150_000, // 1,500 initial
      monthlyIncome: { status: 'fixed', amount: 800_000, payDay: 20 },
      debtStatus: 'none',
      debts: [],
      essentialExpenses: { amount: 200_000, scope: 'individual', paymentDay: 5 },
      metadata: {
        version: 1,
        dataDate: '2026-11-01T00:00:00Z',
        completeness: 'task_ready',
        updatedAt: '2026-11-01T00:00:00Z',
      },
    };
    const goal: LargePurchaseGoal = {
      id: 'g_r10',
      name: 'Savings Plan',
      taskType: 'savings_goal',
      targetAmount: 600_000,
      targetHorizonMonths: 3,
      cashReserveFloor: 50_000, // requires 500 at all times
      timingFlexibility: 'fixed',
      version: 'v1',
    };
    const sc = generateCandidateScenarios(goal)[0];
    const dipCalc = evaluateScenarioLocal(dipProfile, goal, sc);
    // Day 5 rent (2,000) arrives before day 20 salary (8,000) -> 1,500 - 2,000 = -500 (< 500 reserve floor!)
    expect(dipCalc.intraMonthLiquidityStatus).toBe('verified');
    expect(dipCalc.minimumProjectedCash).toBe(-50_000);
    expect(dipCalc.isSatisfied).toBe(false);

    // Same-day payDay === paymentDay is flagged as ambiguous order
    const sameDayProfile: UserProfile = {
      ...dipProfile,
      monthlyIncome: { status: 'fixed', amount: 800_000, payDay: 5 },
    };
    const sameDayCalc = evaluateScenarioLocal(sameDayProfile, goal, sc);
    expect(sameDayCalc.intraMonthLiquidityStatus).toBe('unknown_same_day_order');
    const safeSameDay = toSafeToolResult('call_sameday', sameDayCalc, {
      snapshotVersion: 'snap_1',
      goalVersion: 'v1',
      policyVersion: 'p_1.0',
    });
    expect(safeSameDay.status).toBe('unknown');
  });

  it('R12: Family extraMonthlyExpense is included in surplus & weekly+monthly includesDebt avoids double counting', () => {
    const famProfile: UserProfile = {
      nickname: 'FamUser',
      availableDeposit: 1_000_000,
      monthlyIncome: { status: 'fixed', amount: 1_000_000 }, // 10,000
      debtStatus: 'has_debt',
      debts: [
        {
          id: 'w_1',
          name: 'Weekly Debt',
          balance: 500_000,
          repaymentAmount: 25_000,
          frequency: 'weekly',
          nextPaymentDate: '2026-10-01', // Oct 2026 has 5 Thursdays -> 1,250
        },
      ],
      essentialExpenses: { amount: 400_000, includesDebt: true, scope: 'individual' }, // 4,000 raw - 1,250 debt = 2,750 base
      family: { hasChildren: true, childcareExpenses: 150_000, childcareIncludedInEssential: false }, // +1,500
      metadata: {
        version: 1,
        dataDate: '2026-10-01T00:00:00Z',
        completeness: 'task_ready',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    };
    const surplus = calculateMonthlySurplus(famProfile, 2026, 10);
    // Net outflow = 2,750 (dedup essential) + 1,500 (family) + 1,250 (debt) = 5,500; surplus = 4,500
    expect(surplus.monthlyDebtService).toBe(125_000);
    expect(surplus.monthlyExpenses).toBe(425_000);
    expect(surplus.monthlySurplus).toBe(450_000);
  });

  it('R13: Fixed-timing goals omit delay alternatives and income_reduction preserves shock magnitude while trimming expenses', () => {
    const fixedGoal: LargePurchaseGoal = {
      id: 'g_fixed',
      name: 'School Tuition',
      targetAmount: 1_000_000,
      targetHorizonMonths: 6,
      cashReserveFloor: 200_000,
      timingFlexibility: 'fixed',
      version: 'v1',
    };
    const fixedScenarios = generateCandidateScenarios(fixedGoal);
    expect(fixedScenarios.some((s) => s.scenarioKind === 'delayed_timing')).toBe(false);

    const shockGoal: LargePurchaseGoal = {
      id: 'g_shock',
      name: 'Salary Drop',
      taskType: 'income_reduction',
      targetAmount: 600_000, // 6,000 external income loss
      targetHorizonMonths: 6,
      cashReserveFloor: 200_000,
      timingFlexibility: 'flexible',
      version: 'v1',
    };
    const shockScenarios = generateCandidateScenarios(shockGoal);
    expect(shockScenarios.some((s) => s.scenarioKind === 'delayed_timing')).toBe(false);
    const bufferAlt = shockScenarios.find((s) => s.scenarioKind === 'conservative_buffer');
    expect(bufferAlt).toBeDefined();

    const p: UserProfile = {
      nickname: 'ShockUser',
      availableDeposit: 500_000,
      monthlyIncome: { status: 'fixed', amount: 500_000 },
      debtStatus: 'none',
      debts: [],
      essentialExpenses: { amount: 450_000, scope: 'individual' },
      metadata: {
        version: 1,
        dataDate: '2026-11-01T00:00:00Z',
        completeness: 'task_ready',
        updatedAt: '2026-11-01T00:00:00Z',
      },
    };
    const calc = evaluateScenarioLocal(p, shockGoal, bufferAlt!);
    // Shock targetAmount remains full 600_000 rather than shrunk; expenses reduced instead
    expect(calc.targetAmount).toBe(600_000);
  });
});

describe('FIX-06 explicit balance-date and uncertainty boundaries', () => {
  const profile: UserProfile = {
    availableDeposit: 1_000_000,
    monthlyIncome: { status: 'fixed', amount: 500_000, payDay: 5 },
    essentialExpenses: { amount: 0, scope: 'individual' }, debtStatus: 'none', debts: [],
    metadata: { version: 1, dataDate: '2026-11-12', updatedAt: '2026-11-12', completeness: 'task_ready' },
  };
  const goal: LargePurchaseGoal = { id: 'date_boundary', name: 'Purchase', targetAmount: 100_000,
    targetHorizonMonths: 1, cashReserveFloor: 0, timingFlexibility: 'fixed', version: 'v1' };

  it('does not call missing income dates reliable or satisfied', () => {
    const missing = { ...profile, monthlyIncome: { status: 'fixed' as const, amount: 500_000 } };
    const calc = evaluateScenarioLocal(missing, goal, generateCandidateScenarios(goal)[0]);
    const result = toSafeToolResult('date_call', calc, { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' });
    expect(calc.intraMonthLiquidityStatus).toBe('unknown_missing_dates');
    expect(result.status).toBe('unknown');
    expect(result.toolName === 'evaluate_scenario' && result.isReliable).toBe(false);
  });

  it.each([[1, 900_000], [2, 1_400_000]])('projects %i calendar months without replaying pre-snapshot salary', (months, expected) => {
    const g = { ...goal, targetHorizonMonths: months };
    const calc = evaluateScenarioLocal(profile, g, generateCandidateScenarios(g)[0]);
    // Balance is at end of Nov 12: Nov 5 salary is already included; only Dec 5 adds 5000.
    expect(calc.projectedEndingCash).toBe(expected);
  });
});

it('final review: missing expense date does not replay a known pre-snapshot salary', () => {
  const p: UserProfile = { availableDeposit: 1_000_000,
    monthlyIncome: { status: 'fixed', amount: 500_000, payDay: 5 },
    essentialExpenses: { amount: 100_000, scope: 'individual' }, debtStatus: 'none', debts: [],
    metadata: { version: 1, dataDate: '2026-11-12', updatedAt: '2026-11-12', completeness: 'task_ready' } };
  const g: LargePurchaseGoal = { id: 'partial_dates', name: 'Synthetic', targetAmount: 100_000,
    targetHorizonMonths: 1, cashReserveFloor: 0, timingFlexibility: 'fixed', version: 'v1' };
  const result = evaluateScenarioLocal(p, g, generateCandidateScenarios(g)[0]);
  expect(result.projectedEndingCash).toBe(800_000);
  expect(result.isReliable).toBe(false);
});
