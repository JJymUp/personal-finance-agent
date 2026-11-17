import { describe, it, expect } from 'vitest';
import { deriveSafeProfileSummary, deriveSafeGoalSummary } from './summary.js';
import { PrivacyGateway } from './gateway.js';
import type { UserProfile } from '../../features/profile/types.js';
import type { LargePurchaseGoal } from '../finance/calculator.js';
import { generateCandidateScenarios } from '../finance/calculator.js';

describe('Privacy Gateway & Safe Summary (P-01 ~ P-09, U-06)', () => {
  const sampleProfile: UserProfile = {
    nickname: 'Alice_SENSITIVE_NAME',
    availableDeposit: 5000000, // 50,000.00
    monthlyIncome: { status: 'fixed', amount: 2000000 }, // 20,000.00
    debtStatus: 'has_debt',
    debts: [
      {
        id: 'BANK_ACCOUNT_NO_888',
        name: 'Mortgage',
        balance: 100000000,
        repaymentAmount: 400000, // 4,000.00 (20%)
        frequency: 'monthly',
      },
    ],
    essentialExpenses: {
      amount: 800000, // 8,000.00 (40%)
      scope: 'individual',
    },
    family: {
      relationshipStatus: 'single',
      hasChildren: true,
      childcareExpenses: 300000,
    },
    metadata: {
      version: 1,
      dataDate: '2026-11-10T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-10T00:00:00Z',
    },
  };

  const sampleGoal: LargePurchaseGoal = {
    id: 'goal_car',
    name: 'New Car',
    targetAmount: 15000000,
    targetHorizonMonths: 12,
    cashReserveFloor: 2000000,
    timingFlexibility: 'flexible',
    version: 'v1',
  };

  it('U-06/P-01: Safe summary eliminates exact amounts, nicknames, and omits family burden by default (R03)', () => {
    const summary = deriveSafeProfileSummary(sampleProfile);

    // Ensure safe fields are bucketed
    expect(summary.income_stability).toBe('stable');
    expect(summary.essential_expense_share).toBe('30_40_pct');
    expect(summary.debt_service_share).toBe('10_20_pct');
    expect(summary.cash_runway).toBe('3_6_months');
    expect(summary.family_burden_category).toBeUndefined();

    // Only included when explicitly authorized / requested
    const withFamily = deriveSafeProfileSummary(sampleProfile, { includeFamilyBurden: true });
    expect(withFamily.family_burden_category).toBe('childcare_support');

    // R09: Freshness reflects actual dataDate age
    const stale = deriveSafeProfileSummary(sampleProfile, {
      referenceDate: '2026-12-20T00:00:00Z',
    });
    expect(stale.data_quality.freshness).toBe('older_than_30_days');

    // JSON string inspection: ensure NO raw secrets are present
    const serialized = JSON.stringify(withFamily);
    expect(serialized).not.toContain('Alice');
    expect(serialized).not.toContain('SENSITIVE');
    expect(serialized).not.toContain('5000000');
    expect(serialized).not.toContain('2000000');
    expect(serialized).not.toContain('BANK_ACCOUNT');
  });

  it('P-02: PrivacyGateway blocks unknown fields and unapproved payloads', () => {
    const gateway = new PrivacyGateway();
    const provider = 'mock_ai_service';

    // 1. Without authorization, outbound request throws
    const safeSummary = deriveSafeProfileSummary(sampleProfile);
    const safeGoal = deriveSafeGoalSummary(sampleProfile, sampleGoal);
    const candidateScenarios = generateCandidateScenarios(sampleGoal);

    const validRunRequest = {
      protocolVersion: '1.0' as const,
      snapshotVersion: 'snap_01',
      goalVersion: 'v1',
      policyVersion: 'p_1.0',
      candidateScenarios,
      safeProfileSummary: safeSummary,
      safeGoalSummary: safeGoal,
    };

    expect(() =>
      gateway.inspectAndAuthorizeRunRequest(validRunRequest, provider)
    ).toThrow(/Unauthorized/);

    // 2. Authorize provider
    gateway.authorize({
      purpose: 'financial_planning',
      provider,
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios'],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    // Valid request succeeds
    const approved = gateway.inspectAndAuthorizeRunRequest(validRunRequest, provider);
    expect(approved).toBeDefined();

    // 3. Request with unknown or extra fields is rejected (P-02)
    const rogueRequest = {
      ...validRunRequest,
      unauthorizedField: 'malicious_extra_data',
    };
    expect(() =>
      gateway.inspectAndAuthorizeRunRequest(rogueRequest, provider)
    ).toThrow();
  });

  it('P-01/P-05: Gateway catches forbidden sensitive token patterns', () => {
    const gateway = new PrivacyGateway();
    const provider = 'mock_ai_service';
    gateway.authorize({
      purpose: 'financial_planning',
      provider,
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios'],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const safeSummary = deriveSafeProfileSummary(sampleProfile);
    const safeGoal = deriveSafeGoalSummary(sampleProfile, sampleGoal);

    // Inject sensitive token into scenario ID
    const contaminatedRequest = {
      protocolVersion: '1.0' as const,
      snapshotVersion: 'snap_01',
      goalVersion: 'v1',
      policyVersion: 'p_1.0',
      candidateScenarios: [
        {
          scenarioId: 'sc_SENSITIVE_ACCOUNT_NO_77',
          scenarioKind: 'original_plan' as const,
          adjustmentTier: 'none' as const,
          assumptionCategory: 'baseline' as const,
          assumptionVersion: 'v1',
        },
      ],
      safeProfileSummary: safeSummary,
      safeGoalSummary: safeGoal,
    };

    expect(() =>
      gateway.inspectAndAuthorizeRunRequest(contaminatedRequest, provider)
    ).toThrow(/Security Violation: Outbound payload contains forbidden token pattern/);
  });

  it('P-04: Revocation immediately blocks further outbound transmission', () => {
    const gateway = new PrivacyGateway();
    const provider = 'mock_ai_service';
    gateway.authorize({
      purpose: 'financial_planning',
      provider,
      allowedScopes: ['profile_summary'],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(gateway.isAuthorized(provider)).toBe(true);

    gateway.revoke();
    expect(gateway.isAuthorized(provider)).toBe(false);
  });
});

describe('R01 / R03 Scope & Structured Outbound Inspection', () => {
  const scopeProfile: UserProfile = {
    nickname: 'ScopeUser',
    availableDeposit: 5_000_000,
    monthlyIncome: { status: 'fixed', amount: 2_000_000 },
    debtStatus: 'none',
    debts: [],
    essentialExpenses: { amount: 800_000, scope: 'individual' },
    family: { relationshipStatus: 'single', hasChildren: true, childcareExpenses: 300_000 },
    metadata: {
      version: 1,
      dataDate: '2026-11-10T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-10T00:00:00Z',
    },
  };
  const scopeGoal: LargePurchaseGoal = {
    id: 'goal_scope',
    name: 'Car',
    targetAmount: 1_500_000,
    targetHorizonMonths: 12,
    cashReserveFloor: 500_000,
    timingFlexibility: 'flexible',
    version: 'v1',
  };

  it('blocks empty scope authorization and missing required scopes (R03)', () => {
    const gateway = new PrivacyGateway();
    const provider = 'mock_provider';

    gateway.authorize({
      purpose: 'financial_planning',
      provider,
      allowedScopes: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(gateway.isAuthorized(provider)).toBe(false);

    gateway.authorize({
      purpose: 'financial_planning',
      provider,
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // Requires family_summary scope when family_burden_category is included
    const summaryWithFamily = deriveSafeProfileSummary(scopeProfile, { includeFamilyBurden: true });
    const safeGoal = deriveSafeGoalSummary(scopeProfile, scopeGoal);
    expect(() =>
      gateway.inspectAndAuthorizeRunRequest(
        {
          protocolVersion: '1.0',
          snapshotVersion: 'snap_1',
          goalVersion: 'v1',
          policyVersion: 'p_1.0',
          candidateScenarios: [
            {
              scenarioId: 'sc1',
              scenarioKind: 'original_plan',
              adjustmentTier: 'none',
              assumptionCategory: 'baseline',
              assumptionVersion: 'v1',
            },
          ],
          safeProfileSummary: summaryWithFamily,
          safeGoalSummary: safeGoal,
        },
        provider
      )
    ).toThrow(/Scope Violation.*family_summary/);

    // Requires follow_up scope for post-report follow-up
    expect(() =>
      gateway.inspectAndAuthorizeFollowUp(
        { intent: 'explain_verdict_and_risk', selectedScenarioId: 'sc1' },
        provider,
        ['sc1']
      )
    ).toThrow(/Unauthorized: Missing follow_up scope/);
  });

  it('allows closed-enum follow-up with follow_up scope and rejects free-text or unknown scenarioId (R01)', () => {
    const gateway = new PrivacyGateway();
    const provider = 'mock_provider';
    gateway.authorize({
      purpose: 'financial_planning',
      provider,
      allowedScopes: ['profile_summary', 'goal_summary', 'scenarios', 'clarification', 'follow_up'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const ok = gateway.inspectAndAuthorizeFollowUp(
      { intent: 'explain_cash_buffer_impact', selectedScenarioId: 'sc1' },
      provider,
      ['sc1', 'sc2']
    );
    expect(ok.intent).toBe('explain_cash_buffer_impact');

    // Free-text field rejected by strict schema
    expect(() =>
      gateway.inspectAndAuthorizeFollowUp(
        { intent: 'explain_verdict_and_risk', question: 'My balance is 25000 yuan' } as never,
        provider,
        ['sc1']
      )
    ).toThrow();

    // Non-allowlisted scenarioId rejected
    expect(() =>
      gateway.inspectAndAuthorizeFollowUp(
        { intent: 'explain_verdict_and_risk', focusScenarioId: 'unlisted_sc' },
        provider,
        ['sc1']
      )
    ).toThrow(/Unknown focusScenarioId/);

    // Free-text clarification tool result rejected
    expect(() =>
      gateway.inspectAndAuthorizeToolResult(
        {
          callId: 'call_1',
          toolName: 'request_clarification',
          fieldCategory: 'timing_flexibility_confirmation',
          status: 'satisfied',
          clarificationValue: 'My secret income is 50000 yuan',
          evidenceId: 'ev_1',
          versionBinding: { snapshotVersion: 'snap_1', goalVersion: 'v1', policyVersion: 'p_1.0' },
        } as never,
        provider
      )
    ).toThrow();
  });
});
