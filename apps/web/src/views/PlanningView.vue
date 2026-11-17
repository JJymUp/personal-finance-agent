<template>
  <div class="h5-page" data-testid="planning-page">
    <!-- Completeness Guard -->
    <van-notice-bar
      v-if="store.profileValidation?.completeness !== 'task_ready'"
      color="#ed6a0c"
      background="#fffbe8"
      wrapable
      :scrollable="false"
    >
      基础画像尚未满足测算条件（需填妥存款、收入状态、无冲突生活开销与贷款状态）。仅可预览本地规则提示，不输出已验证可行性结论。
    </van-notice-bar>

    <!-- Interrupted Checkpoint Recovery -->
    <div
      v-if="store.hasRecoverableCheckpoint && !isRunning"
      class="h5-card"
      data-testid="checkpoint-banner"
    >
      <div class="h5-card-title">
        <span>发现未完成的本地检查点</span>
        <van-tag type="warning">{{ checkpointStatusLabel }}</van-tag>
      </div>
      <p class="h5-muted" style="margin: 0 0 8px">
        上次任务于快照 {{ store.activeCheckpoint?.snapshotVersion }} / 目标
        {{ store.activeCheckpoint?.goalVersion }} 中断。可优先尝试凭原会话凭证重连服务端并沿用预算续跑；若服务端会话已失效或数据已修改，将在确认后安全处理。
      </p>
      <div class="h5-btn-row">
        <van-button
          size="small"
          type="primary"
          data-testid="resume-checkpoint-btn"
          @click="handleResumeCheckpoint(false)"
        >
          续接上次规划
        </van-button>
        <van-button size="small" plain @click="clearCheckpoint">丢弃检查点</van-button>
      </div>
    </div>

    <!-- Goal Configuration -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>规划目标设置（{{ goalForm.version }}）</span>
        <van-tag plain>{{ taskTypeLabel }}</van-tag>
      </div>

      <van-cell-group inset>
        <van-cell title="核心场景">
          <template #value>
            <van-radio-group v-model="goalForm.taskType" direction="horizontal">
              <van-radio name="large_purchase">大额支出</van-radio>
              <van-radio name="income_reduction">降薪缓冲</van-radio>
              <van-radio name="savings_goal">储蓄目标</van-radio>
            </van-radio-group>
          </template>
        </van-cell>

        <van-field v-model="goalForm.name" label="目标名称" placeholder="如：家庭购车计划" />

        <van-field
          v-model="goalForm.targetYuan"
          type="number"
          :label="goalForm.taskType === 'income_reduction' ? '总收入缺口(元)' : '目标金额(元)'"
          data-testid="goal-amount-input"
        />

        <van-field
          v-model="goalForm.horizonMonths"
          type="number"
          label="规划月数（含本月）"
          data-testid="goal-horizon-input"
        />

        <van-field
          v-model="goalForm.reserveFloorYuan"
          type="number"
          label="现金底线(元)"
          data-testid="goal-reserve-input"
        />

        <van-field
          v-model="goalForm.competingReserveYuan"
          type="number"
          label="其他目标占用(元)"
          placeholder="可选：为其他既定目标预留的资金池"
        />

        <van-cell title="时间弹性">
          <template #value>
            <van-radio-group v-model="goalForm.timingFlexibility" direction="horizontal">
              <van-radio name="flexible">可推迟</van-radio>
              <van-radio name="fixed">不可改期</van-radio>
            </van-radio-group>
          </template>
        </van-cell>
      </van-cell-group>

      <div class="h5-btn-row" style="margin-top: 10px">
        <van-button size="small" plain data-testid="save-goal-btn" @click="handleSaveGoal">
          保存目标（升级版本）
        </van-button>
        <van-button
          size="small"
          type="primary"
          :loading="isRunning"
          :disabled="store.profileValidation?.completeness !== 'task_ready'"
          data-testid="preview-outbound-btn"
          @click="openOutboundPreview"
        >
          预览出站摘要并启动 Agent
        </van-button>
      </div>
    </div>

    <p class="h5-muted">余额按资料日期当天结束时点计算；规划月数包含当月，目标支出安排在最后一个月月末。已发生的收支不重复计入。</p>

    <!-- Local Deterministic Baseline (No AI) -->
    <div v-if="localBaseline" class="h5-card">
      <div class="h5-card-title">
        <span>本地确定性测算预览（纯浏览器计算）</span>
        <van-tag :type="localBaseline.isSatisfied ? 'success' : 'danger'">
          {{ !localBaseline.isReliable ? '信息不足，暂不能核验' : localBaseline.isSatisfied ? '原计划满足底线' : '原计划触碰底线' }}
        </van-tag>
      </div>
      <div class="h5-stat-grid">
        <div class="h5-stat-item">
          <div class="h5-stat-label">{{ localBaseline.intraMonthLiquidityStatus === 'verified' ? '期间最低预计现金' : '月末余额估算（期内未核验）' }}</div>
          <div class="h5-stat-val">{{ fmtMoney(localBaseline.minimumProjectedCash) }}</div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">资金缺口</div>
          <div class="h5-stat-val">{{ fmtMoney(localBaseline.cashDeficit) }}</div>
        </div>
      </div>
    </div>

    <!-- Live Agent Execution Timeline -->
    <div v-if="eventLog.length > 0" class="h5-card" data-testid="agent-timeline-card">
      <div class="h5-card-title">
        <span>Agent 执行进度</span>
        <van-button
          v-if="isRunning"
          size="mini"
          type="danger"
          plain
          @click="handleCancelRun"
        >
          取消任务
        </van-button>
      </div>
      <van-cell-group inset>
        <van-cell
          v-for="item in eventLog"
          :key="`${item.runId}:${item.seq}`"
          :title="`#${item.seq} ${item.title}`"
          :label="item.detail"
        />
      </van-cell-group>
    </div>

    <!-- Verified Local Final Report (Exact Figures Interpolated Locally) -->
    <div v-if="displayedReport" class="h5-card" data-testid="verified-report-card">
      <div class="h5-card-title">
        <span>本地验证报告</span>
        <van-tag :type="verdictTagType" data-testid="report-verdict-tag">
          {{ verdictLabel }} · {{ displayedReport.isVerified ? '本地已核验' : '未完全验证' }}
        </van-tag>
      </div>

      <van-notice-bar
        v-if="store.isLatestReportStale"
        color="#ee0a24"
        background="#fff1f0"
        wrapable
        :scrollable="false"
        style="margin-bottom: 8px"
        data-testid="stale-report-banner"
      >
        画像或目标版本已更新（当前 {{ store.currentSnapshotVersion }} / {{ store.goal.version }}），本报告基于旧快照生成，已失效，请重新运行规划。
      </van-notice-bar>

      <van-notice-bar
        v-if="
          displayedReport.intraMonthLiquidityStatus &&
          displayedReport.intraMonthLiquidityStatus !== 'verified'
        "
        color="#ed6a0c"
        background="#fffbe8"
        wrapable
        :scrollable="false"
        style="margin-bottom: 8px"
        data-testid="intramonth-notice"
      >
        {{
          displayedReport.intraMonthLiquidityStatus === 'unknown_same_day_order'
            ? '同日收支先后顺序无法仅凭日期确认，请留意月中现金时点缓冲。'
            : '当前缺少完整收支日期，仅提供月末算术估算，不能确认期间最低现金或方案可行性。'
        }}
      </van-notice-bar>

      <van-notice-bar
        v-if="displayedReport.hasUncertainPriorSpend"
        color="#ed6a0c"
        background="#fffbe8"
        wrapable
        :scrollable="false"
        style="margin-bottom: 8px"
      >
        本次续接运行在失去服务端原会话状态后重启，此前是否发生过额外模型请求无法完全确认。
      </van-notice-bar>

      <div class="h5-stat-grid" style="margin-bottom: 10px">
        <div class="h5-stat-item">
          <div class="h5-stat-label">选中方案有效金额</div>
          <div class="h5-stat-val">{{ fmtMoney(displayedReport.exactTargetAmount) }}</div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">期末预计现金</div>
          <div class="h5-stat-val" data-testid="report-ending-cash">
            {{ fmtMoney(displayedReport.exactEndingCash) }}
          </div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">{{ displayedReport.intraMonthLiquidityStatus === 'verified' ? '期间最低现金' : '月末余额估算（期内未核验）' }}</div>
          <div class="h5-stat-val">{{ fmtMoney(displayedReport.exactMinimumCash) }}</div>
        </div>
        <div class="h5-stat-item">
          <div class="h5-stat-label">资金缺口</div>
          <div class="h5-stat-val">{{ fmtMoney(displayedReport.exactDeficit) }}</div>
        </div>
      </div>

      <p style="font-size: 13px; margin: 0 0 8px; line-height: 1.55" data-testid="report-summary">
        {{ displayedReport.tradeOffSummary }}
      </p>
      <div class="h5-muted" style="margin-bottom: 6px">
        <strong>选中方案：</strong>{{ displayedReport.selectedScenarioId }}
        <br />
        <strong>版本绑定：</strong>{{ displayedReport.snapshotVersion }} /
        {{ displayedReport.goalVersion }}
      </div>
      <div class="h5-muted" style="margin-bottom: 8px">
        <strong>关键假设与边界：</strong>{{ displayedReport.assumptionsUsed.join('；') }}
      </div>

      <van-collapse v-model="devTraceOpen">
        <van-collapse-item title="开发者调试详情（核验凭证与技术状态）" name="trace">
          <div class="h5-muted">
            isVerified={{ displayedReport.isVerified }} · evidenceId={{ displayedReport.evidenceId }}
            · intraMonth={{ displayedReport.intraMonthLiquidityStatus ?? 'unknown' }}
          </div>
        </van-collapse-item>
      </van-collapse>
    </div>

    <!-- Structured Post-Report Follow-up -->
    <div
      v-if="displayedReport && activeCoordinator && !store.isLatestReportStale"
      class="h5-card"
      data-testid="followup-card"
    >
      <div class="h5-card-title">
        <span>围绕报告继续追问（结构化安全模式）</span>
        <van-tag plain>仅发送预定义意图</van-tag>
      </div>
      <div v-for="(msg, idx) in followUpLog" :key="idx" style="margin-bottom: 8px">
        <div style="font-size: 12px; font-weight: 600">问：{{ msg.intentLabel }}</div>
        <div style="font-size: 12px; color: #334155; margin-top: 2px" data-testid="followup-answer">
          答：{{ msg.answer }}
        </div>
        <div class="h5-muted" style="font-size: 11px">
          引用凭证：{{ msg.citedEvidenceId }} · 限制：{{ msg.limitationsNoted.join('；') }}
        </div>
      </div>

      <van-cell-group inset style="margin-bottom: 8px">
        <van-cell title="选择追问问题">
          <template #label>
            <van-radio-group v-model="selectedFollowUpIntent" data-testid="followup-intent-group">
              <van-radio
                v-for="opt in FOLLOW_UP_INTENT_OPTIONS"
                :key="opt.value"
                :name="opt.value"
                style="margin-top: 6px"
                :data-testid="`followup-intent-${opt.value}`"
              >
                {{ opt.label }}
              </van-radio>
            </van-radio-group>
          </template>
        </van-cell>
        <van-cell
          v-if="(displayedReport.candidateScenarioIds?.length ?? 0) > 0"
          title="关注备选方案（可选）"
        >
          <template #label>
            <van-radio-group v-model="selectedFollowUpScenarioId" direction="horizontal">
              <van-radio name="">默认选中方案</van-radio>
              <van-radio
                v-for="sid in displayedReport.candidateScenarioIds"
                :key="sid"
                :name="sid"
              >
                {{ sid }} ({{ isScenarioEvaluated(sid) ? '已测算' : '未测算' }})
              </van-radio>
            </van-radio-group>
            <div
              v-if="selectedFollowUpScenarioId && !isScenarioEvaluated(selectedFollowUpScenarioId)"
              style="margin-top: 4px; font-size: 11px; color: #d97706"
            >
              提示：该备选方案尚未在本轮中完成沙箱测算，追问将说明其逻辑差异与重新测算的前提条件。
            </div>
          </template>
        </van-cell>
      </van-cell-group>

      <van-button
        size="small"
        type="primary"
        block
        :loading="isFollowUpLoading"
        data-testid="followup-send-btn"
        @click="handleSendFollowUp"
      >
        发送结构化追问
      </van-button>
    </div>

    <!-- Outbound Preview & Authorization Modal -->
    <van-popup
      v-model:show="showAuthModal"
      round
      position="bottom"
      style="padding: 16px"
      data-testid="auth-preview-popup"
    >
      <div class="h5-card-title">
        <span>出站摘要授权确认</span>
        <van-tag type="primary">{{ store.activeProviderId }}</van-tag>
      </div>
      <p class="h5-muted" style="margin: 0 0 8px">
        以下为本次将发送给服务端与模型服务的全部脱敏摘要内容，不包含您的存款精确数字、交易明细或称呼：
      </p>
      <van-checkbox
        v-model="includeFamilyScope"
        style="margin-bottom: 8px; font-size: 13px"
        data-testid="include-family-scope-checkbox"
      >
        额外授权发送脱敏后的家庭抚养负担分类（默认不发送）
      </van-checkbox>
      <div class="h5-mono-box" data-testid="outbound-preview-json">{{ outboundPreviewText }}</div>
      <div class="h5-btn-row" style="margin-top: 12px">
        <van-button
          type="primary"
          block
          data-testid="confirm-authorize-btn"
          @click="confirmAndRunAgent"
        >
          授权并运行 Agent 规划
        </van-button>
        <van-button block plain @click="showAuthModal = false">取消</van-button>
      </div>
    </van-popup>

    <!-- Interactive Clarification Popup (Structured Enums Only) -->
    <van-popup
      v-model:show="showClarifyModal"
      round
      position="bottom"
      :close-on-click-overlay="false"
      style="padding: 16px"
      data-testid="clarification-popup"
    >
      <div class="h5-card-title">请补充确认一项规划偏好</div>
      <p class="h5-muted" style="margin: 0 0 8px">
        待确认类别：{{ clarifyCategoryLabel }}
      </p>

      <van-cell-group v-if="pendingClarifyCategory === 'expense_refinement'" inset>
        <van-field v-model="clarifyExpenseYuan" type="number" label="实际月开销(元)" data-testid="clarify-expense-input" />
        <van-cell title="上述开销已包含还款"><template #right-icon><van-switch v-model="clarifyIncludesDebt" /></template></van-cell>
        <p class="h5-muted">金额只在本地保存；提交后将重新生成经授权的摘要。</p>
      </van-cell-group>
      <van-radio-group v-else v-model="selectedClarifyChoice" style="margin-bottom: 10px">
        <van-radio
          v-for="opt in clarifyChoiceOptions"
          :key="opt.value"
          :name="opt.value"
          style="margin-top: 6px"
        >
          {{ opt.label }}
        </van-radio>
      </van-radio-group>

      <van-cell title="若不方便补充，可选择跳过原因">
        <template #label>
          <van-radio-group v-model="selectedDeclineCategory" direction="horizontal">
            <van-radio name="prefer_not_to_share_flexibility">暂不透露时间弹性</van-radio>
            <van-radio name="prefer_not_to_refine_expense">暂不细化支出</van-radio>
            <van-radio name="user_declined_clarification">暂时跳过</van-radio>
          </van-radio-group>
        </template>
      </van-cell>

      <div class="h5-btn-row" style="margin-top: 12px">
        <van-button size="small" type="primary" :loading="isSavingClarification" @click="resolveClarify('answer')">
          提交结构化确认
        </van-button>
        <van-button
          v-if="pendingClarifyCategory === 'timing_flexibility_confirmation' && goalForm.timingFlexibility !== 'fixed'"
          size="small"
          type="warning"
          plain
          @click="resolveClarify('modify_input')"
        >
          期限延后 +3 个月重算
        </van-button>
        <van-button size="small" plain @click="resolveClarify('decline')">
          跳过此项确认
        </van-button>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import type {
  AgentEvent,
  BrowserToolRequest,
  ClarificationChoice,
  FollowUpIntent,
  FollowUpResponse,
  GoalTaskType,
  RejectionCategory,
} from '@maggot/contracts';
import { useFinanceStore, type SavedLocalReport } from '../stores/finance';
import {
  generateCandidateScenarios,
  evaluateScenarioLocal,
  type LargePurchaseGoal,
} from '../local/finance/calculator';
import { deriveSafeProfileSummary, deriveSafeGoalSummary } from '../local/privacy/summary';
import {
  ClientAgentCoordinator,
  type LocalFinalReport,
  type StructuredClarificationDecision,
} from '../agent-client/client';
import { createBrowserAgentTransport } from '../api/agent-api';
import type { HttpClientTransport } from '../agent-client/http-transport';

