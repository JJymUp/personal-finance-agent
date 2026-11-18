import { ChatStateSchema, emptyChat, type ChatState } from '../features/chat/types';
/**
 * Runtime-only Pinia Store (tech-stack.md §2).
 * NEVER auto-persists plaintext state to localStorage or sessionStorage!
 * Encrypted persistence happens strictly through ClientVault + DexieVaultStorage (IndexedDB).
 */
import { defineStore } from 'pinia';
import { ref, computed, markRaw } from 'vue';
import type { UserProfile } from '../features/profile/types';
import { validateProfile } from '../features/profile/rules';
import type { LargePurchaseGoal } from '../local/finance/calculator';
import type { Transaction } from '../local/finance/transactions';
import type { LocalFinalReport, LocalCheckpoint } from '../agent-client/client';
import { PrivacyGateway } from '../local/privacy/gateway';
import {
  MaggotVaultDatabase,
  DexieVaultStorage,
  DexieCheckpointStore,
} from '../local/vault/dexie-storage';
import {
  VAULT_CHAT_KEY,
  VAULT_GOALS_KEY,
  VAULT_TXNS_KEY,
  VAULT_REPORTS_KEY,
  ClientVault,
} from '../local/vault/vault';
import { detectVaultCapabilities } from '../local/vault/capabilities';
import { fetchServerHealth, type ServerHealthInfo } from '../api/agent-api';
import type { AuthorizationScopeName } from '@maggot/contracts';

const GOALS_KEY = VAULT_GOALS_KEY;
const TXNS_KEY = VAULT_TXNS_KEY;
const REPORTS_KEY = VAULT_REPORTS_KEY;

export interface SavedLocalReport extends LocalFinalReport {}

/**
 * R09: Initial profile MUST leave unknown quantities undefined / 'unknown',
 * NEVER defaulting deposit/income/expenses/debt to 0 / 'fixed' / 'none'.
 */
function createEmptyProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    nickname: '',
    currency: 'CNY',
    availableDeposit: undefined,
    monthlyIncome: { status: 'unknown', amount: undefined },
    debtStatus: 'unknown',
    debts: [],
    essentialExpenses: { amount: undefined, scope: 'individual', includesDebt: false },
    metadata: {
      version: 1,
      dataDate: now.slice(0, 10),
      completeness: 'draft',
      updatedAt: now,
    },
  };
}

function createDefaultGoal(): LargePurchaseGoal {
  return {
    id: 'goal_primary',
    name: '购车大额支出计划',
    currency: 'CNY',
    taskType: 'large_purchase',
    targetAmount: 8_000_000, // 80,000.00 yuan in cents
    targetHorizonMonths: 12,
    cashReserveFloor: 1_000_000, // 10,000.00 yuan in cents
    timingFlexibility: 'flexible',
    version: 'v1',
  };
}

