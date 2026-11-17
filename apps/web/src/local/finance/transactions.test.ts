import { describe, it, expect } from 'vitest';
import {
  fingerprintTransaction,
  previewImport,
  applyImport,
  summariseMonthTransactions,
} from './transaction-service.js';
import type { Transaction, TransactionImportRow } from './transactions.js';

describe('F-03: Manual transaction classification, deduplication, and monthly summary', () => {
  // Helper to build a TransactionImportRow
  function makeRow(
    rowIndex: number,
    date: string,
    amount: number,
    desc: string,
    suggestedType?: TransactionImportRow['suggestedType']
  ): TransactionImportRow {
    // fingerprintHash uses date+description only (no amount) for conflict detection
    return {
      rowIndex,
      date,
      amount,
      rawDescription: desc,
      suggestedType,
      fingerprintHash: fingerprintTransaction(date, 0, desc),
    };
  }

  const existingTxns: Transaction[] = [
    {
      id: 'txn_a',
      date: '2026-10-05',
      amount: 150000, // 1500.00
      type: 'essential_expense',
      description: 'Rent payment',
    },
    {
      id: 'txn_b',
      date: '2026-10-10',
      amount: 50000, // 500.00
      type: 'transfer_between_own_accounts',
      description: 'Move to savings',
    },
  ];

  it('F-03: Import preview identifies new, duplicate, and conflict rows correctly', () => {
    const rows = [
      // New row
      makeRow(0, '2026-10-15', 30000, 'Coffee & food', 'discretionary_expense'),
      // Exact duplicate of existing txn_a
      makeRow(1, '2026-10-05', 150000, 'Rent payment', 'essential_expense'),
      // Conflict: same date+desc but different amount
      makeRow(2, '2026-10-05', 160000, 'Rent payment', 'essential_expense'),
    ];

    const result = previewImport(rows, existingTxns);

    expect(result.newCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.conflictCount).toBe(1);
    expect(result.requiresUserConfirmation).toBe(true);

    const newRow = result.rows.find((r) => r.rowIndex === 0)!;
    expect(newRow.duplicateStatus).toBe('unique');

    const dupRow = result.rows.find((r) => r.rowIndex === 1)!;
    expect(dupRow.duplicateStatus).toBe('duplicate');
    expect(dupRow.existingTxnId).toBe('txn_a');

    const conflictRow = result.rows.find((r) => r.rowIndex === 2)!;
    expect(conflictRow.duplicateStatus).toBe('conflict');
    expect(conflictRow.conflictDetails).toContain('160000');
  });

  it('F-03: Apply import skips duplicates silently, only adds confirmed rows', () => {
    const rows = [
      { ...makeRow(0, '2026-10-15', 30000, 'Coffee & food', 'discretionary_expense'), duplicateStatus: 'unique' as const, keep: true },
      { ...makeRow(1, '2026-10-05', 150000, 'Rent payment', 'essential_expense'), duplicateStatus: 'duplicate' as const, keep: true },
      { ...makeRow(2, '2026-10-05', 160000, 'Rent payment', 'essential_expense'), duplicateStatus: 'conflict' as const, keep: false }, // user rejected
    ];

    const result = applyImport(rows, existingTxns);

    // Should add only the new row (duplicate skipped, conflict rejected)
    expect(result.length).toBe(existingTxns.length + 1);
    const newTxn = result.find((t) => t.description === 'Coffee & food');
    expect(newTxn).toBeDefined();
    expect(newTxn!.type).toBe('discretionary_expense');
  });

  it('F-03: Monthly summary correctly excludes transfers and opening balances, never double-counts', () => {
    const transactions: Transaction[] = [
      // Income
      { id: 't1', date: '2026-10-01', amount: 500000, type: 'income', description: 'Salary' },
      // Essential
      { id: 't2', date: '2026-10-05', amount: 150000, type: 'essential_expense', description: 'Rent' },
      // Debt repayment — must NOT also appear in expenses
      { id: 't3', date: '2026-10-10', amount: 100000, type: 'debt_repayment', description: 'Car loan payment' },
      // Transfer — must be excluded entirely from flows
      { id: 't4', date: '2026-10-15', amount: 50000, type: 'transfer_between_own_accounts', description: 'Move to savings' },
      // Discretionary
      { id: 't5', date: '2026-10-20', amount: 20000, type: 'discretionary_expense', description: 'Dining out' },
      // Opening balance — excluded
      { id: 't6', date: '2026-10-01', amount: 1000000, type: 'opening_balance', description: 'Starting balance' },
      // Different month — not included
      { id: 't7', date: '2026-11-01', amount: 500000, type: 'income', description: 'Next month salary' },
    ];

    const summary = summariseMonthTransactions(transactions, 2026, 10);

    expect(summary.totalIncome).toBe(500000);
    expect(summary.totalEssentialExpenses).toBe(150000);
    expect(summary.totalDebtRepayments).toBe(100000);
    expect(summary.totalDiscretionaryExpenses).toBe(20000);
    expect(summary.transfersExcluded).toBe(1);
    expect(summary.openingBalanceEntries).toBe(1);
    // Net: 500000 - 150000 - 20000 - 100000 = 230000
    expect(summary.netCashFlow).toBe(230000);
  });

  it('F-03: Traceable back to source records (sourceId preserved)', () => {
    const rows = [
      { ...makeRow(5, '2026-10-25', 8000, 'Gym membership', 'discretionary_expense'), duplicateStatus: 'unique' as const, keep: true },
    ];
    const result = applyImport(rows, []);
    expect(result[0].sourceId).toBe('import_row_5');
    expect(result[0].confirmedAt).toBeTruthy();
  });

  it('R16: Detects intra-batch duplicates, type conflicts against existing ledger, and preserves confirmed multi-entries', () => {
    const rows: TransactionImportRow[] = [
      // Intra-batch pair with identical date+amount+desc+type -> second row marked duplicate!
      makeRow(0, '2026-10-18', 25000, 'Groceries', 'essential_expense'),
      makeRow(1, '2026-10-18', 25000, 'Groceries', 'essential_expense'),
      // Same date+desc+amount as existing txn_a (150000, essential_expense), but DIFFERENT suggestedType -> conflict!
      makeRow(2, '2026-10-05', 150000, 'Rent payment', 'discretionary_expense'),
    ];

    const prev = previewImport(rows, existingTxns);
    expect(prev.rows[0].duplicateStatus).toBe('unique');
    expect(prev.rows[1].duplicateStatus).toBe('duplicate');
    expect(prev.rows[2].duplicateStatus).toBe('conflict');
    expect(prev.rows[2].conflictDetails).toContain('类型冲突');

    // When user explicitly confirms keeping the duplicate entry with keepDuplicate=true, both stay in ledger
    const applied = applyImport(
      prev.rows.map((r) => ({
        ...r,
        keep: r.rowIndex !== 2,
        keepDuplicate: r.rowIndex === 1,
      })),
      existingTxns
    );
    expect(applied.filter((t) => t.description === 'Groceries')).toHaveLength(2);
  });
});