const store = useFinanceStore();

function formatCentsExact(cents: number): string {
  const fixed = (cents / 100).toFixed(2);
  return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function parseStrictCents(raw: string, fieldLabel: string, minCents = 0): number {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error(`${fieldLabel}不能为空`);
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`${fieldLabel}格式无效，请输入非负数字（最多两位小数）`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < minCents) {
    throw new Error(`${fieldLabel}需不低于 ¥${formatCentsExact(minCents)}`);
  }
  return cents;
}

const goalForm = reactive({
  id: 'goal_primary',
  name: '购车大额支出计划',
  taskType: 'large_purchase' as GoalTaskType,
  targetYuan: '80000',
  horizonMonths: '12',
  reserveFloorYuan: '10000',
  competingReserveYuan: '0',
  timingFlexibility: 'flexible' as 'fixed' | 'flexible',
  version: 'v1',
});

watch(
  () => store.goal,
  (g) => {
    goalForm.id = g.id;
    goalForm.name = g.name;
    goalForm.taskType = g.taskType ?? 'large_purchase';
    goalForm.targetYuan = formatCentsExact(g.targetAmount);
    goalForm.horizonMonths = String(g.targetHorizonMonths);
    goalForm.reserveFloorYuan = formatCentsExact(g.cashReserveFloor);
    goalForm.competingReserveYuan = formatCentsExact(g.competingGoals?.[0]?.reservedAmount ?? 0);
    goalForm.timingFlexibility = g.timingFlexibility;
    goalForm.version = g.version;
  },
  { immediate: true }
);

