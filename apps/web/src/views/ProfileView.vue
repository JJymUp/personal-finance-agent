<template>
  <div class="h5-page" data-testid="profile-page">
    <!-- Local Financial Overview (No Cloud Calls - U-06) -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>本地财务概况</span>
        <van-tag :type="completenessTagType" data-testid="completeness-tag">
          {{ completenessLabel }}
        </van-tag>
      </div>
      <div class="h5-stat-grid">
        <div class="h5-stat-item">
          <div class="h5-stat-label">可用存款</div>
          <div class="h5-stat-val" data-testid="summary-deposit">
            {{
              store.profile?.availableDeposit !== undefined
                ? formatMoney(store.profile.availableDeposit, store.profile.currency)
                : '未填写'
            }}
          </div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">预计月结余（本地计算）</div>
          <div class="h5-stat-val" data-testid="summary-surplus">
            {{ localSurplusDisplay }}
          </div>
        </div>
      </div>
      <div v-if="currencyError" style="margin-top: 8px">
        <van-notice-bar color="#ee0a24" background="#fff1f0" wrapable :scrollable="false">
          {{ currencyError }}
        </van-notice-bar>
      </div>
      <div v-else-if="store.profileValidation?.warnings.length" style="margin-top: 8px">
        <van-notice-bar
          v-for="(w, idx) in store.profileValidation.warnings"
          :key="idx"
          wrapable
          :scrollable="false"
        >
          {{ w }}
        </van-notice-bar>
      </div>
      <div class="h5-btn-row" style="margin-top: 10px">
        <van-button
          size="small"
          plain
          type="primary"
          data-testid="load-demo-btn"
          @click="handleLoadDemo"
        >
          一键填入合成演示画像
        </van-button>
        <van-button size="small" plain @click="handleLock">
          锁定金库
        </van-button>
      </div>
      <p class="h5-muted" style="margin: 6px 0 0">
        所有精确金额与称呼仅加密保存在本机浏览器，初始化和编辑不触发任何云端请求。
      </p>
    </div>

    <!-- Foundation Profile Form (U-01 ~ U-05) -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>基础画像（v{{ store.profile?.metadata.version ?? 1 }}）</span>
        <span class="h5-muted">数据日期 {{ form.dataDate }}</span>
      </div>

      <van-cell-group inset>
        <van-field
          v-model="form.nickname"
          label="本地称呼"
          placeholder="可选，仅本机展示，绝不上传"
          data-testid="input-nickname"
        />

        <van-cell title="本位币种（统一币种计算）">
          <template #value>
            <van-radio-group v-model="form.currency" direction="horizontal">
              <van-radio name="CNY">CNY (¥)</van-radio>
              <van-radio name="USD">USD ($)</van-radio>
            </van-radio-group>
          </template>
        </van-cell>

        <van-field
          v-model="form.depositYuan"
          type="text"
          inputmode="decimal"
          label="可用存款(元)"
          placeholder="必填；若确实为 0 请显式输入 0"
          data-testid="input-deposit"
        />

        <van-cell title="月收入状态">
          <template #label>固定 / 不固定 / 未知均分开记录</template>
          <template #value>
            <van-radio-group v-model="form.incomeStatus" direction="horizontal">
              <van-radio name="fixed">固定</van-radio>
              <van-radio name="variable">不固定</van-radio>
              <van-radio name="unknown">未知</van-radio>
            </van-radio-group>
          </template>
        </van-cell>

        <van-field
          v-if="form.incomeStatus !== 'unknown'"
          v-model="form.incomeYuan"
          type="text"
          inputmode="decimal"
          :label="form.incomeStatus === 'variable' ? '估计月入(元)' : '到手月薪(元)'"
          placeholder="若确实无收入请显式输入 0"
          data-testid="input-income"
        />

        <van-field
          v-if="form.incomeStatus !== 'unknown'"
          v-model="form.payDayStr"
          type="digit"
          label="发薪日(可选)"
          placeholder="1-31 日，用于月内现金流顺序判断"
        />

        <van-field
          v-model="form.expenseYuan"
          type="text"
          inputmode="decimal"
          label="基本月开销(元)"
          placeholder="可暂跳过；缺省时不输出可行结论"
          data-testid="input-expenses"
        />

        <van-field
          v-model="form.expensePayDayStr"
          type="digit"
          label="支出日(可选)"
          placeholder="1-31 日，如月初 1 号房租"
        />

        <van-cell title="开销统计口径">
          <template #value>
            <van-radio-group v-model="form.expenseScope" direction="horizontal">
              <van-radio name="individual">个人口径</van-radio>
              <van-radio name="household">家庭汇总</van-radio>
            </van-radio-group>
          </template>
        </van-cell>

        <van-cell title="生活费已含还款（自动去重）">
          <template #right-icon>
            <van-switch v-model="form.includesDebt" size="20" />
          </template>
        </van-cell>

        <van-cell title="贷款状态">
          <template #value>
            <van-radio-group v-model="form.debtStatus" direction="horizontal">
              <van-radio name="none">无贷款</van-radio>
              <van-radio name="has_debt">有贷款</van-radio>
              <van-radio name="unknown">暂不清楚</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
      </van-cell-group>

      <!-- Conditional Debt List (U-05) -->
      <div v-if="form.debtStatus === 'has_debt'" style="margin-top: 10px">
        <div class="h5-card-title" style="font-size: 13px">
          <span>贷款明细 ({{ form.debts.length }} 笔)</span>
          <van-button size="mini" type="primary" plain @click="addDebt">
            + 添加一笔
          </van-button>
        </div>

        <div
          v-for="(debt, idx) in form.debts"
          :key="debt.id"
          style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; margin-bottom: 8px"
        >
          <van-field v-model="debt.name" label="名称" placeholder="如：消费分期" />
          <van-field v-model="debt.currency" label="币种" placeholder="CNY / USD" />
          <van-field v-model="debt.balanceYuan" type="text" inputmode="decimal" label="剩余本金(元)" />
          <van-field v-model="debt.repaymentYuan" type="text" inputmode="decimal" label="每期还款(元)" />
          <van-cell title="还款频率">
            <template #value>
              <van-radio-group v-model="debt.frequency" direction="horizontal">
                <van-radio name="monthly">每月</van-radio>
                <van-radio name="weekly">每周</van-radio>
                <van-radio name="irregular">不固定</van-radio>
                <van-radio name="unknown">未知</van-radio>
              </van-radio-group>
            </template>
          </van-cell>
          <van-field
            v-if="debt.frequency === 'weekly' || debt.frequency === 'monthly'"
            v-model="debt.nextPaymentDate"
            label="下次还款日"
            placeholder="YYYY-MM-DD（仅向未来展开，周供按日历计算）"
          />
          <van-field
            v-if="debt.frequency === 'weekly' || debt.frequency === 'monthly'"
            v-model="debt.remainingPeriodsStr"
            type="digit"
            label="剩余期数(可选)"
            placeholder="如剩 3 期，到期后停止扣款"
          />
          <div style="text-align: right; margin-top: 4px">
            <van-button size="mini" type="danger" plain @click="removeDebt(idx)">
              删除该笔
            </van-button>
          </div>
        </div>
      </div>

      <!-- Optional Progressive Family Info (U-03 / R09: unknown preserved as unknown) -->
      <van-collapse v-model="familyPanel" style="margin-top: 10px">
        <van-collapse-item title="家庭与负担背景（可选，跳过保留未知）" name="family">
          <van-cell title="个人关系状态">
            <template #value>
              <van-radio-group v-model="form.relationshipStatus" direction="horizontal">
                <van-radio name="single">单身</van-radio>
                <van-radio name="partner">有伴侣</van-radio>
                <van-radio name="prefer_not_to_say">暂不填写</van-radio>
              </van-radio-group>
            </template>
          </van-cell>
          <van-cell title="是否养育子女">
            <template #value>
              <van-radio-group v-model="form.hasChildrenChoice" direction="horizontal">
                <van-radio name="unknown">未填写</van-radio>
                <van-radio name="no">无子女</van-radio>
                <van-radio name="yes">有子女</van-radio>
              </van-radio-group>
            </template>
          </van-cell>
        </van-collapse-item>
      </van-collapse>

      <div style="margin-top: 12px">
        <van-button
          type="primary"
          block
          data-testid="save-profile-btn"
          @click="handleSave"
        >
          保存本地加密画像
        </van-button>
      </div>
    </div>

    <!-- Encrypted Backup & Restore (H-03 / O-02) -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>加密备份与恢复</span>
      </div>
      <p class="h5-muted" style="margin: 0 0 8px">
        浏览器站点数据可能被清理，建议定期导出 AES-GCM 加密备份文件。忘记解锁口令将无法恢复。
      </p>
      <div class="h5-btn-row">
        <van-button size="small" type="primary" plain @click="handleExportBackup">
          导出加密备份
        </van-button>
        <van-button size="small" plain @click="showImportPopup = true">
          导入恢复备份
        </van-button>
      </div>
      <div v-if="exportedPreview" style="margin-top: 8px">
        <div class="h5-mono-box">{{ exportedPreview }}</div>
      </div>
    </div>

    <van-popup v-model:show="showImportPopup" round position="bottom" style="padding: 16px">
      <div class="h5-card-title">从加密备份恢复（校验失败不覆盖现有数据）</div>
      <van-field
        v-model="importJson"
        type="textarea"
        rows="4"
        label="备份 JSON"
        placeholder="粘贴导出的加密备份 JSON"
      />
      <van-field
        v-model="importPassphrase"
        type="password"
        label="备份口令"
        placeholder="输入生成该备份时的本地口令"
      />
      <div class="h5-btn-row" style="margin-top: 12px">
        <van-button block type="primary" @click="handleImportBackup">验证并恢复</van-button>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { showToast } from 'vant';
