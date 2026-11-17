/**
 * T7: CSV Import (F-03 CSV part)
 *
 * Parses a CSV file of transactions entirely in the browser.
 * Raw CSV data is NEVER uploaded — only the anonymous import preview is shown to the user.
 *
 * Expected CSV format (with header row):
 *   date,amount,description,type
 *
 * - date:        YYYY-MM-DD
 * - amount:      integer (smallest currency unit, cents). Positive = expense/outflow.
 *                Income rows should use a negative amount OR set type=income.
 * - description: free text (truncated to 200 chars internally)
 * - type:        optional TransactionType key — if omitted, auto-inferred from sign/keywords
 *
 * Amount sign convention: amounts in the CSV may be positive (outflow) or negative (inflow).
 * We normalise ALL stored amounts to positive and derive sign from the type field.
 */

import type { TransactionImportRow, TransactionType } from './transactions.js';
import { fingerprintTransaction } from './transaction-service.js';

export interface CsvParseError {
  rowIndex: number;    // 1-based (excluding header)
  column: string;
  message: string;
  rawLine: string;
}

export interface CsvParseResult {
  rows: TransactionImportRow[];
  errors: CsvParseError[];
  skippedCount: number; // rows skipped due to parse errors
}

// Recognised column names (case-insensitive aliases)
const COLUMN_ALIASES: Record<string, string[]> = {
  date:        ['date', '日期', 'transaction_date', 'trans_date'],
  amount:      ['amount', '金额', 'amt', 'value', 'sum'],
  description: ['description', '描述', 'desc', 'memo', 'remark', 'narration'],
  type:        ['type', '类型', 'category', 'txn_type'],
};

const VALID_TYPES = new Set<string>([
  'income',
  'essential_expense',
  'discretionary_expense',
  'debt_repayment',
  'transfer_between_own_accounts',
  'opening_balance',
]);

const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

// ─── Column resolution ────────────────────────────────────────────────────────

function resolveColumns(headerRow: string[]): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = headerRow.findIndex((h) =>
      aliases.some((a) => a === h.trim().toLowerCase())
    );
    if (key !== 'type' && idx === -1) {
      // date, amount, description are required
      return null;
    }
    if (idx !== -1) {
      result[key] = idx;
    }
  }
  return result;
}

// ─── Type inference ───────────────────────────────────────────────────────────

/**
 * Infer transaction type from sign and description keywords when type column is absent.
 */
function inferType(rawAmount: number, description: string): TransactionType {
  const desc = description.toLowerCase();
  if (rawAmount < 0) return 'income'; // negative in CSV = inflow
  if (/loan|repay|mortgage|还款|贷款/.test(desc)) return 'debt_repayment';
  if (/transfer|转账|mutual|self/.test(desc)) return 'transfer_between_own_accounts';
  if (/salary|wage|payroll|收入|工资|奖金|bonus/.test(desc)) return 'income';
  if (/rent|insurance|utility|water|electric|gas|phone|utilities|水电|租金|保险/.test(desc)) {
    return 'essential_expense';
  }
  return 'discretionary_expense';
}

// ─── CSV line parser (handles basic quoting) ──────────────────────────────────

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote inside quoted field
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a raw CSV string into TransactionImportRows.
 *
 * @param raw - Full contents of the CSV file (UTF-8 string)
 * @returns Parsed rows, errors, and count of rows skipped due to errors
 */
export function parseCsvRows(raw: string): CsvParseResult {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#')); // skip empty + comment lines

  if (lines.length === 0) {
    return { rows: [], errors: [], skippedCount: 0 };
  }

  // Parse header
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const colMap = resolveColumns(header);
  if (!colMap) {
    return {
      rows: [],
      errors: [
        {
          rowIndex: 0,
          column: 'header',
          message: 'Missing required columns. Expected at least: date, amount, description.',
          rawLine: lines[0],
        },
      ],
      skippedCount: lines.length - 1,
    };
  }

  const rows: TransactionImportRow[] = [];
  const errors: CsvParseError[] = [];
  let rowIndex = 0;

  for (let i = 1; i < lines.length; i++) {
    rowIndex++;
    const line = lines[i];
    const fields = parseCsvLine(line);

    // ── Date ──────────────────────────────────────────────────────────────────
    const rawDate = (fields[colMap.date] ?? '').trim();
    if (!DATE_RE.test(rawDate)) {
      errors.push({
        rowIndex,
        column: 'date',
        message: `Invalid date "${rawDate}" — expected YYYY-MM-DD`,
        rawLine: line,
      });
      continue;
    }

    // ── Amount ────────────────────────────────────────────────────────────────
    const rawAmountStr = (fields[colMap.amount] ?? '').trim().replace(/,/g, '');
    const rawAmountNum = Number(rawAmountStr);
    if (!rawAmountStr || !Number.isFinite(rawAmountNum)) {
      errors.push({
        rowIndex,
        column: 'amount',
        message: `Invalid amount "${rawAmountStr}" — must be a number (integer cents)`,
        rawLine: line,
      });
      continue;
    }
    if (!Number.isInteger(rawAmountNum)) {
      errors.push({
        rowIndex,
        column: 'amount',
        message: `Non-integer amount "${rawAmountNum}" — amounts must be whole cents`,
        rawLine: line,
      });
      continue;
    }
    // All stored amounts are positive; sign is encoded by type
    const amount = Math.abs(rawAmountNum);

    // ── Description ───────────────────────────────────────────────────────────
    const rawDescription = (fields[colMap.description] ?? '').trim().slice(0, 200);

    // ── Type ──────────────────────────────────────────────────────────────────
    let type: TransactionType;
    if (colMap.type !== undefined) {
      const rawType = (fields[colMap.type] ?? '').trim().toLowerCase();
      if (rawType && !VALID_TYPES.has(rawType)) {
        errors.push({
          rowIndex,
          column: 'type',
          message: `Unknown type "${rawType}" — valid values: ${[...VALID_TYPES].join(', ')}`,
          rawLine: line,
        });
        continue;
      }
      type = rawType ? (rawType as TransactionType) : inferType(rawAmountNum, rawDescription);
    } else {
      type = inferType(rawAmountNum, rawDescription);
    }

    // ── Fingerprint (date+description, NO amount) ─────────────────────────────
    const fingerprintHash = fingerprintTransaction(rawDate, 0, rawDescription);

    rows.push({
      rowIndex,
      date: rawDate,
      amount,
      rawDescription,
      suggestedType: type,
      fingerprintHash,
    });
  }

  return {
    rows,
    errors,
    skippedCount: errors.filter((e) => e.rowIndex > 0).length,
  };
}