function buildGoalObject(bumpVersion = false): LargePurchaseGoal {
  const verNum = Number(goalForm.version.replace(/^v/, '')) || 1;
  const nextVersion = bumpVersion ? `v${verNum + 1}` : goalForm.version;
  const targetAmount = parseStrictCents(goalForm.targetYuan, '目标金额', 100);
  const reserveFloor = parseStrictCents(goalForm.reserveFloorYuan, '现金底线', 0);
  const competingCents = goalForm.competingReserveYuan.trim()
    ? parseStrictCents(goalForm.competingReserveYuan, '其他目标占用', 0)
    : 0;

  const horizonNum = Number(String(goalForm.horizonMonths).trim());
  if (!Number.isInteger(horizonNum) || horizonNum < 1 || horizonNum > 120) {
    throw new Error('目标期限须为 1~120 的整数个月');
  }

  return {
    id: goalForm.id,
    name: goalForm.name.trim() || '规划目标',
    currency: store.profile?.currency ?? 'CNY',
    taskType: goalForm.taskType,
    targetAmount,
    targetHorizonMonths: horizonNum,
    cashReserveFloor: reserveFloor,
    timingFlexibility: goalForm.timingFlexibility,
    version: nextVersion,
    ...(competingCents > 0
      ? {
          competingGoals: [
            {
              reservedAmount: competingCents,
              horizonMonths: horizonNum,
            },
          ],
        }
      : {}),
  };
}