export const useFinanceStore = defineStore('finance', () => {
  const capabilities = ref(detectVaultCapabilities());
  const db = markRaw(new MaggotVaultDatabase());
  const storage = markRaw(new DexieVaultStorage(db));
  const vault = markRaw(new ClientVault(storage));
  const checkpointStore = markRaw(new DexieCheckpointStore(db, vault));
  const gateway = markRaw(new PrivacyGateway());
  let vaultSessionGeneration = 0;
  let activeRunAbortController: AbortController | null = null;
  let clearCoordinatorHook: (() => void) | null = null;

  function captureUnlockedSession(): number {
    if (!isUnlocked.value || !vault.isUnlocked()) throw new Error('Vault is locked');
    return vaultSessionGeneration;
  }

  function assertUnlockedSession(generation: number): void {
    if (generation !== vaultSessionGeneration || !isUnlocked.value || !vault.isUnlocked()) {
      throw new Error('Vault session changed or locked during operation');
    }
  }

  function getGateway(): PrivacyGateway {
    return gateway;
  }

  function registerRunLifecycle(
    controller: AbortController | null,
    clearHook: (() => void) | null = null
  ): void {
    activeRunAbortController = controller;
    clearCoordinatorHook = clearHook;
  }

  // In-memory state ONLY while unlocked
  const isUnlocked = ref(false);
  const hasStoredVault = ref<boolean | null>(null);
  const conversation = ref<ChatState>(emptyChat());
  const profile = ref<UserProfile | null>(null);
  const goal = ref<LargePurchaseGoal>(createDefaultGoal());
  const transactions = ref<Transaction[]>([]);
  const savedReports = ref<SavedLocalReport[]>([]);
  const activeCheckpoint = ref<LocalCheckpoint | null>(null);
  const serverHealth = ref<ServerHealthInfo | null>(null);
  const authorizationVersion = ref(0);

  const profileValidation = computed(() =>
    profile.value ? validateProfile(profile.value) : null
  );

  const activeProviderId = computed(() => {
    if (!serverHealth.value) return 'mock_provider';
    return serverHealth.value.providerMode === 'openai'
      ? `openai:${serverHealth.value.provider}`
      : 'mock_provider';
  });

  const isAuthorized = computed(() => {
    // Re-evaluate when authorizationVersion increments
    void authorizationVersion.value;
    return gateway.isAuthorized(activeProviderId.value);
  });

  const profileInitialized = computed(() => profile.value !== null && validateProfile(profile.value).completeness !== 'draft');
  async function checkStoredVault(): Promise<void> { hasStoredVault.value=await vault.hasStoredVault(); }
  async function saveConversation(next: ChatState): Promise<void> {
    const generation=captureUnlockedSession();
    const validated=ChatStateSchema.parse(next);
    await vault.saveSecretJson(VAULT_CHAT_KEY,validated);
    assertUnlockedSession(generation);
    conversation.value=validated;
  }

  const currentSnapshotVersion = computed(() =>
    profile.value ? `snap_${profile.value.metadata.version}` : 'snap_0'
  );

  const hasRecoverableCheckpoint = computed(() => {
    const cp = activeCheckpoint.value;
    if (!cp) return false;
    return ['running', 'waiting_for_browser_tool', 'interrupted'].includes(cp.status) ||
      (cp.status === 'completed' && !savedReports.value.some(report => report.runId === cp.runId));
  });

  const latestReport = computed<SavedLocalReport | null>(
    () => savedReports.value[0] ?? null
  );

  const isLatestReportStale = computed(() => {
    const r = latestReport.value;
    if (!r) return false;
    return (
      r.snapshotVersion !== currentSnapshotVersion.value ||
      r.goalVersion !== goal.value.version
    );
  });

  async function refreshHealth(): Promise<ServerHealthInfo | null> {
    const prevProvider = activeProviderId.value;
    try {
      serverHealth.value = await fetchServerHealth();
      // R03: Revoke stale authorization whenever server provider/model changed
      if (activeProviderId.value !== prevProvider) {
        gateway.revoke();
        authorizationVersion.value++;
      }
      return serverHealth.value;
    } catch {
      return null;
    }
  }

  async function unlockVault(passphrase: string): Promise<boolean> {
    const generation = ++vaultSessionGeneration;
    capabilities.value = detectVaultCapabilities();
    if (!capabilities.value.isSupported) {
      throw new Error(capabilities.value.missingReasons.join('；'));
    }

    const ok = await vault.unlock(passphrase);
    if (!ok) {
      isUnlocked.value = false;
      return false;
    }

    try {
      const loadedProfile = await vault.loadProfile();
      const loadedGoal = await vault.loadSecretJson<LargePurchaseGoal>(GOALS_KEY);
      const loadedTxns = await vault.loadSecretJson<Transaction[]>(TXNS_KEY);
      const loadedReports = await vault.loadSecretJson<SavedLocalReport[]>(REPORTS_KEY);
      const loadedChat=await vault.loadSecretJson<unknown>(VAULT_CHAT_KEY);

      const restoredGoal = loadedGoal ?? createDefaultGoal();
      const checkpoint = await checkpointStore.load(restoredGoal.id);
      if (generation !== vaultSessionGeneration || !vault.isUnlocked()) {
        throw new Error('Vault session changed or locked during unlock');
      }
      conversation.value=loadedChat ? ChatStateSchema.parse(loadedChat) : emptyChat();
      conversation.value.messages=conversation.value.messages.map(message=>message.status==='pending'?{...message,status:'error',text:'上次回复中断了。你可以重新发送问题。'}:message);
      hasStoredVault.value=true;
      profile.value = loadedProfile ?? createEmptyProfile();
      goal.value = restoredGoal;
      transactions.value = loadedTxns ?? [];
      savedReports.value = loadedReports ?? [];
      activeCheckpoint.value = checkpoint;
      isUnlocked.value = true;
      await refreshHealth();
      return true;
    } catch (err) {
      if (generation === vaultSessionGeneration) lockVault();
      throw err;
    }
  }

  /** R08 / O-03: Aborts any in-flight run and clears ALL sensitive decrypted state from Pinia memory */
  function lockVault(): void {
    vaultSessionGeneration++;
    if (activeRunAbortController) {
      activeRunAbortController.abort(new Error('vault_locked'));
      activeRunAbortController = null;
    }
    if (clearCoordinatorHook) {
      clearCoordinatorHook();
      clearCoordinatorHook = null;
    }
    vault.lock();
    gateway.revoke();
    authorizationVersion.value++;
    isUnlocked.value = false;
    profile.value = null;
    conversation.value=emptyChat();
    goal.value = createDefaultGoal();
    transactions.value = [];
    savedReports.value = [];
    activeCheckpoint.value = null;
  }

  async function saveProfile(next: UserProfile): Promise<UserProfile> {
    const generation = captureUnlockedSession();
    const val = validateProfile(next);
    const updated: UserProfile = {
      ...next,
      metadata: {
        ...next.metadata,
        version: (profile.value?.metadata.version ?? 0) + 1,
        completeness: val.completeness,
        updatedAt: new Date().toISOString(),
      },
    };
    await vault.saveProfile(updated);
    assertUnlockedSession(generation);
    profile.value = updated;
    return updated;
  }

  async function loadSyntheticDemo(): Promise<void> {
    const generation = captureUnlockedSession();
    const now = new Date().toISOString();
    const demoProfile: UserProfile = {
      nickname: '合成演示用户',
      currency: 'CNY',
      availableDeposit: 2_500_000, // ¥25,000
      monthlyIncome: { status: 'fixed', amount: 1_500_000, payDay: 5 }, // ¥15,000
      debtStatus: 'has_debt',
      debts: [
        {
          id: 'demo_loan',
          name: '合成消费分期',
          currency: 'CNY',
          balance: 1_800_000,
          repaymentAmount: 200_000, // ¥2,000/月
          frequency: 'monthly',
          nextPaymentDate: '2026-11-10',
        },
      ],
      essentialExpenses: { amount: 500_000, scope: 'individual', includesDebt: false, paymentDay: 8 },
      metadata: {
        version: (profile.value?.metadata.version ?? 0) + 1,
        dataDate: '2026-11-01',
        completeness: 'task_ready',
        updatedAt: now,
      },
    };
    await vault.saveProfile(demoProfile);
    assertUnlockedSession(generation);
    profile.value = demoProfile;
  }

  async function saveGoal(nextGoal: LargePurchaseGoal): Promise<LargePurchaseGoal> {
    const generation = captureUnlockedSession();
    const { version: _oldVersion, ...oldContent } = goal.value;
    const { version: _newVersion, ...newContent } = nextGoal;
    const changed = JSON.stringify(oldContent) !== JSON.stringify(newContent);
    const currentVersion = Number(goal.value.version.replace(/^v/, '')) || 1;
    const updated = { ...nextGoal, version: changed ? `v${currentVersion + 1}` : goal.value.version };
    await vault.saveSecretJson(GOALS_KEY, updated);
    const checkpoint = await checkpointStore.load(updated.id);
    assertUnlockedSession(generation);
    goal.value = updated;
    activeCheckpoint.value = checkpoint;
    return updated;
  }

  async function saveTransactions(nextTxns: Transaction[]): Promise<void> {
    const generation = captureUnlockedSession();
    await vault.saveSecretJson(TXNS_KEY, nextTxns);
    assertUnlockedSession(generation);
    transactions.value = nextTxns;
    // Bump profile snapshot version when imported ledger changes (F-06 / O-05)
    if (profile.value) {
      await saveProfile({ ...profile.value });
    }
  }

  async function saveReport(report: LocalFinalReport): Promise<void> {
    const generation = captureUnlockedSession();
    // R14: Preserve exact snapshotVersion & goalVersion captured at run start (never relabel with live version)
    const entry: SavedLocalReport = { ...report };
    const nextList = [entry, ...savedReports.value].slice(0, 10);
    await vault.saveSecretJson(REPORTS_KEY, nextList);
    assertUnlockedSession(generation);
    savedReports.value = nextList;
  }

  function grantAuthorization(scopes: AuthorizationScopeName[]): void {
    gateway.authorize({
      purpose: 'financial_planning',
      provider: activeProviderId.value,
      allowedScopes: scopes,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    authorizationVersion.value++;
  }

  function revokeAuthorization(): void {
    gateway.revoke();
    authorizationVersion.value++;
  }

  async function exportBackup(): Promise<string> {
    return vault.exportBackup();
  }

  async function importBackup(backupJson: string, passphrase: string): Promise<UserProfile> {
    const generation = captureUnlockedSession();
    // A restored dataset must not race an in-flight analysis of the previous dataset.
    activeRunAbortController?.abort(new Error('backup_restore'));
    clearCoordinatorHook?.();
    activeRunAbortController = null;
    clearCoordinatorHook = null;
    const imported = await vault.importBackup(backupJson, passphrase);
    const loadedChat=await vault.loadSecretJson<unknown>(VAULT_CHAT_KEY);
    const loadedGoal = await vault.loadSecretJson<LargePurchaseGoal>(GOALS_KEY);
    const loadedTxns = await vault.loadSecretJson<Transaction[]>(TXNS_KEY);
    const loadedReports = await vault.loadSecretJson<SavedLocalReport[]>(REPORTS_KEY);

    const restoredGoal = loadedGoal ?? createDefaultGoal();
    const checkpoint = await checkpointStore.load(restoredGoal.id);
    assertUnlockedSession(generation);
    conversation.value=loadedChat ? ChatStateSchema.parse(loadedChat) : emptyChat();
    profile.value = imported;
    goal.value = restoredGoal;
    transactions.value = loadedTxns ?? [];
    savedReports.value = loadedReports ?? [];
    gateway.revoke();
    authorizationVersion.value++;
    activeCheckpoint.value = checkpoint;
    await refreshHealth();
    return imported;
  }

  async function refreshCheckpoint(): Promise<void> {
    const generation = captureUnlockedSession();
    const checkpoint = await checkpointStore.load(goal.value.id);
    assertUnlockedSession(generation);
    activeCheckpoint.value = checkpoint;
  }

  async function clearAllLocalData(): Promise<void> {
    lockVault();
    await vault.wipeAll();
    hasStoredVault.value=false;
    await db.checkpoint_store.clear();
    gateway.revoke();
    authorizationVersion.value++;
    isUnlocked.value = false;
    profile.value = null;
    conversation.value=emptyChat();
    goal.value = createDefaultGoal();
    transactions.value = [];
    savedReports.value = [];
    activeCheckpoint.value = null;
  }

  return {
    capabilities,
    hasStoredVault, checkStoredVault, profileInitialized, conversation, saveConversation,
    vault,
    gateway,
    hasRecoverableCheckpoint,
    getGateway,
    registerRunLifecycle,
    checkpointStore,
    isUnlocked,
    profile,
    goal,
    transactions,
    savedReports,
    activeCheckpoint,
    serverHealth,
    activeProviderId,
    isAuthorized,
    authorizationVersion,
    profileValidation,
    currentSnapshotVersion,
    latestReport,
    isLatestReportStale,
    refreshHealth,
    unlockVault,
    lockVault,
    saveProfile,
    loadSyntheticDemo,
    saveGoal,
    saveTransactions,
    saveReport,
    grantAuthorization,
    revokeAuthorization,
    exportBackup,
    importBackup,
    refreshCheckpoint,
    clearAllLocalData,
  };
});