import { useFinanceStore } from '../stores/finance';
import { validateProfile } from '../features/profile/rules';
import { calculateMonthlySurplus } from '../local/finance/calculator';
import type {
  UserProfile,
  DebtFrequency,
  IncomeStatus,
  DebtStatus,
  ExpenseScope,
  RelationshipStatus,
} from '../features/profile/types';

interface DebtFormRow {
  id: string;
  name: string;
  currency: string;
  balanceYuan: string;
  repaymentYuan: string;
  frequency: DebtFrequency;
  nextPaymentDate: string;
  remainingPeriodsStr: string;
}

const store = useFinanceStore();
const familyPanel = ref<string[]>([]);
const exportedPreview = ref('');
const showImportPopup = ref(false);
const importJson = ref('');
const importPassphrase = ref('');

const form = reactive({
  nickname: '',
  currency: 'CNY',
  depositYuan: '',
  incomeStatus: 'unknown' as IncomeStatus,
  incomeYuan: '',
  payDayStr: '',
  expenseYuan: '',
  expensePayDayStr: '',
  expenseScope: 'individual' as ExpenseScope,
  includesDebt: false,
  debtStatus: 'unknown' as DebtStatus,
  debts: [] as DebtFormRow[],
  relationshipStatus: 'prefer_not_to_say' as RelationshipStatus,
  hasChildrenChoice: 'unknown' as 'unknown' | 'yes' | 'no',
  dataDate: new Date().toISOString().slice(0, 10),
});

