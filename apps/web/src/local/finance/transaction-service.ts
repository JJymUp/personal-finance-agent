import type {
  Transaction,
  TransactionImportRow,
  ImportPreviewResult,
  DuplicateStatus,
  TransactionType,
} from './transactions.js';

/**
 * Generates a lightweight fingerprint for deduplication.
 * Uses date + first 40 chars of normalized description (NOT amount).
 * This allows detecting "same record, different amount or type" as a conflict.
 * NOT cryptographic — only for fast dedup check.
 */
export function fingerprintTransaction(date: string, _amount: number, description: string): string {
  const desc = description.trim().toLowerCase().slice(0, 40);
  return `${date}|${desc}`;
}

interface SeenBatchEntry {
  rowIndex: number;
  amount: number;
  type: TransactionType;
  fingerprintHash: string;
}

/**
 * F-03 / R16: Preview imported rows against BOTH existing transactions and earlier rows in the same batch.
 * - Exact duplicate: same date + desc fingerprint, same amount, AND same type
 * - Conflict: same date + desc fingerprint with DIFFERENT amount OR DIFFERENT type
 * - Does NOT apply changes — user must confirm
 */
export function previewImport(
  rows: TransactionImportRow[],
  existingTransactions: Transaction[]
): ImportPreviewResult {
  // Store arrays so legitimate same-description records aren't overwritten or hidden
  const existingByFingerprint = new Map<string, Transaction[]>();
  for (const txn of existingTransactions) {
    const fp = fingerprintTransaction(txn.date, 0, txn.description ?? '');
    const list = existingByFingerprint.get(fp) ?? [];
    list.push(txn);
    existingByFingerprint.set(fp, list);
  }

  const batchByFingerprint = new Map<string, SeenBatchEntry[]>();

  let newCount = 0;
  let duplicateCount = 0;
  let conflictCount = 0;
  let requiresUserConfirmation = false;

  const annotatedRows = rows.map((row) => {
    const rowType: TransactionType = row.suggestedType ?? 'discretionary_expense';
    const fp = row.fingerprintHash || fingerprintTransaction(row.date, 0, row.rawDescription);
    const existingList = existingByFingerprint.get(fp) ?? [];
    const batchList = batchByFingerprint.get(fp) ?? [];

    let duplicateStatus: DuplicateStatus = 'unique';
    let existingTxnId: string | undefined;
    let conflictDetails: string | undefined;

    // 1. Check exact match (same amount AND same type) in history first, then intra-batch
    const exactHist = existingList.find((e) => e.amount === row.amount && e.type === rowType);
    const exactBatch = batchList.find((b) => b.amount === row.amount && b.type === rowType);

    if (exactHist) {
      duplicateStatus = 'duplicate';
      existingTxnId = exactHist.id;
      duplicateCount++;
    } else if (exactBatch) {
      duplicateStatus = 'duplicate';
      existingTxnId = `batch_row_${exactBatch.rowIndex}`;
      conflictDetails = `批内第 ${exactBatch.rowIndex} 行与当前行日期/描述/金额/类型完全一致`;
      duplicateCount++;
      requiresUserConfirmation = true;
    } else if (existingList.length > 0 || batchList.length > 0) {
      // 2. Check conflicts (same fingerprint, different amount OR different type)
      const histMismatch = existingList[0];
      const batchMismatch = batchList[0];
      duplicateStatus = 'conflict';
      conflictCount++;
      requiresUserConfirmation = true;

      if (histMismatch) {
        existingTxnId = histMismatch.id;
        const reasons: string[] = [];
        if (histMismatch.amount !== row.amount) {
          reasons.push(`金额差异 (已有 ${histMismatch.amount} vs 导入 ${row.amount})`);
        }
        if (histMismatch.type !== rowType) {
          reasons.push(`类型冲突 (已有 ${histMismatch.type} vs 导入 ${rowType})`);
        }
        conflictDetails = `历史账本冲突: ${reasons.join('，')}`;
      } else if (batchMismatch) {
        existingTxnId = `batch_row_${batchMismatch.rowIndex}`;
        const reasons: string[] = [];
        if (batchMismatch.amount !== row.amount) {
          reasons.push(`金额差异 (行${batchMismatch.rowIndex}: ${batchMismatch.amount} vs ${row.amount})`);
        }
        if (batchMismatch.type !== rowType) {
          reasons.push(`类型冲突 (行${batchMismatch.rowIndex}: ${batchMismatch.type} vs ${rowType})`);
        }
        conflictDetails = `同批导入冲突: ${reasons.join('，')}`;
      }
    } else {
      newCount++;
    }

    batchList.push({
      rowIndex: row.rowIndex,
      amount: row.amount,
      type: rowType,
      fingerprintHash: fp,
    });
    batchByFingerprint.set(fp, batchList);

    return { ...row, duplicateStatus, existingTxnId, conflictDetails };
  });

  if (conflictCount > 0) {
    requiresUserConfirmation = true;
  }

  return {
    rows: annotatedRows,
    newCount,
    duplicateCount,
    conflictCount,
    requiresUserConfirmation,
  };
}

