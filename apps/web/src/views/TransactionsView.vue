<template>
  <div class="h5-page" data-testid="transactions-page">
    <div class="h5-card">
      <div class="h5-card-title">
        <span>本地 CSV 账单导入</span>
        <van-tag type="primary">仅浏览器本地解析</van-tag>
      </div>
      <p class="h5-muted" style="margin: 0 0 10px">
        文件仅在浏览器内解析、去重并加密保存，绝不上传原始流水至服务端或模型。导入后会自动提升画像快照版本并使旧报告失效。
      </p>

      <div class="h5-btn-row">
        <label class="van-button van-button--primary van-button--small" style="cursor: pointer">
          <span class="van-button__text">选择 CSV 文件</span>
          <input
            type="file"
            accept=".csv,text/csv"
            style="display: none"
            data-testid="csv-file-input"
            @change="handleFileChange"
          />
        </label>
        <van-button
          size="small"
          plain
          data-testid="load-sample-csv-btn"
          @click="loadSampleCsv"
        >
          加载合成示例 CSV
        </van-button>
      </div>
    </div>

    <!-- Import Preview -->
    <div v-if="preview" class="h5-card" data-testid="csv-preview-card">
      <div class="h5-card-title">
        <span>导入预览与冲突检查</span>
        <van-tag v-if="preview.conflictCount > 0" type="danger">
          发现 {{ preview.conflictCount }} 条冲突
        </van-tag>
      </div>

      <div class="h5-stat-grid" style="margin-bottom: 10px">
        <div class="h5-stat-item">
          <div class="h5-stat-label">新增条目</div>
          <div class="h5-stat-val" data-testid="preview-new-count">{{ preview.newCount }}</div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">跳过重复 / 解析忽略</div>
          <div class="h5-stat-val">
            {{ preview.duplicateCount }} / {{ parseSkipped }}
          </div>
        </div>
      </div>

      <p class="h5-muted">疑似重复默认跳过。若确认同日同额确实是另一笔交易，可打开该行“保留”开关；核对后再导入。</p>
      <van-cell-group inset>
        <van-cell
          v-for="row in preview.rows"
          :key="row.rowIndex"
          :title="`${row.date} · ${row.rawDescription || '无备注'}`"
          :label="`${row.suggestedType} | ${formatYuan(row.amount)} ${row.conflictDetails ? '(' + row.conflictDetails + ')' : ''}`"
        >
          <template #right-icon>
            <van-tag
              v-if="row.duplicateStatus === 'unique'"
              type="success"
              style="margin-right: 6px"
            >
              新增
            </van-tag>
            <van-tag
              v-else-if="row.duplicateStatus === 'duplicate'"
              type="default"
            >
              疑似重复
            </van-tag>
            <van-switch
              v-if="row.duplicateStatus === 'conflict' || row.duplicateStatus === 'duplicate'"
              v-model="conflictKeep[row.rowIndex]"
              :aria-label="row.duplicateStatus === 'duplicate' ? '确为另一笔交易，保留' : '保留冲突记录'"
              :data-testid="`keep-import-row-${row.rowIndex}`"
              size="18"
            />
          </template>
        </van-cell>
      </van-cell-group>

      <div class="h5-btn-row" style="margin-top: 12px">
        <van-button
          type="primary"
          block
          data-testid="apply-csv-btn"
          @click="handleApplyImport"
        >
          确认写入本地加密账本
        </van-button>
      </div>
    </div>

    <!-- Monthly Summary & Stored Ledger -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>本月交易汇总（{{ currentYear }}-{{ String(currentMonth).padStart(2, '0') }}）</span>
        <van-tag plain>共 {{ store.transactions.length }} 条</van-tag>
      </div>
      <div class="h5-stat-grid">
        <div class="h5-stat-item">
          <div class="h5-stat-label">收入合计</div>
          <div class="h5-stat-val">{{ formatYuan(monthSummary.totalIncome) }}</div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">必要支出</div>
          <div class="h5-stat-val">{{ formatYuan(monthSummary.totalEssentialExpenses) }}</div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">贷款偿还（单列不重复）</div>
          <div class="h5-stat-val">{{ formatYuan(monthSummary.totalDebtRepayments) }}</div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">净现金流（含内部转账排除 {{ monthSummary.transfersExcluded }}）</div>
          <div class="h5-stat-val">{{ formatYuan(monthSummary.netCashFlow) }}</div>
        </div>
      </div>

      <div v-if="store.transactions.length > 0" style="margin-top: 10px">
        <van-cell-group inset>
          <van-cell
            v-for="t in store.transactions.slice(-10).reverse()"
            :key="t.id"
            :title="`${t.date} · ${t.description || t.type}`"
            :label="t.type"
            :value="formatYuan(t.amount)"
          />
        </van-cell-group>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { showToast } from 'vant';
import { useFinanceStore } from '../stores/finance';
import { parseCsvRows } from '../local/finance/csv-import';
import {
  previewImport,
  applyImport,
  summariseMonthTransactions,
} from '../local/finance/transaction-service';
import type { ImportPreviewResult } from '../local/finance/transactions';

const store = useFinanceStore();
const preview = ref<ImportPreviewResult | null>(null);
const parseSkipped = ref(0);
const conflictKeep = reactive<Record<number, boolean>>({});

const now = new Date();
const currentYear = ref(now.getFullYear());
const currentMonth = ref(now.getMonth() + 1);

const monthSummary = computed(() =>
  summariseMonthTransactions(store.transactions, currentYear.value, currentMonth.value)
);

function formatYuan(cents: number): string {
  return `¥${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function parseRawCsv(raw: string) {
  const res = parseCsvRows(raw);
  parseSkipped.value = res.skippedCount;
  if (res.rows.length === 0) {
    showToast(res.errors[0]?.message || 'CSV 中没有可识别的有效行');
    return;
  }
  // Set summary month to first row's month for visibility
  const ym = res.rows[0].date.split('-');
  if (ym.length >= 2) {
    currentYear.value = Number(ym[0]);
    currentMonth.value = Number(ym[1]);
  }
  const prev = previewImport(res.rows, store.transactions);
  preview.value = prev;
  for (const r of prev.rows) {
    conflictKeep[r.rowIndex] = r.duplicateStatus === 'unique';
  }
}

async function handleFileChange(evt: Event) {
  const input = evt.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const text = await file.text();
  parseRawCsv(text);
  input.value = '';
}

function loadSampleCsv() {
  const ym = `${currentYear.value}-${String(currentMonth.value).padStart(2, '0')}`;
  const sample = [
    'date,amount,description,type',
    `${ym}-05,-1500000,合成月度薪资入账,income`,
    `${ym}-08,350000,合成房租与基本生活开销,essential_expense`,
    `${ym}-10,200000,合成消费分期还款,debt_repayment`,
    `${ym}-12,500000,本人储蓄卡向理财卡划转,transfer_between_own_accounts`,
  ].join('\n');
  parseRawCsv(sample);
}

async function handleApplyImport() {
  if (!preview.value) return;
  const resolved = preview.value.rows.map((r) => ({
    ...r,
    keep: r.duplicateStatus === 'unique' ? true : Boolean(conflictKeep[r.rowIndex]),
    keepDuplicate: r.duplicateStatus === 'duplicate' && Boolean(conflictKeep[r.rowIndex]),
  }));
  const nextTxns = applyImport(resolved, store.transactions);
  await store.saveTransactions(nextTxns);
  preview.value = null;
  showToast('已导入并提升画像快照版本（旧报告已自动标为过期）');
}
</script>
