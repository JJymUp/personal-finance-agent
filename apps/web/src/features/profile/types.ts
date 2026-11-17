/**
 * Profile data types - Local ONLY.
 * NEVER exported to contracts or sent to Node.js / AI models!
 */

export type IncomeStatus = 'fixed' | 'variable' | 'unknown';
export type DebtStatus = 'none' | 'has_debt' | 'unknown';
export type DebtFrequency = 'monthly' | 'weekly' | 'irregular' | 'unknown';
export type ExpenseScope = 'individual' | 'household';
export type RelationshipStatus = 'single' | 'partner' | 'prefer_not_to_say';
export type PartnerContribution = 'shared' | 'independent' | 'none';
export type ProfileCompleteness = 'draft' | 'initialized' | 'task_ready';

export interface DebtItem {
  id: string;
  name?: string;
  currency?: string; // defaults to 'CNY'
  balance: number; // integer in cents (>= 0)
  repaymentAmount?: number; // integer in cents (>= 0)
  frequency: DebtFrequency;
  nextPaymentDate?: string; // YYYY-MM-DD
  remainingPeriods?: number;
}

export interface MonthlyIncome {
  status: IncomeStatus;
  amount?: number; // integer in cents (>= 0, 0 for zero income)
  isEstimate?: boolean;
  /** Optional day of month (1-31) when income arrives for intra-month liquidity tracking (R10) */
  payDay?: number;
}

export interface EssentialExpenses {
  amount?: number; // integer in cents
  isEstimate?: boolean;
  includesDebt?: boolean; // If true, deduplication is required
  scope: ExpenseScope;
  /** Optional day of month (1-31) when core expenses are paid for intra-month tracking (R10) */
  paymentDay?: number;
}

export interface FamilyInfo {
  relationshipStatus?: RelationshipStatus;
  hasChildren?: boolean;
  childcareExpenses?: number; // integer in cents
  childcareIncludedInEssential?: boolean; // default true
  elderCareExpenses?: number; // integer in cents
  elderCareIncludedInEssential?: boolean; // default true
  partnerContribution?: PartnerContribution;
}

export interface ProfileMetadata {
  version: number;
  dataDate: string; // ISO string
  completeness: ProfileCompleteness;
  updatedAt: string; // ISO string
}

export interface UserProfile {
  nickname?: string; // Local display only, NEVER transmitted
  currency?: string; // defaults to 'CNY'
  availableDeposit?: number; // integer in cents (>= 0, allows 0)
  monthlyIncome?: MonthlyIncome;
  debtStatus: DebtStatus;
  debts: DebtItem[];
  essentialExpenses?: EssentialExpenses;
  family?: FamilyInfo;
  metadata: ProfileMetadata;
}