function hasGoalFormChanged(): boolean {
  try {
    const candidate = buildGoalObject(false);
    const saved = store.goal;
    return (
      candidate.name !== saved.name ||
      candidate.taskType !== (saved.taskType ?? 'large_purchase') ||
      candidate.targetAmount !== saved.targetAmount ||
      candidate.targetHorizonMonths !== saved.targetHorizonMonths ||
      candidate.cashReserveFloor !== saved.cashReserveFloor ||
      candidate.timingFlexibility !== saved.timingFlexibility ||
      (candidate.competingGoals?.[0]?.reservedAmount ?? 0) !==
        (saved.competingGoals?.[0]?.reservedAmount ?? 0)
    );
  } catch {
    return true;
  }
}

const taskTypeLabel = computed(() => {
  if (goalForm.taskType === 'income_reduction') return '收入下降情景';
  if (goalForm.taskType === 'savings_goal') return '目标储蓄';
  return '大额支出评估';
});

const checkpointStatusLabel = computed(() => {
  const status = store.activeCheckpoint?.status;
  if (status === 'waiting_for_browser_tool') return '等待本地确认';
  if (status === 'running') return '上次中断前运行中';
  if (status === 'interrupted') return '连接曾中断';
  if (status === 'completed') return '分析已完成，本地报告待恢复';
  return status ?? '';
});