/** R15: Lossless integer-cents -> yuan string (preserves .01 / .45 without rounding to integer) */
function formatCentsExact(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = Math.abs(cents % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

function parseStrictCents(
  yuanStr: string,
  fieldLabel: string
): { value: number | undefined; error?: string } {
  const trimmed = yuanStr.trim();
  if (!trimmed) return { value: undefined };
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    return { value: undefined, error: `${fieldLabel}格式不正确（请输入非负数字，最多两位小数）` };
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 0) {
    return { value: undefined, error: `${fieldLabel}超出安全整数范围` };
  }
  return { value: cents };
}

function parseOptionalDay(
  dayStr: string,
  fieldLabel: string
): { value: number | undefined; error?: string } {
  const trimmed = dayStr.trim();
  if (!trimmed) return { value: undefined };
  if (!/^\d+$/.test(trimmed)) return { value: undefined, error: `${fieldLabel}必须为 1-31 的整数` };
  const n = Number(trimmed);
  if (n < 1 || n > 31) return { value: undefined, error: `${fieldLabel}必须在 1 到 31 之间` };
  return { value: n };
}

function syncFormFromProfile(p: UserProfile | null) {
  if (!p) return;
  form.nickname = p.nickname ?? '';
  form.currency = p.currency ?? 'CNY';
  form.depositYuan = p.availableDeposit !== undefined ? formatCentsExact(p.availableDeposit) : '';
  form.incomeStatus = p.monthlyIncome?.status ?? 'unknown';
  form.incomeYuan =
    p.monthlyIncome?.amount !== undefined ? formatCentsExact(p.monthlyIncome.amount) : '';
  form.payDayStr = p.monthlyIncome?.payDay !== undefined ? String(p.monthlyIncome.payDay) : '';
  form.expenseYuan =
    p.essentialExpenses?.amount !== undefined
      ? formatCentsExact(p.essentialExpenses.amount)
      : '';
  form.expensePayDayStr =
    p.essentialExpenses?.paymentDay !== undefined ? String(p.essentialExpenses.paymentDay) : '';
  form.expenseScope = p.essentialExpenses?.scope ?? 'individual';
  form.includesDebt = p.essentialExpenses?.includesDebt ?? false;
  form.debtStatus = p.debtStatus;
  form.debts = p.debts.map((d) => ({
    id: d.id,
    name: d.name ?? '',
    currency: d.currency ?? p.currency ?? 'CNY',
    balanceYuan: formatCentsExact(d.balance),
    repaymentYuan: d.repaymentAmount !== undefined ? formatCentsExact(d.repaymentAmount) : '',
    frequency: d.frequency,
    nextPaymentDate: d.nextPaymentDate ?? '',
    remainingPeriodsStr: d.remainingPeriods !== undefined ? String(d.remainingPeriods) : '',
  }));
  form.relationshipStatus = p.family?.relationshipStatus ?? 'prefer_not_to_say';
  form.hasChildrenChoice =
    p.family?.hasChildren === true ? 'yes' : p.family?.hasChildren === false ? 'no' : 'unknown';
  form.dataDate = p.metadata.dataDate.slice(0, 10);
}

watch(
  () => store.profile,
  (p) => syncFormFromProfile(p),
  { immediate: true }
);

function buildProfileObjectStrict(): { profile?: UserProfile; error?: string } {
  const prev = store.profile;

  const dep = parseStrictCents(form.depositYuan, '可用存款');
  if (dep.error) return { error: dep.error };

  const inc =
    form.incomeStatus === 'unknown'
      ? { value: undefined }
      : parseStrictCents(form.incomeYuan, '月收入');
  if (inc.error) return { error: inc.error };

  const payDay = parseOptionalDay(form.payDayStr, '发薪日');
  if (payDay.error) return { error: payDay.error };

  const exp = parseStrictCents(form.expenseYuan, '基本月开销');
  if (exp.error) return { error: exp.error };

  const expDay = parseOptionalDay(form.expensePayDayStr, '支出日');
  if (expDay.error) return { error: expDay.error };

  const parsedDebts: UserProfile['debts'] = [];
  if (form.debtStatus === 'has_debt') {
    for (const d of form.debts) {
      const bal = parseStrictCents(d.balanceYuan, `贷款「${d.name || '未命名'}」剩余本金`);
      if (bal.error || bal.value === undefined) {
        return { error: bal.error ?? `请填写贷款「${d.name || '未命名'}」剩余本金` };
      }
      const rep = parseStrictCents(d.repaymentYuan, `贷款「${d.name || '未命名'}」每期还款`);
      if (rep.error) return { error: rep.error };

      let remainingPeriods: number | undefined;
      if (d.remainingPeriodsStr.trim()) {
        if (!/^\d+$/.test(d.remainingPeriodsStr.trim())) {
          return { error: `贷款「${d.name || '未命名'}」剩余期数必须为非负整数` };
        }
        remainingPeriods = Number(d.remainingPeriodsStr.trim());
      }

      parsedDebts.push({
        id: d.id,
        name: d.name.trim() || '贷款',
        currency: d.currency.trim().toUpperCase() || form.currency,
        balance: bal.value,
        repaymentAmount: rep.value,
        frequency: d.frequency,
        nextPaymentDate: d.nextPaymentDate.trim() || undefined,
        ...(remainingPeriods !== undefined ? { remainingPeriods } : {}),
      });
    }
  }

  return {
    profile: {
      nickname: form.nickname.trim(),
      currency: form.currency || 'CNY',
      availableDeposit: dep.value,
      monthlyIncome: {
        status: form.incomeStatus,
        amount: inc.value,
        isEstimate: form.incomeStatus === 'variable',
        ...(payDay.value !== undefined ? { payDay: payDay.value } : {}),
      },
      debtStatus: form.debtStatus,
      debts: parsedDebts,
      essentialExpenses: {
        amount: exp.value,
        scope: form.expenseScope,
        includesDebt: form.includesDebt,
        ...(expDay.value !== undefined ? { paymentDay: expDay.value } : {}),
      },
      family: {
        relationshipStatus: form.relationshipStatus,
        ...(form.hasChildrenChoice !== 'unknown'
          ? { hasChildren: form.hasChildrenChoice === 'yes' }
          : {}),
      },
      metadata: {
        version: prev?.metadata.version ?? 1,
        dataDate: form.dataDate || new Date().toISOString().slice(0, 10),
        completeness: prev?.metadata.completeness ?? 'draft',
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

const currencyError = computed(() => {
  if (!store.profile) return '';
  try {
    calculateMonthlySurplus(store.profile);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
});

const localSurplusDisplay = computed(() => {
  if (!store.profile) return '—';
  if (store.profileValidation?.completeness !== 'task_ready') {
    return '待补充口径/开销';
  }
  try {
    const res = calculateMonthlySurplus(store.profile);
    return formatMoney(res.monthlySurplus, store.profile.currency);
  } catch {
    return '币种冲突';
  }
});

const completenessLabel = computed(() => {
  const c = store.profileValidation?.completeness;
  if (c === 'task_ready') return '可测算';
  if (c === 'initialized') return '已初始化 · 待补完整信息';
  return '草稿 · 待确认';
});

const completenessTagType = computed<'success' | 'primary' | 'warning'>(() => {
  const c = store.profileValidation?.completeness;
  if (c === 'task_ready') return 'success';
  if (c === 'initialized') return 'primary';
  return 'warning';
});

function formatMoney(cents: number, currency = 'CNY'): string {
  const symbol = currency.toUpperCase() === 'USD' ? '$' : '¥';
  return `${symbol}${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function addDebt() {
  form.debts.push({
    id: `debt_${Date.now().toString(36)}`,
    name: `贷款 ${form.debts.length + 1}`,
    currency: form.currency,
    balanceYuan: '',
    repaymentYuan: '',
    frequency: 'monthly',
    nextPaymentDate: '',
    remainingPeriodsStr: '',
  });
}

function removeDebt(idx: number) {
  form.debts.splice(idx, 1);
}

async function handleSave() {
  const built = buildProfileObjectStrict();
  if (built.error || !built.profile) {
    showToast(built.error || '输入有误');
    return;
  }
  const check = validateProfile(built.profile);
  if (!check.isValid) {
    showToast(check.errors[0] || '输入有误');
    return;
  }
  try {
    await store.saveProfile(built.profile);
    showToast('已加密保存到本机 IndexedDB');
  } catch (err) {
    showToast((err as Error).message);
  }
}

async function handleLoadDemo() {
  await store.loadSyntheticDemo();
  showToast('已填入合成演示画像（仅测试用）');
}

function handleLock() {
  store.lockVault();
  showToast('已锁定并清除内存明文');
}

async function handleExportBackup() {
  try {
    const json = await store.exportBackup();
    exportedPreview.value = json;
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(json).catch(() => undefined);
    }
    showToast('已生成加密备份（并尝试复制到剪贴板）');
  } catch (err) {
    showToast((err as Error).message);
  }
}

async function handleImportBackup() {
  try {
    await store.importBackup(importJson.value, importPassphrase.value);
    showImportPopup.value = false;
    importPassphrase.value = '';
    showToast('加密备份恢复成功');
  } catch (err) {
    showToast((err as Error).message);
  }
}
</script>
