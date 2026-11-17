import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ClientVault, MemoryStorage, VAULT_GOALS_KEY } from './vault.js';
import {
  MaggotVaultDatabase,
  DexieVaultStorage,
  DexieCheckpointStore,
} from './dexie-storage.js';
import type { UserProfile } from '../../features/profile/types.js';

describe('Dexie Persistent Storage (IndexedDB via fake-indexeddb)', () => {
  let dbFactory: IDBFactory;
  let dbName: string;
  let db: MaggotVaultDatabase;
  let storage: DexieVaultStorage;

  const sampleProfile: UserProfile = {
    nickname: 'DexieUser',
    availableDeposit: 4_200_000,
    monthlyIncome: { status: 'fixed', amount: 1_500_000 },
    debtStatus: 'none',
    debts: [],
    essentialExpenses: { amount: 600_000, scope: 'individual' },
    metadata: {
      version: 1,
      dataDate: '2026-11-11T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-11T00:00:00Z',
    },
  };

  beforeEach(() => {
    dbFactory = new IDBFactory();
    dbName = `test_maggot_db_${Math.random().toString(36).slice(2)}`;
    db = new MaggotVaultDatabase({
      dbName,
      indexedDB: dbFactory,
      IDBKeyRange,
    });
    storage = new DexieVaultStorage(db);
  });

  afterEach(async () => {
    db.close();
  });

  it('persists encrypted profile across vault lock/unlock and new DB instance', async () => {
    const vault1 = new ClientVault(storage);
    expect(await vault1.unlock('strong_pass_99')).toBe(true);
    await vault1.saveProfile(sampleProfile);
    vault1.lock();

    // Verify raw IndexedDB row contains zero plaintext PII/financial values
    const rawRow = await db.encrypted_records.get('maggot_profile_encrypted');
    expect(rawRow).toBeDefined();
    expect(rawRow?.ciphertext).not.toContain('DexieUser');
    expect(rawRow?.ciphertext).not.toContain('4200000');

    // Close and reopen a fresh MaggotVaultDatabase pointing at the same IDBFactory
    db.close();
    const reopenedDb = new MaggotVaultDatabase({
      dbName,
      indexedDB: dbFactory,
      IDBKeyRange,
    });
    const vault2 = new ClientVault(new DexieVaultStorage(reopenedDb));
    expect(await vault2.unlock('strong_pass_99')).toBe(true);
    const loaded = await vault2.loadProfile();
    expect(loaded).toEqual(sampleProfile);
    reopenedDb.close();
  });

  it('rejects wrong passphrase against persisted IndexedDB verification record', async () => {
    const vault = new ClientVault(storage);
    await vault.unlock('correct_pass');
    await vault.saveProfile(sampleProfile);
    vault.lock();

    const vaultWrong = new ClientVault(new DexieVaultStorage(db));
    const ok = await vaultWrong.unlock('wrong_pass');
    expect(ok).toBe(false);
    expect(vaultWrong.isUnlocked()).toBe(false);
    await expect(vaultWrong.loadProfile()).rejects.toThrow('Vault is locked');
  });

  it('surfaces clear storage quota error when IndexedDB write fails with QuotaExceededError', async () => {
    const quotaError = new Error('Simulated disk full');
    quotaError.name = 'QuotaExceededError';

    const spy = vi.spyOn(db.encrypted_records, 'put').mockRejectedValueOnce(quotaError);

    await expect(storage.setItem('some_key', 'some_val')).rejects.toThrow(/Storage quota exceeded/);
    spy.mockRestore();

    // R08: Encrypted-only checkpoint storage through unlocked vault
    const vault = new ClientVault(storage);
    await vault.unlock('cp_strong_pass');
    const cpStore = new DexieCheckpointStore(db, vault);
    await cpStore.save({
      runId: 'run_cp_secret_1',
      goalId: 'goal_cp_1',
      snapshotVersion: 'snap_1',
      goalVersion: 'v1',
      lastSequenceNumber: 3,
      status: 'waiting_for_browser_tool',
      updatedAt: '2026-11-11T00:00:00Z',
    });
    const rawCipherRow = await db.encrypted_records.get('maggot_cp_encrypted_goal_cp_1');
    expect(rawCipherRow).toBeDefined();
    expect(rawCipherRow?.ciphertext).not.toContain('run_cp_secret_1');
    expect(await db.checkpoint_store.get('goal_cp_1')).toBeUndefined();

    const loadedCp = await cpStore.load('goal_cp_1');
    expect(loadedCp?.runId).toBe('run_cp_secret_1');
  });
  it('FIX-02 aborts the entire backup replacement when storage fails after the profile write', async () => {
    const oldVault = new ClientVault(storage);
    await oldVault.unlock('synthetic-atomic-password');
    await oldVault.saveProfile(sampleProfile);
    const oldGoal = { id: 'old_goal', name: 'Old', targetAmount: 10000, targetHorizonMonths: 1,
      cashReserveFloor: 0, timingFlexibility: 'fixed', version: 'v1' };
    await oldVault.saveSecretJson(VAULT_GOALS_KEY, oldGoal);
    const oldRows = await db.encrypted_records.toArray();

    const source = new ClientVault(new MemoryStorage());
    await source.unlock('synthetic-atomic-password');
    await source.saveProfile({ ...sampleProfile, availableDeposit: 9000000 });
    await source.saveSecretJson(VAULT_GOALS_KEY, { ...oldGoal, name: 'New' });
    const backup = await source.exportBackup();
    let failing = false;
    const failWrite = (key: unknown) => {
      if (key === VAULT_GOALS_KEY) failing = true;
      if (failing) throw new Error('synthetic persistent storage failure');
    };
    const updateHook = (_changes: unknown, key: unknown) => failWrite(key);
    const createHook = (key: unknown) => failWrite(key);
    db.encrypted_records.hook('updating', updateHook);
    db.encrypted_records.hook('creating', createHook);
    await expect(oldVault.importBackup(backup, 'synthetic-atomic-password')).rejects.toThrow();
    expect(await db.encrypted_records.toArray()).toEqual(oldRows);
    expect(await oldVault.loadProfile()).toEqual(sampleProfile);
    db.encrypted_records.hook('updating').unsubscribe(updateHook);
    db.encrypted_records.hook('creating').unsubscribe(createHook);
  });

});
