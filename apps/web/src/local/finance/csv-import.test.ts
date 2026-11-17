import { describe, it, expect } from 'vitest';
import { parseCsvRows } from './csv-import.js';
import { previewImport, applyImport, summariseMonthTransactions } from './transaction-service.js';
import type { Transaction } from './transactions.js';

describe('T7: Standard CSV Import, Deduplication & Conflict Detection (F-03)', () => {
  it('parses valid CSV with standard headers, quoted descriptions, and signed amounts', () => {
    const csv = [
      '# Synthetic test CSV export (never uploaded)',
      'date,amount,description,type',
      '2026-11-01,-1000000,"Monthly Salary, Acme Corp",income',
      '2026-11-03,350000,Apartment Rent,essential_expense',
      '2026-11-05,12000,Coffee & Snacks,',
      '2026-11-10,200000,Own account transfer,transfer_between_own_accounts',
    ].join('\n');

    const parsed = parseCsvRows(csv);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.skippedCount).toBe(0);
    expect(parsed.rows).toHaveLength(4);

    // Income stored as positive amount with type 'income'
    expect(parsed.rows[0].amount).toBe(1000000);
    expect(parsed.rows[0].suggestedType).toBe('income');
    expect(parsed.rows[0].rawDescription).toBe('Monthly Salary, Acme Corp');

    expect(parsed.rows[1].suggestedType).toBe('essential_expense');
    expect(parsed.rows[2].suggestedType).toBe('discretionary_expense');
    expect(parsed.rows[3].suggestedType).toBe('transfer_between_own_accounts');
  });

  it('supports Chinese header aliases and auto-infers type from keywords/sign', () => {
    const csv = [
      '日期,金额,描述',
      '2026-11-01,-800000,工资发放',
      '2026-11-02,150000,房贷还款',
      '2026-11-04,50000,水电燃气费',
    ].join('\n');

    const parsed = parseCsvRows(csv);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.rows[0].suggestedType).toBe('income');
    expect(parsed.rows[1].suggestedType).toBe('debt_repayment');
    expect(parsed.rows[2].suggestedType).toBe('essential_expense');
  });

  it('detects duplicate and conflicting rows via previewImport and skips exact duplicates on applyImport', () => {
    const existing: Transaction[] = [
      {
        id: 'txn_existing_1',
        date: '2026-11-01',
        amount: 350000,
        type: 'essential_expense',
        description: 'Apartment Rent',
      },
      {
        id: 'txn_existing_2',
        date: '2026-11-05',
        amount: 12000,
        type: 'discretionary_expense',
        description: 'Grocery Market',
      },
    ];

    const csv = [
      'date,amount,description,type',
      '2026-11-01,350000,Apartment Rent,essential_expense', // exact duplicate
      '2026-11-05,18000,Grocery Market,discretionary_expense', // conflict: same date+desc, different amount
      '2026-11-08,200000,Own Transfer,transfer_between_own_accounts', // unique
    ].join('\n');

    const parsed = parseCsvRows(csv);
    expect(parsed.errors).toHaveLength(0);

    const preview = previewImport(parsed.rows, existing);
    expect(preview.duplicateCount).toBe(1);
    expect(preview.conflictCount).toBe(1);
    expect(preview.newCount).toBe(1);
    expect(preview.requiresUserConfirmation).toBe(true);

    // User resolves: keep unique, skip conflict (keep: false)
    const applied = applyImport(
      preview.rows.map((r) => ({
        ...r,
        keep: r.duplicateStatus === 'unique',
      })),
      existing
    );

    // Original 2 + 1 new unique transfer = 3 (duplicate and skipped conflict ignored)
    expect(applied).toHaveLength(3);

    // Transfers excluded from cash flow totals
    const summary = summariseMonthTransactions(applied, 2026, 11);
    expect(summary.transfersExcluded).toBe(1);
    expect(summary.totalEssentialExpenses).toBe(350000);
    expect(summary.totalDiscretionaryExpenses).toBe(12000);
  });

  it('rejects bad dates, non-numeric amounts, non-integer cents, and unknown types without crashing', () => {
    const csv = [
      'date,amount,description,type',
      '2026/11/01,10000,Bad Date Format,essential_expense',
      '2026-11-02,abc,Non Numeric Amount,essential_expense',
      '2026-11-03,12.34,Float Not Cents,discretionary_expense',
      '2026-11-04,5000,Bad Type,crypto_gamble',
      '2026-11-05,5000,Valid Row,discretionary_expense',
    ].join('\n');

    const parsed = parseCsvRows(csv);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].rawDescription).toBe('Valid Row');
    expect(parsed.errors).toHaveLength(4);
    expect(parsed.skippedCount).toBe(4);
    expect(parsed.errors.map((e) => e.column)).toEqual(['date', 'amount', 'amount', 'type']);
  });

  it('returns header error when required columns are missing', () => {
    const csv = ['foo,bar,baz', '1,2,3'].join('\n');
    const parsed = parseCsvRows(csv);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].column).toBe('header');
  });
});