const localBaseline = computed(() => {
  if (!store.profile || store.profileValidation?.completeness !== 'task_ready') return null;
  try {
    const g = buildGoalObject(false);
    const sc = generateCandidateScenarios(g)[0];
    return evaluateScenarioLocal(store.profile, g, sc);
  } catch {
    return null;
  }
});

// ─── Agent Run State ──────────────────────────────────────────────────────────

const isRunning = ref(false);
const showAuthModal = ref(false);
const includeFamilyScope = ref(false);
const outboundPreviewText = ref('');
const eventLog = ref<Array<{ runId: string; seq: number; title: string; detail: string }>>([]);
const devTraceOpen = ref<string[]>([]);
const activeReport = ref<LocalFinalReport | null>(null);
const activeCoordinator = ref<ClientAgentCoordinator | null>(null);
const activeTransport = ref<HttpClientTransport | null>(null);
const activeRunId = ref<string | null>(null);
let activeRunController: AbortController | null = null;
onBeforeUnmount(() => activeRunController?.abort(new Error('planning_view_closed')));

const FOLLOW_UP_INTENT_OPTIONS: Array<{ value: FollowUpIntent; label: string }> = [
  { value: 'explain_verdict_and_risk', label: '解释当前可行性结论与主要风险' },
  { value: 'compare_candidate_scenarios', label: '对比其他备选方案差异' },
  { value: 'explain_cash_buffer_impact', label: '分析现金缓冲底线受影响程度' },
  { value: 'how_to_improve_feasibility', label: '了解下一步可安全提升可行性的方向' },
];

const selectedFollowUpIntent = ref<FollowUpIntent>('explain_verdict_and_risk');
const selectedFollowUpScenarioId = ref('');
const isFollowUpLoading = ref(false);
const followUpLog = ref<Array<{ intentLabel: string } & FollowUpResponse>>([]);

function isScenarioEvaluated(sid: string): boolean {
  if (activeCoordinator.value?.hasEvaluatedScenario(sid)) return true;
  if (store.activeCheckpoint?.localEvaluations && store.activeCheckpoint.localEvaluations[sid]) return true;
  return sid === displayedReport.value?.selectedScenarioId;
}

function toUserFriendlyErrorMessage(err: unknown): string {
  const msg = (err as Error)?.message || String(err);
  if (msg.includes('TIMEOUT_EXCEEDED') || msg.includes('timed out') || msg.includes('Timeout')) {
    return '规划执行超时（已超过最大执行时间限制）。建议检查网络连接后重试。';
  }
  if (msg.includes('MODEL_BUDGET_EXHAUSTED') || msg.includes('MAX_STEPS_EXCEEDED')) {
    return '已达到单次规划的最大思考步数或模型请求上限。建议细化目标参数后重新发起。';
  }
  if (msg.includes('RATE_LIMIT_EXCEEDED') || msg.includes('429')) {
    return '请求过于频繁，请稍候再试。';
  }
  if (msg.includes('MODEL_NETWORK_OR_TIMEOUT') || msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED')) {
    return '网络连接异常或无法连接模型服务，请检查网络设置或代理后重试。';
  }
  if (msg.includes('INVALID_ANALYSIS_SCHEMA') || msg.includes('INVALID_TOOL_ARGS') || msg.includes('INVALID_FOLLOWUP_ARGS')) {
    return '模型返回的数据结构不符合规范，系统已自动拦截。建议调整目标设定后重试。';
  }
  if (msg.includes('UNVERIFIED_EVIDENCE_REFERENCE') || msg.includes('UNRELIABLE_OR_VIOLATED_VIABLE_CLAIM')) {
    return '模型给出的结论未通过本地财务沙箱核验，已被安全机制拦截以保障财务准确性。';
  }
  if (msg.includes('AUTH_SCOPE_DISALLOWED') || msg.includes('Unauthorized: Missing required scope')) {
    return '出站数据超出授权范围，已安全阻断。请在隐私设置中核对授权范围。';
  }
  if (msg.includes('INPUT_MUTATED_CONCURRENTLY') || msg.includes('Live snapshot changed')) {
    return '规划执行期间财务档案或目标发生变动，已自动中止以防脏数据。请刷新后重新评估。';
  }
  if (msg.includes('client_aborted_or_locked')) {
    return '规划已被手动取消或金库已锁定。';
  }
  if (msg.includes('SERVER_SESSION_LOST')) {
    return '服务端规划会话已失效，建议发起新规划。';
  }
  return msg;
}

