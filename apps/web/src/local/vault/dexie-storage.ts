/**
 * Dexie / IndexedDB persistent storage for browser-side encrypted records and checkpoints.
 * Never indexes or exposes plaintext financial attributes in IndexedDB schema keys.
 */
import { Dexie, type Table } from 'dexie';
import type { ClientVault, VaultStorage } from './vault.js';
import type { CheckpointStore, LocalCheckpoint } from '../../agent-client/client.js';

export interface EncryptedRecordRow {
  key: string;
  ciphertext: string;
  updatedAt: number;
}

export interface TransactionLogRow {
  id: string;
  ciphertext: string;
  updatedAt: number;
}

export interface AuthRecordRow {
  id: string;
  payload: string;
  createdAt: number;
}

export interface CheckpointRow extends LocalCheckpoint {}

export interface DexieIndexedDBOptions {
  dbName?: string;
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
}

export class MaggotVaultDatabase extends Dexie {
  encrypted_records!: Table<EncryptedRecordRow, string>;
  transaction_log!: Table<TransactionLogRow, string>;
  auth_records!: Table<AuthRecordRow, string>;
  checkpoint_store!: Table<CheckpointRow, string>;

  constructor(options: DexieIndexedDBOptions = {}) {
    const dexieOptions =
      options.indexedDB && options.IDBKeyRange
        ? { indexedDB: options.indexedDB, IDBKeyRange: options.IDBKeyRange }
        : undefined;
    super(options.dbName ?? 'maggot_finance_vault', dexieOptions);

    this.version(1).stores({
      // Only opaque keys and timestamps are indexed — zero plaintext financial fields
      encrypted_records: '&key, updatedAt',
      transaction_log: '&id, updatedAt',
      auth_records: '&id, createdAt',
      checkpoint_store: '&goalId, updatedAt',
    });
  }
}

/**
 * Wraps IndexedDB / Dexie storage errors, surfacing QuotaExceededError clearly.
 */
function wrapStorageError(action: string, err: unknown): Error {
  const name = (err as { name?: string })?.name ?? '';
  const message = (err as { message?: string })?.message ?? String(err);
  if (name === 'QuotaExceededError' || /quota/i.test(message)) {
    return new Error(`Storage quota exceeded during ${action}: ${message}`);
  }
  return new Error(`Dexie storage error during ${action}: ${message}`);
}

export class DexieVaultStorage implements VaultStorage {
  readonly db: MaggotVaultDatabase;

  constructor(dbOrOptions?: MaggotVaultDatabase | DexieIndexedDBOptions) {
    this.db =
      dbOrOptions instanceof Dexie ? dbOrOptions : new MaggotVaultDatabase(dbOrOptions);
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const row = await this.db.encrypted_records.get(key);
      return row ? row.ciphertext : null;
    } catch (err) {
      throw wrapStorageError('getItem', err);
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      await this.db.encrypted_records.put({
        key,
        ciphertext: value,
        updatedAt: Date.now(),
      });
    } catch (err) {
      throw wrapStorageError('setItem', err);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await this.db.encrypted_records.delete(key);
    } catch (err) {
      throw wrapStorageError('removeItem', err);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.db.encrypted_records.clear();
    } catch (err) {
      throw wrapStorageError('clear', err);
    }
  }

  async replaceAll(items: Record<string, string>): Promise<void> {
    try {
      await this.db.transaction('rw', this.db.encrypted_records, this.db.checkpoint_store, async () => {
        await this.db.encrypted_records.clear();
        await this.db.checkpoint_store.clear();
        const updatedAt = Date.now();
        await this.db.encrypted_records.bulkPut(
          Object.entries(items).map(([key, ciphertext]) => ({ key, ciphertext, updatedAt }))
        );
      });
    } catch (err) {
      throw wrapStorageError('replaceAll', err);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

const CP_KEY_PREFIX = 'maggot_cp_encrypted_';

/**
 * R08: Encrypted Checkpoint Store.
 * Stores checkpoints ONLY as AES-GCM ciphertext inside encrypted_records via ClientVault.
 * Never persists plaintext metadata or session tokens into IndexedDB checkpoint_store.
 */
export class DexieCheckpointStore implements CheckpointStore {
  private db: MaggotVaultDatabase;
  private vault: ClientVault;

  constructor(db: MaggotVaultDatabase, vault: ClientVault) {
    this.db = db;
    this.vault = vault;
  }

  async save(checkpoint: LocalCheckpoint): Promise<void> {
    try {
      await this.vault.saveSecretJson(`${CP_KEY_PREFIX}${checkpoint.goalId}`, checkpoint);
      // Clean up any legacy plaintext row if present
      await this.db.checkpoint_store.delete(checkpoint.goalId).catch(() => undefined);
    } catch (err) {
      throw wrapStorageError('checkpoint.save', err);
    }
  }

  async load(goalId: string): Promise<LocalCheckpoint | null> {
    try {
      return await this.vault.loadSecretJson<LocalCheckpoint>(`${CP_KEY_PREFIX}${goalId}`);
    } catch (err) {
      throw wrapStorageError('checkpoint.load', err);
    }
  }

  async clear(goalId: string): Promise<void> {
    try {
      await this.db.encrypted_records.delete(`${CP_KEY_PREFIX}${goalId}`);
      await this.db.checkpoint_store.delete(goalId).catch(() => undefined);
    } catch (err) {
      throw wrapStorageError('checkpoint.clear', err);
    }
  }
}