/**
 * F-03 / R16: Applies a confirmed import.
 * Skips accidental duplicates by default unless user explicitly confirms keepDuplicate=true
 * (preserving legitimate same-day same-description multiple transactions when confirmed).
 */
export function applyImport(
  resolvedRows: Array<
    TransactionImportRow & {
      duplicateStatus: DuplicateStatus;
      keep: boolean;
      keepDuplicate?: boolean;
      sourceAccount?: string;
    }
  >,
  existingTransactions: Transaction[]
): Transaction[] {
  const added: Transaction[] = [];
  for (const row of resolvedRows) {
    if (row.duplicateStatus === 'duplicate' && !row.keepDuplicate) {
      continue;
    }
    if (!row.keep) {
      continue;
    }
    const sourceSuffix = row.sourceAccount ? `_${row.sourceAccount}` : '';
    added.push({
      id: `txn_${row.rowIndex}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      date: row.date,
      amount: row.amount,
      type: row.suggestedType ?? 'discretionary_expense',
      description: row.rawDescription,
      sourceId: `import_row_${row.rowIndex}${sourceSuffix}`,
      confirmedAt: new Date().toISOString(),
    });
  }
  return [...existingTransactions, ...added];
}

/**
 * F-03: Monthly summary of transactions, correctly categorising and NOT double-counting.
 * - transfer_between_own_accounts: excluded from both income and expense totals
 * - debt_repayment: counted as expense (outflow), NOT also as expense elsewhere
 * - opening_balance: excluded from flow calculations
 */
export interface MonthlyCashSummary {
  year: number;
  month: number; // 1-12
  totalIncome: number; // in cents
  totalEssentialExpenses: number; // in cents
  totalDiscretionaryExpenses: number; // in cents
  totalDebtRepayments: number; // in cents
  transfersExcluded: number; // count of transfers excluded
  openingBalanceEntries: number; // count excluded
  netCashFlow: number; // income - essential - discretionary - debt
}

export function summariseMonthTransactions(
  transactions: Transaction[],
  year: number,
  month: number
): MonthlyCashSummary {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;

  let totalIncome = 0;
  let totalEssentialExpenses = 0;
  let totalDiscretionaryExpenses = 0;
  let totalDebtRepayments = 0;
  let transfersExcluded = 0;
  let openingBalanceEntries = 0;

  for (const txn of transactions) {
    if (!txn.date.startsWith(prefix)) continue;

    switch (txn.type) {
      case 'income':
        totalIncome += txn.amount;
        break;
      case 'essential_expense':
        totalEssentialExpenses += txn.amount;
        break;
      case 'discretionary_expense':
        totalDiscretionaryExpenses += txn.amount;
        break;
      case 'debt_repayment':
        // Counted once as outflow — never also in expenses
        totalDebtRepayments += txn.amount;
        break;
      case 'transfer_between_own_accounts':
        // Excluded from all flows — not income, not expense
        transfersExcluded++;
        break;
      case 'opening_balance':
        openingBalanceEntries++;
        break;
    }
  }

  return {
    year,
    month,
    totalIncome,
    totalEssentialExpenses,
    totalDiscretionaryExpenses,
    totalDebtRepayments,
    transfersExcluded,
    openingBalanceEntries,
    netCashFlow: totalIncome - totalEssentialExpenses - totalDiscretionaryExpenses - totalDebtRepayments,
  };
}