const showClarifyModal = ref(false);
const clarifyExpenseYuan = ref('');
const clarifyIncludesDebt = ref(false);
const isSavingClarification = ref(false);
const pendingClarifyCategory = ref('timing_flexibility_confirmation');
const selectedClarifyChoice = ref<ClarificationChoice>('timing_flexible');
const selectedDeclineCategory = ref<RejectionCategory>('user_declined_clarification');
let clarifyResolver: ((res: StructuredClarificationDecision) => void) | null = null;

const clarifyCategoryLabel = computed(() => {
  const cat = pendingClarifyCategory.value;
  if (cat === 'timing_flexibility_confirmation') return '目标时间调整弹性';
  if (cat === 'family_burden_confirmation') return '家庭责任与额外开支确认';
  if (cat === 'expense_refinement') return '必要生活支出核对';
  if (cat === 'income_variability_detail') return '收入波动稳定性';
  return '补充规划偏好';
});

const clarifyChoiceOptions = computed<Array<{ value: ClarificationChoice; label: string }>>(() => {
  const cat = pendingClarifyCategory.value;
  if (cat === 'family_burden_confirmation') {
    return [
      { value: 'family_none', label: '无额外家庭抚养开支' },
      { value: 'family_shared_household', label: '共同分担家庭生活开销' },
      { value: 'family_childcare_support', label: '存在育儿/教育刚性支出' },
      { value: 'family_elderly_support', label: '存在赡养老人支出' },
    ];
  }
  if (cat === 'expense_refinement') {
    return [
      { value: 'expense_confirmed_accurate', label: '月度必要生活开支已准确核实' },
      { value: 'expense_includes_debt_adjusted', label: '确认已核对开销与还款包含关系' },
      { value: 'user_confirmed', label: '保持当前本地账本设置不变' },
    ];
  }
  if (cat === 'income_variability_detail') {
    return [
      { value: 'income_moderately_variable', label: '收入存在适度浮动' },
      { value: 'income_highly_variable', label: '收入波动较大，按保守标准测算' },
      { value: 'user_confirmed', label: '按当前已填收入状态测算' },
    ];
  }
  return [
    { value: 'timing_flexible', label: '时间上可接受延后或分期缓冲' },
    { value: 'timing_fixed', label: '目标时间刚性固定，不可推迟' },
    { value: 'user_confirmed', label: '保持当前设置并继续测算' },
  ];
});

const displayedReport = computed<SavedLocalReport | LocalFinalReport | null>(
  () => activeReport.value ?? store.latestReport
);

const verdictLabel = computed(() => {
  const v = displayedReport.value?.verdict;
  if (v === 'viable') return '可行';
  if (v === 'caution') return '需调整/谨慎';
  return '不可行';
});

const verdictTagType = computed<'success' | 'warning' | 'danger'>(() => {
  const v = displayedReport.value?.verdict;
  if (v === 'viable') return 'success';
  if (v === 'caution') return 'warning';
  return 'danger';
});

