import { ChatStateSchema } from '../../features/chat/types.js';
import { z } from 'zod';
import { encryptData, decryptData, type EncryptedPayload } from './crypto.js';
import type { UserProfile } from '../../features/profile/types.js';

export const VAULT_GOALS_KEY = 'maggot_goals_encrypted';
export const VAULT_TXNS_KEY = 'maggot_txns_encrypted';
export const VAULT_REPORTS_KEY = 'maggot_reports_encrypted';
export const VAULT_CHAT_KEY = 'maggot_chat_encrypted';

const DebtItemBackupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    currency: z.string().optional(),
    balance: z.number().int().min(0),
    repaymentAmount: z.number().int().min(0).optional(),
    frequency: z.enum(['monthly', 'weekly', 'irregular', 'unknown']),
    nextPaymentDate: z.string().optional(),
    remainingPeriods: z.number().int().min(0).optional(),
  })
  .strict();

export const UserProfileBackupSchema = z
  .object({
    nickname: z.string().optional(),
    currency: z.string().optional(),
    availableDeposit: z.number().int().min(0).optional(),
    monthlyIncome: z
      .object({
        status: z.enum(['fixed', 'variable', 'unknown']),
        amount: z.number().int().min(0).optional(),
        isEstimate: z.boolean().optional(),
        payDay: z.number().int().min(1).max(31).optional(),
      })
      .strict()
      .optional(),
    debtStatus: z.enum(['none', 'has_debt', 'unknown']),
    debts: z.array(DebtItemBackupSchema),
    essentialExpenses: z
      .object({
        amount: z.number().int().min(0).optional(),
        isEstimate: z.boolean().optional(),
        includesDebt: z.boolean().optional(),
        scope: z.enum(['individual', 'household']),
        paymentDay: z.number().int().min(1).max(31).optional(),
      })
      .strict()
      .optional(),
    family: z
      .object({
        relationshipStatus: z.enum(['single', 'partner', 'prefer_not_to_say']).optional(),
        hasChildren: z.boolean().optional(),
        childcareExpenses: z.number().int().min(0).optional(),
        childcareIncludedInEssential: z.boolean().optional(),
        elderCareExpenses: z.number().int().min(0).optional(),
        elderCareIncludedInEssential: z.boolean().optional(),
        partnerContribution: z.enum(['shared', 'independent', 'none']).optional(),
      })
      .strict()
      .optional(),
    metadata: z
      .object({
        version: z.number().int().min(1),
        dataDate: z.string().min(4),
        completeness: z.enum(['draft', 'initialized', 'task_ready']),
        updatedAt: z.string().min(4),
      })
      .strict(),
  })
  .strict();

const BackupGoalSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    currency: z.string().optional(),
    taskType: z.enum(['large_purchase', 'income_reduction', 'savings_goal']).optional(),
    targetAmount: z.number().int().min(0),
    targetHorizonMonths: z.number().int().min(0),
    assessmentScope: z.literal('monthly_budget').optional(),
    cashReserveFloor: z.number().int().min(0),
    timingFlexibility: z.enum(['fixed', 'flexible']),
    version: z.string().min(1),
    competingGoals: z
      .array(
        z
          .object({
            reservedAmount: z.number().int().min(0),
            horizonMonths: z.number().int().min(0),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

const BackupTransactionSchema = z
  .object({
    id: z.string().min(1),
    date: z.string().min(4),
    amount: z.number().int().min(0),
    type: z.enum([
      'income',
      'essential_expense',
      'discretionary_expense',
      'debt_repayment',
      'transfer_between_own_accounts',
      'opening_balance',
    ]),
    description: z.string().optional(),
    sourceId: z.string().optional(),
    relatedTransactionId: z.string().optional(),
    confirmedAt: z.string().optional(),
  })
  .strict();

const BackupReportSchema = z
  .object({
    runId: z.string().min(1),
    verdict: z.enum(['viable', 'caution', 'not_viable']),
    tradeOffSummary: z.string().min(1),
    selectedScenarioId: z.string().min(1),
    evidenceId: z.string().min(1),
    exactTargetAmount: z.number().int(),
    exactEndingCash: z.number().int(),
    exactMinimumCash: z.number().int(),
    exactDeficit: z.number().int(),
    assumptionsUsed: z.array(z.string()),
    isVerified: z.boolean(),
    generatedAt: z.string().min(4),
    snapshotVersion: z.string().optional(),
    goalVersion: z.string().optional(),
    candidateScenarioIds: z.array(z.string()).optional(),
    intraMonthLiquidityStatus: z.enum(['verified', 'unknown_missing_dates', 'unknown_same_day_order', 'not_assessed_monthly_budget']).optional(),
    hasUncertainPriorSpend: z.boolean().optional(),
  })
  .strict();

const FullBackupBundleSchema = z
  .object({
    bundleVersion: z.literal('2.0'),
    conversation: ChatStateSchema.optional(),
    profile: UserProfileBackupSchema,
    goal: BackupGoalSchema.nullable().optional(),
    transactions: z.array(BackupTransactionSchema).optional(),
    reports: z.array(BackupReportSchema).optional(),
    excludedCredentialsNote: z.string().optional(),
  })
  .strict();

export interface VaultStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  replaceAll(items: Record<string, string>): Promise<void>;
}

export class MemoryStorage implements VaultStorage {
  private store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
  async clear(): Promise<void> {
    this.store.clear();
  }

  async replaceAll(items: Record<string, string>): Promise<void> {
    this.store = new Map(Object.entries(items));
  }
}

export interface EncryptedBackupFile {
  type: 'maggot_finance_encrypted_backup';
  backupVersion: '1.0' | '2.0';
  exportedAt: string;
  data: EncryptedPayload;
}

const PROFILE_KEY = 'maggot_profile_encrypted';
const CHECK_TOKEN_KEY = 'maggot_vault_verification';

export class ClientVault {
  private activePassphrase: string | null = null;
  private lockGeneration = 0;
  private storage: VaultStorage;

  constructor(storage: VaultStorage = new MemoryStorage()) {
    this.storage = storage;
  }

  async hasStoredVault(): Promise<boolean> { return (await this.storage.getItem(CHECK_TOKEN_KEY)) !== null; }

  isUnlocked(): boolean {
    return this.activePassphrase !== null;
  }

  /**
   * Initializes or unlocks the vault with a user passphrase.
   * If a verification token exists, validates against it.
   */
  async unlock(passphrase: string): Promise<boolean> {
    const generation = this.lockGeneration;
    if (!passphrase || passphrase.trim().length === 0) {
      throw new Error('Passphrase cannot be empty');
    }

    const verificationPayloadStr = await this.storage.getItem(CHECK_TOKEN_KEY);
    if (verificationPayloadStr) {
      const payload: EncryptedPayload = JSON.parse(verificationPayloadStr);
      try {
        const check = await decryptData(payload, passphrase);
        if (check !== 'vault_ok') {
          return false;
        }
      } catch {
        return false;
      }
    } else {
      // First initialization: save a verification token
      const verificationPayload = await encryptData('vault_ok', passphrase);
      await this.storage.setItem(CHECK_TOKEN_KEY, JSON.stringify(verificationPayload));
    }

    if (generation !== this.lockGeneration) return false;
    this.activePassphrase = passphrase;
    return true;
  }

  /**
   * Locks the vault and purges active passphrase from memory
   */
  lock(): void {
    this.lockGeneration++;
    this.activePassphrase = null;
  }

  /**
   * Encrypts and persists user profile into storage
   */
  async saveProfile(profile: UserProfile): Promise<void> {
    if (!this.activePassphrase) {
      throw new Error('Vault is locked. Cannot save profile.');
    }

    const serialized = JSON.stringify(profile);
    const encrypted = await encryptData(serialized, this.activePassphrase);
    await this.storage.setItem(PROFILE_KEY, JSON.stringify(encrypted));
  }

  /**
   * Loads and decrypts user profile from storage
   */
  async loadProfile(): Promise<UserProfile | null> {
    if (!this.activePassphrase) {
      throw new Error('Vault is locked. Cannot load profile.');
    }

    const encryptedStr = await this.storage.getItem(PROFILE_KEY);
    if (!encryptedStr) {
      return null;
    }

    const payload: EncryptedPayload = JSON.parse(encryptedStr);
    const decrypted = await decryptData(payload, this.activePassphrase);
    return JSON.parse(decrypted) as UserProfile;
  }

  /**
   * Encrypts and persists an arbitrary local JSON structure (goals, transactions, reports)
   * under an opaque storage key while vault is unlocked.
   */
  async saveSecretJson<T>(storageKey: string, data: T): Promise<void> {
    if (!this.activePassphrase) {
      throw new Error('Vault is locked. Cannot save encrypted record.');
    }
    const encrypted = await encryptData(JSON.stringify(data), this.activePassphrase);
    await this.storage.setItem(storageKey, JSON.stringify(encrypted));
  }

  /**
   * Loads and decrypts an arbitrary local JSON structure while vault is unlocked.
   */
  async loadSecretJson<T>(storageKey: string): Promise<T | null> {
    if (!this.activePassphrase) {
      throw new Error('Vault is locked. Cannot load encrypted record.');
    }
    const encryptedStr = await this.storage.getItem(storageKey);
    if (!encryptedStr) return null;
    const payload: EncryptedPayload = JSON.parse(encryptedStr);
    const decrypted = await decryptData(payload, this.activePassphrase);
    return JSON.parse(decrypted) as T;
  }

  /**
   * Clears all locally persisted vault records (only after explicit user confirmation).
   */
  async wipeAll(): Promise<void> {
    await this.storage.clear();
    this.lock();
  }

  /**
   * Exports a full versioned encrypted backup bundle covering profile, goal,
   * transactions, and local verified reports (excluding ephemeral session tokens).
   */
  async exportBackup(): Promise<string> {
    if (!this.activePassphrase) {
      throw new Error('Vault is locked. Unlock to export backup.');
    }

    const profile = await this.loadProfile();
    if (!profile) {
      throw new Error('No profile data to export');
    }

    const goal = await this.loadSecretJson<unknown>(VAULT_GOALS_KEY);
    const transactions = await this.loadSecretJson<unknown[]>(VAULT_TXNS_KEY);
    const reports = await this.loadSecretJson<unknown[]>(VAULT_REPORTS_KEY);
    const conversation = await this.loadSecretJson<unknown>(VAULT_CHAT_KEY);

    const bundle = {
      bundleVersion: '2.0' as const,
      ...(conversation !== null ? {conversation} : {}),
      profile,
      ...(goal !== null ? { goal } : {}),
      ...(transactions !== null ? { transactions } : {}),
      ...(reports !== null ? { reports } : {}),
      excludedCredentialsNote:
        'ephemeral_session_tokens_and_active_authorizations_not_exported',
    };

    const encrypted = await encryptData(JSON.stringify(bundle), this.activePassphrase);
    const backup: EncryptedBackupFile = {
      type: 'maggot_finance_encrypted_backup',
      backupVersion: '2.0',
      exportedAt: new Date().toISOString(),
      data: encrypted,
    };

    return JSON.stringify(backup, null, 2);
  }

  /**
   * Imports and strictly validates an encrypted backup string before touching storage.
   * Rejects malformed structures, bad versions, or decryption errors without mutating existing records (R07).
   */
  async importBackup(backupJson: string, backupPassphrase: string): Promise<UserProfile> {
    const generation = this.lockGeneration;
    let backup: EncryptedBackupFile;
    try {
      backup = JSON.parse(backupJson);
    } catch {
      throw new Error('Invalid backup file: not valid JSON');
    }

    if (
      backup?.type !== 'maggot_finance_encrypted_backup' ||
      (backup.backupVersion !== '1.0' && backup.backupVersion !== '2.0')
    ) {
      throw new Error('Unsupported or corrupted backup format');
    }

    // Attempt to decrypt with provided backup passphrase
    let decryptedStr: string;
    try {
      decryptedStr = await decryptData(backup.data, backupPassphrase);
    } catch {
      throw new Error('Failed to decrypt backup: wrong passphrase or corrupted payload');
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(decryptedStr);
    } catch {
      throw new Error('Decrypted content is not valid JSON');
    }

    // Strictly validate payload schema BEFORE unlocking or touching any storage key (R07)
    let validatedProfile: UserProfile;
    let validatedGoal: unknown | undefined;
    let validatedTxns: unknown[] | undefined;
    let validatedReports: unknown[] | undefined;
    let validatedChat: unknown | undefined;

    if (backup.backupVersion === '2.0') {
      const bundleRes = FullBackupBundleSchema.safeParse(parsedContent);
      if (!bundleRes.success) {
        throw new Error(
          `Invalid decrypted backup bundle structure: ${bundleRes.error.issues[0]?.message ?? 'schema mismatch'}`
        );
      }
      validatedProfile = bundleRes.data.profile;
      validatedChat = bundleRes.data.conversation;
      validatedGoal = bundleRes.data.goal ?? undefined;
      validatedTxns = bundleRes.data.transactions;
      validatedReports = bundleRes.data.reports;
    } else {
      // Legacy 1.0 backup must strictly match UserProfile schema
      const profRes = UserProfileBackupSchema.safeParse(parsedContent);
      if (!profRes.success) {
        throw new Error(
          `Invalid decrypted profile structure: ${profRes.error.issues[0]?.message ?? 'schema mismatch'}`
        );
      }
      validatedProfile = profRes.data;
    }

    // Prepare every ciphertext before opening the database transaction. No partial writes or
    // best-effort compensating rollback: either the whole replacement commits or nothing does.
    const passphrase = this.activePassphrase ?? backupPassphrase;
    if (!this.activePassphrase) {
      const verification = await this.storage.getItem(CHECK_TOKEN_KEY);
      if (verification && await decryptData(JSON.parse(verification), passphrase) !== 'vault_ok') {
        throw new Error('Vault unlock failed with existing verification key');
      }
    }
    const items: Record<string, string> = {};
    const records: Record<string, unknown> = {
      [PROFILE_KEY]: validatedProfile,
      [VAULT_TXNS_KEY]: validatedTxns ?? [],
      [VAULT_REPORTS_KEY]: validatedReports ?? [],
      ...(validatedChat ? {[VAULT_CHAT_KEY]:validatedChat} : {}),
      ...(validatedGoal !== undefined ? { [VAULT_GOALS_KEY]: validatedGoal } : {}),
    };
    items[CHECK_TOKEN_KEY] = JSON.stringify(await encryptData('vault_ok', passphrase));
    for (const [key, value] of Object.entries(records)) {
      items[key] = JSON.stringify(await encryptData(JSON.stringify(value), passphrase));
    }
    // Ephemeral checkpoints and authorizations intentionally do not survive a backup restore.
    if (generation !== this.lockGeneration) throw new Error('Vault locked during restore');
    await this.storage.replaceAll(items);
    if (generation !== this.lockGeneration) throw new Error('Vault locked during restore');
    this.activePassphrase = passphrase;

    return validatedProfile;
  }
}
