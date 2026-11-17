import { describe, it, expect } from 'vitest';
import {
  ClientVault,
  MemoryStorage,
  VAULT_GOALS_KEY,
  VAULT_TXNS_KEY,
  VAULT_REPORTS_KEY,
} from './vault.js';
import type { UserProfile } from '../../features/profile/types.js';

describe('Client Vault & Security (H-02, H-03, O-01, O-02, O-03)', () => {
  const sampleProfile: UserProfile = {
    nickname: 'TestUser',
    availableDeposit: 3000000,
    monthlyIncome: { status: 'fixed', amount: 1200000 },
    debtStatus: 'none',
    debts: [],
    essentialExpenses: { amount: 500000, scope: 'individual' },
    metadata: {
      version: 1,
      dataDate: '2026-11-10T00:00:00Z',
      completeness: 'task_ready',
      updatedAt: '2026-11-10T00:00:00Z',
    },
  };

  it('H-02/O-01: Encrypts data in storage without sensitive plaintext', async () => {
    const storage = new MemoryStorage();
    const vault = new ClientVault(storage);

    // Cannot save while locked
    await expect(vault.saveProfile(sampleProfile)).rejects.toThrow('Vault is locked');

    // Unlock with passphrase
    const unlocked = await vault.unlock('secure_passphrase_123');
    expect(unlocked).toBe(true);
    expect(vault.isUnlocked()).toBe(true);

    // Save profile
    await vault.saveProfile(sampleProfile);

    // Inspect storage directly to ensure no plaintext exists
    const rawStored = await storage.getItem('maggot_profile_encrypted');
    expect(rawStored).toBeTruthy();
    expect(rawStored).not.toContain('TestUser');
    expect(rawStored).not.toContain('3000000');
    expect(rawStored).not.toContain('1200000');

    // Load and verify decrypted profile
    const loaded = await vault.loadProfile();
    expect(loaded).toEqual(sampleProfile);
  });

  it('O-03: Locking clears memory passphrase and prevents unauthorized access', async () => {
    const storage = new MemoryStorage();
    const vault = new ClientVault(storage);

    await vault.unlock('test_pass');
    await vault.saveProfile(sampleProfile);

    vault.lock();
    expect(vault.isUnlocked()).toBe(false);

    // Access after lock throws
    await expect(vault.loadProfile()).rejects.toThrow('Vault is locked');

    // Wrong password fails unlock
    const wrongUnlock = await vault.unlock('wrong_pass');
    expect(wrongUnlock).toBe(false);
    expect(vault.isUnlocked()).toBe(false);

    // Correct password succeeds
    const correctUnlock = await vault.unlock('test_pass');
    expect(correctUnlock).toBe(true);
    const loaded = await vault.loadProfile();
    expect(loaded?.nickname).toBe('TestUser');
  });

  it('H-03/O-02: Export and import encrypted backup, failing safely without corrupting data', async () => {
    const storageA = new MemoryStorage();
    const vaultA = new ClientVault(storageA);
    await vaultA.unlock('pass_A');
    await vaultA.saveProfile(sampleProfile);

    // Export backup
    const backupJson = await vaultA.exportBackup();
    expect(backupJson).toContain('maggot_finance_encrypted_backup');
    expect(backupJson).not.toContain('TestUser');

    // Import into fresh vault B with wrong password fails and leaves vault clean
    const storageB = new MemoryStorage();
    const vaultB = new ClientVault(storageB);

    await expect(vaultB.importBackup(backupJson, 'wrong_pass')).rejects.toThrow(
      'Failed to decrypt backup'
    );
    expect(vaultB.isUnlocked()).toBe(false);

    // Import with correct password succeeds
    const imported = await vaultB.importBackup(backupJson, 'pass_A');
    expect(imported.nickname).toBe('TestUser');
    expect(imported.availableDeposit).toBe(3000000);

    const loadedB = await vaultB.loadProfile();
    expect(loadedB).toEqual(sampleProfile);
  });

  it('R07: Full backup bundle exports & restores goals, transactions, and reports, and rejects invalid decrypted profile without overwrite', async () => {
    const storageA = new MemoryStorage();
    const vaultA = new ClientVault(storageA);
    await vaultA.unlock('bundle_pass');
    await vaultA.saveProfile(sampleProfile);
    await vaultA.saveSecretJson(VAULT_GOALS_KEY, {
      id: 'g_saved',
      name: 'Saved Goal',
      targetAmount: 400_000,
      targetHorizonMonths: 6,
      cashReserveFloor: 100_000,
      timingFlexibility: 'flexible',
      version: 'v1',
    });
    await vaultA.saveSecretJson(VAULT_TXNS_KEY, [
      { id: 'tx_1', date: '2026-11-01', amount: 120_000, type: 'income', description: 'Salary' },
    ]);
    await vaultA.saveSecretJson(VAULT_REPORTS_KEY, [
      {
        runId: 'run_r1',
        verdict: 'viable',
        tradeOffSummary: 'ok',
        selectedScenarioId: 'sc1',
        evidenceId: 'ev_1',
        exactTargetAmount: 400_000,
        exactEndingCash: 3_000_000,
        exactMinimumCash: 2_800_000,
        exactDeficit: 0,
        assumptionsUsed: ['baseline'],
        isVerified: true,
        generatedAt: '2026-11-11T00:00:00Z',
      },
    ]);

    const fullBackup = await vaultA.exportBackup();
    const parsedBundle = JSON.parse(fullBackup);
    expect(parsedBundle.backupVersion).toBe('2.0');

    // Restore into fresh vault B
    const storageB = new MemoryStorage();
    const vaultB = new ClientVault(storageB);
    await vaultB.importBackup(fullBackup, 'bundle_pass');
    expect((await vaultB.loadSecretJson<{ id: string }>(VAULT_GOALS_KEY))?.id).toBe('g_saved');
    expect(await vaultB.loadSecretJson<unknown[]>(VAULT_TXNS_KEY)).toHaveLength(1);
    expect(await vaultB.loadSecretJson<unknown[]>(VAULT_REPORTS_KEY)).toHaveLength(1);

    // Build an encrypted backup containing invalid negative deposit -> import must fail WITHOUT overwriting existing vaultB profile
    const forgedStorage = new MemoryStorage();
    const forgedVault = new ClientVault(forgedStorage);
    await forgedVault.unlock('bad_pass');
    await forgedVault.saveSecretJson('maggot_profile_encrypted', {
      ...sampleProfile,
      availableDeposit: -500,
    });
    const invalidBackup = await forgedVault.exportBackup();

    await expect(vaultB.importBackup(invalidBackup, 'bad_pass')).rejects.toThrow(
      /Invalid decrypted backup bundle structure/i
    );
    expect(await vaultB.loadProfile()).toEqual(sampleProfile);
  });
});


it('final review: locking during an atomic restore never unlocks the vault again', async () => {
  let release!: () => void;
  let notify!: () => void;
  const committed = new Promise<void>(resolve => { notify = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedStorage extends MemoryStorage {
    async replaceAll(items: Record<string, string>): Promise<void> {
      await super.replaceAll(items); notify(); await gate;
    }
  }
  const profile: UserProfile = { availableDeposit: 10000, debtStatus: 'none', debts: [],
    metadata: { version: 1, dataDate: '2026-11-01', updatedAt: '2026-11-01', completeness: 'initialized' } };
  const source = new ClientVault(new MemoryStorage()); await source.unlock('synthetic-lock-restore');
  await source.saveProfile(profile);
  const target = new ClientVault(new DelayedStorage()); await target.unlock('synthetic-lock-restore');
  const restoring = target.importBackup(await source.exportBackup(), 'synthetic-lock-restore');
  const assertion = expect(restoring).rejects.toThrow(/locked|session/i);
  await committed; target.lock(); release(); await assertion;
  expect(target.isUnlocked()).toBe(false);
});