function fmtMoney(cents: number): string {
  const sym = store.profile?.currency?.toUpperCase() === 'USD' ? '$' : '¥';
  return `${sym}${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function refreshOutboundPreview() {
  if (!store.profile) return;
  try {
    const g = buildGoalObject(hasGoalFormChanged());
    const safeProfileSummary = deriveSafeProfileSummary(store.profile, {
      includeFamilyBurden: includeFamilyScope.value,
    });
    const safeGoalSummary = deriveSafeGoalSummary(store.profile, g);
    const candidateScenarios = generateCandidateScenarios(g);

    outboundPreviewText.value = JSON.stringify(
      {
        provider: store.activeProviderId,
        snapshotVersion: store.currentSnapshotVersion,
        goalVersion: g.version,
        authorizedScopes: [
          'profile_summary',
          'goal_summary',
          'scenarios',
          'clarification',
          'follow_up',
          ...(includeFamilyScope.value ? ['family_summary'] : []),
        ],
        safeProfileSummary,
        safeGoalSummary,
        candidateScenarios,
      },
      null,
      2
    );
  } catch (err) {
    outboundPreviewText.value = (err as Error).message;
  }
}

watch(includeFamilyScope, () => {
  if (showAuthModal.value) refreshOutboundPreview();
});

async function handleSaveGoal() {
  try {
    const next = buildGoalObject(true);
    await store.saveGoal(next);
    activeReport.value = null;
    activeCoordinator.value = null;
    followUpLog.value = [];
    showToast(`已保存目标 ${next.version}（旧报告已失效）`);
  } catch (err) {
    showToast((err as Error).message);
  }
}

async function openOutboundPreview() {
  if (!store.profile) return;
  try {
    // Validate input cleanly WITHOUT saving or overwriting saved store.goal on preview/cancel.
    buildGoalObject(false);
    await store.refreshHealth();
    refreshOutboundPreview();
    showAuthModal.value = true;
  } catch (err) {
    showToast((err as Error).message);
  }
}

function recordEvent(evt: AgentEvent) {
  if (evt.type === 'tool_requested') {
    const tr = evt.payload.toolRequest as BrowserToolRequest;
    activeRunId.value = evt.runId;
    eventLog.value.push({
      runId: evt.runId,
      seq: evt.sequenceNumber,
      title: `工具请求: ${tr.toolName}`,
      detail: `${JSON.stringify(tr.params)} · ${(evt.payload.reasoning as string) || ''}`,
    });
  } else if (evt.type === 'completed') {
    eventLog.value.push({
      runId: evt.runId,
      seq: evt.sequenceNumber,
      title: '服务端分析完成',
      detail: '浏览器已接收结构化分析并完成本地凭证与金额插值核验',
    });
  } else if (evt.type === 'failed' || evt.type === 'cancelled' || evt.type === 'interrupted') {
    eventLog.value.push({
      runId: evt.runId,
      seq: evt.sequenceNumber,
      title: `状态终止: ${evt.type}`,
      detail: JSON.stringify(evt.payload),
    });
  }
}

async function executeAgentLoop(resumeFromCp = false, confirmRestartOnLostServerState = false) {
  if (!store.profile) return;
  let g: LargePurchaseGoal;
  try {
    g = { ...store.goal };
  } catch (err) {
    showToast((err as Error).message);
    return;
  }

  isRunning.value = true;
  eventLog.value = [];
  followUpLog.value = [];
  activeReport.value = null;
  activeRunId.value = null;

  const abortController = new AbortController();
  activeRunController = abortController;
  const transport = createBrowserAgentTransport();
  const coordinator = new ClientAgentCoordinator(
    store.getGateway(),
    transport,
    store.activeProviderId
  );
  activeTransport.value = transport;
  activeCoordinator.value = coordinator;
  store.registerRunLifecycle(abortController, () => {
    coordinator.clearSensitiveState();
    showClarifyModal.value = false;
    clarifyResolver?.({ action: 'decline', rejectionCategory: 'user_declined_clarification' });
    clarifyResolver = null;
    activeCoordinator.value = null;
    activeReport.value = null;
    followUpLog.value = [];
  });

  try {
    const options = {
      checkpointStore: store.checkpointStore,
      signal: abortController.signal,
      includeFamilySummary: includeFamilyScope.value,
      confirmRestartOnLostServerState,
      onRunCreated: (id: string) => {
        activeRunId.value = id;
      },
      getCurrentVersions: () => ({
        snapshotVersion: store.currentSnapshotVersion,
        goalVersion: store.goal.version,
      }),
      onEvent: recordEvent,
      clarificationHandler: (req: BrowserToolRequest) => {
        pendingClarifyCategory.value = req.params.fieldCategory ?? 'timing_flexibility_confirmation';
        selectedClarifyChoice.value = clarifyChoiceOptions.value[0].value;
        clarifyExpenseYuan.value = store.profile?.essentialExpenses?.amount === undefined ? '' : formatCentsExact(store.profile.essentialExpenses.amount);
        clarifyIncludesDebt.value = store.profile?.essentialExpenses?.includesDebt ?? false;
        showClarifyModal.value = true;
        return new Promise<StructuredClarificationDecision>((resolve) => {
          clarifyResolver = resolve;
        });
      },
    };

    const report =
      resumeFromCp && store.activeCheckpoint
        ? await coordinator.resumeFromCheckpoint(
            store.profile,
            g,
            store.activeCheckpoint,
            options
          )
        : await coordinator.runPlanningLoop(store.profile, g, options);

    activeReport.value = report;
    selectedFollowUpScenarioId.value = '';
    await store.saveReport(report);
    await store.refreshCheckpoint();
    showToast('规划完成并已本地核验');
  } catch (err) {
    const errObj = err as Error & { code?: string };
    if (store.isUnlocked) await store.refreshCheckpoint();
    if (
      resumeFromCp &&
      !confirmRestartOnLostServerState &&
      (errObj.code === 'SERVER_SESSION_LOST' || errObj.message.startsWith('SERVER_SESSION_LOST:'))
    ) {
      try {
        await showConfirmDialog({
          title: '服务端原运行会话已失效',
          message:
            '服务端未保留上次检查点对应的运行状态（可能因服务重启）。若继续重启新规划，此前是否产生过额外模型费用无法确认。是否确认重启？',
          confirmButtonText: '确认重新启动',
          cancelButtonText: '暂不启动',
        });
        isRunning.value = false;
        await executeAgentLoop(true, true);
        return;
      } catch {
        showToast('已取消从失效检查点重启');
      }
    } else {
      showToast(toUserFriendlyErrorMessage(errObj));
    }
  } finally {
    if (activeRunController === abortController) {
      activeRunController = null;
      store.registerRunLifecycle(null, null);
    }
    isRunning.value = false;
  }
}

async function confirmAndRunAgent() {
  showAuthModal.value = false;
  try {
    if (hasGoalFormChanged()) {
      const nextGoal = buildGoalObject(true);
      await store.saveGoal(nextGoal);
    }
    store.grantAuthorization([
      'profile_summary',
      'goal_summary',
      'scenarios',
      'clarification',
      'follow_up',
      ...(includeFamilyScope.value ? (['family_summary'] as const) : []),
    ]);
    await executeAgentLoop(false, false);
  } catch (err) {
    showToast((err as Error).message);
  }
}

async function handleResumeCheckpoint(confirmRestart = false) {
  if (!store.activeCheckpoint) return;
  if (hasGoalFormChanged()) { showToast('目标有未保存修改，请保存后开始新的分析'); return; }
  store.grantAuthorization([
    'profile_summary',
    'goal_summary',
    'scenarios',
    'clarification',
    'follow_up',
    ...(includeFamilyScope.value ? (['family_summary'] as const) : []),
  ]);
  await executeAgentLoop(true, confirmRestart);
}

async function clearCheckpoint() {
  await store.checkpointStore.clear(store.goal.id);
  await store.refreshCheckpoint();
  showToast('已清除本地检查点');
}

async function resolveClarify(action: 'answer' | 'modify_input' | 'decline') {
  if (!clarifyResolver || isSavingClarification.value) return;
  const resolve = clarifyResolver;
  isSavingClarification.value = true;
  try {
    let decision: StructuredClarificationDecision;
    if (action === 'decline') {
      decision = { action: 'decline', rejectionCategory: selectedDeclineCategory.value };
    } else if (pendingClarifyCategory.value === 'expense_refinement') {
      if (!store.profile) throw new Error('画像已锁定');
      const amount = parseStrictCents(clarifyExpenseYuan.value, '实际月开销', 0);
      const current = store.profile.essentialExpenses;
      if (amount !== current?.amount || clarifyIncludesDebt.value !== Boolean(current?.includesDebt)) {
        const saved = await store.saveProfile({ ...store.profile, essentialExpenses: {
          ...current, scope: current?.scope ?? 'individual', amount, includesDebt: clarifyIncludesDebt.value,
        } });
        decision = { action: 'modify_input', updatedProfile: saved };
      } else {
        decision = { action: 'answer', clarificationChoice: 'expense_confirmed_accurate' };
      }
    } else if (pendingClarifyCategory.value === 'timing_flexibility_confirmation' &&
      (action === 'modify_input' || selectedClarifyChoice.value === 'timing_fixed' || selectedClarifyChoice.value === 'timing_flexible')) {
      const next = { ...store.goal };
      if (action === 'modify_input') {
        if (next.timingFlexibility === 'fixed') throw new Error('当前目标不可延期');
        next.targetHorizonMonths = Math.min(120, next.targetHorizonMonths + 3);
      } else {
        next.timingFlexibility = selectedClarifyChoice.value === 'timing_fixed' ? 'fixed' : 'flexible';
      }
      const oldVersion = store.goal.version;
      const saved = await store.saveGoal(next);
      decision = saved.version === oldVersion
        ? { action: 'answer', clarificationChoice: selectedClarifyChoice.value }
        : { action: 'modify_input', updatedGoal: saved };
    } else {
      decision = { action: 'answer', clarificationChoice: selectedClarifyChoice.value };
    }
    // Storage failures leave the dialog open; no cloud reply or version migration is sent.
    if (!store.isUnlocked || resolve !== clarifyResolver) return;
    clarifyResolver = null;
    showClarifyModal.value = false;
    resolve(decision);
  } catch (err) {
    showToast(toUserFriendlyErrorMessage(err));
  } finally {
    isSavingClarification.value = false;
  }
}

async function handleCancelRun() {
  activeRunController?.abort(new Error('user_cancelled_h5'));
  if (!activeRunId.value || !activeTransport.value) return;
  try {
    await activeTransport.value.cancelRun(activeRunId.value, 'user_cancelled_h5');
    showToast('已发送取消请求');
  } catch (err) {
    showToast((err as Error).message);
  }
}

async function handleSendFollowUp() {
  if (!store.profile || !displayedReport.value || !activeCoordinator.value) return;
  if (store.isLatestReportStale) {
    showToast('报告已因快照或目标变更而失效，请重新运行规划');
    return;
  }

  isFollowUpLoading.value = true;
  try {
    const intentOption = FOLLOW_UP_INTENT_OPTIONS.find(
      (opt) => opt.value === selectedFollowUpIntent.value
    );
    const res = await activeCoordinator.value.askFollowUp(
      store.profile,
      displayedReport.value,
      {
        intent: selectedFollowUpIntent.value,
        ...(selectedFollowUpScenarioId.value
          ? { focusScenarioId: selectedFollowUpScenarioId.value }
          : {}),
      },
      store.goal.version
    );
    followUpLog.value.push({
      intentLabel: intentOption?.label ?? selectedFollowUpIntent.value,
      ...res,
    });
  } catch (err) {
    showToast(toUserFriendlyErrorMessage(err));
  } finally {
    isFollowUpLoading.value = false;
  }
}
</script>
