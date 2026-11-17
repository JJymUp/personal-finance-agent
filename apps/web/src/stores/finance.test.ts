import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Dexie } from 'dexie';
import { createPinia, setActivePinia } from 'pinia';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { ClientVault, MemoryStorage } from '../local/vault/vault';
import { useFinanceStore } from './finance';

describe('FIX-07 committed versions are owned by the store', () => {
  beforeEach(() => {
    const indexedDB = new IDBFactory();
    Dexie.dependencies.indexedDB = indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;
    vi.stubGlobal('indexedDB', indexedDB);
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('fetch', async () => { throw new Error('offline test'); });
    setActivePinia(createPinia());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the saved profile with exactly one version increment regardless of caller version', async () => {
    const store = useFinanceStore(); await store.unlockVault('synthetic-store-password');
    if (!store.profile) throw new Error('Missing profile');
    const saved = await store.saveProfile({ ...store.profile, availableDeposit: 12345,
      metadata: { ...store.profile.metadata, version: 999 } });
    expect(saved).toMatchObject({ availableDeposit: 12345, metadata: { version: 2 } });
    expect(store.profile?.metadata.version).toBe(2);
  });

  it('assigns a new goal version only when stored goal content changes', async () => {
    const store = useFinanceStore(); await store.unlockVault('synthetic-goal-password');
    const saved = await store.saveGoal({ ...store.goal, targetAmount: 12345, version: 'v999' });
    expect(saved).toMatchObject({ targetAmount: 12345, version: 'v2' });
    const unchanged = await store.saveGoal({ ...store.goal, version: 'v888' });
    expect(unchanged).toMatchObject({ version: 'v2' });
  });
  it('leaves the committed profile and version unchanged when a clarification save fails', async () => {
    const store = useFinanceStore(); await store.unlockVault('synthetic-failure-password');
    if (!store.profile) throw new Error('Missing profile');
    const before = JSON.parse(JSON.stringify(store.profile));
    vi.spyOn(store.vault, 'saveProfile').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.saveProfile({ ...store.profile, availableDeposit: 99999 })).rejects.toThrow('disk full');
    expect(JSON.parse(JSON.stringify(store.profile))).toEqual(before);
  });

  it('does not retain the previous goal when restoring a backup without one', async () => {
    const store = useFinanceStore(); await store.unlockVault('synthetic-restore');
    await store.saveGoal({ ...store.goal, targetAmount: 12345 });
    if (!store.profile) throw new Error('Missing profile');
    const source = new ClientVault(new MemoryStorage()); await source.unlock('synthetic-restore');
    await source.saveProfile({ ...store.profile, availableDeposit: 10000 });
    await store.importBackup(await source.exportBackup(), 'synthetic-restore');
    expect(store.goal.targetAmount).toBe(8_000_000);
    expect(store.transactions).toEqual([]);
    expect(store.savedReports).toEqual([]);
  });

  it('final review: a save completing after lock never rehydrates decrypted profile', async () => {
    const store = useFinanceStore(); await store.unlockVault('synthetic-lock-race');
    if (!store.profile) throw new Error('Missing profile');
    const originalSave = store.vault.saveProfile.bind(store.vault);
    let release!: () => void;
    let notifyPersisted!: () => void;
    const persisted = new Promise<void>(resolve => { notifyPersisted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(store.vault, 'saveProfile').mockImplementation(async next => {
      await originalSave(next); notifyPersisted(); await gate;
    });
    const saving = store.saveProfile({ ...store.profile, availableDeposit: 987654 });
    const assertion = expect(saving).rejects.toThrow(/locked|session/i);
    await persisted; store.lockVault(); release(); await assertion;
    expect(store.profile).toBeNull();
    expect(store.isUnlocked).toBe(false);
  });

  it('final review: offers recovery for a completed checkpoint until its local report is persisted', async () => {
    const store = useFinanceStore(); await store.unlockVault('synthetic-completed');
    store.activeCheckpoint = { runId: 'run_completed', goalId: store.goal.id, snapshotVersion: 'snap_1',
      goalVersion: 'v1', lastSequenceNumber: 6, status: 'completed', updatedAt: '2026-11-12' };
    expect(store.hasRecoverableCheckpoint).toBe(true);
    store.savedReports = [{ runId: 'run_completed', verdict: 'caution', tradeOffSummary: 'Synthetic',
      selectedScenarioId: 's', evidenceId: 'e', exactTargetAmount: 0, exactEndingCash: 0,
      exactMinimumCash: 0, exactDeficit: 0, assumptionsUsed: [], isVerified: true,
      generatedAt: '2026-11-12', snapshotVersion: 'snap_1', goalVersion: 'v1', candidateScenarioIds: ['s'] }];
    expect(store.hasRecoverableCheckpoint).toBe(false);
  });

});
