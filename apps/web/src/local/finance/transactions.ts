/**
 * Manual transaction records for F-03.
 * Stored locally only, never uploaded.
 * Amount is always in smallest currency unit (cents), positive = outflow by convention unless type overrides.
 */

export type TransactionType =
  | 'income'
  | 'essential_expense'
  | 'discretionary_expense'
  | 'debt_repayment'
  | 'transfer_between_own_accounts' // Not income/expense, must NOT double-count
  | 'opening_balance'; // F-03: initial balance entry

export type DuplicateStatus = 'unique' | 'duplicate' | 'conflict';

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  amount: number; // in cents, always positive; sign derived from type
  type: TransactionType;
  description?: string;
  sourceId?: string; // original import row ID or manual entry
  relatedTransactionId?: string; // for transfers: counterpart txn ID
  confirmedAt?: string; // ISO timestamp when user reviewed/confirmed
}

export interface TransactionImportRow {
  rowIndex: number;
  date: string;
  amount: number; // in cents
  rawDescription: string;
  suggestedType?: TransactionType;
  fingerprintHash: string; // derived from date+description (NOT amount) for conflict detection
}

export interface ImportPreviewResult {
  rows: Array<
    TransactionImportRow & {
      duplicateStatus: DuplicateStatus;
      existingTxnId?: string; // if DuplicateStatus != 'unique'
      conflictDetails?: string;
    }
  >;
  newCount: number;
  duplicateCount: number;
  conflictCount: number;
  requiresUserConfirmation: boolean;
}
