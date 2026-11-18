<template>
  <div class="h5-page" data-testid="privacy-page">
    <!-- Provider & Mode Disclosure -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>模型与服务状态</span>
        <van-tag
          :type="store.serverHealth?.providerMode === 'openai' ? 'primary' : 'warning'"
          data-testid="provider-mode-tag"
        >
          {{
            store.serverHealth?.providerMode === 'openai'
              ? `云端模型: ${store.serverHealth.provider}`
              : '模拟模式 (Mock Provider)'
          }}
        </van-tag>
      </div>
      <p class="h5-muted" style="margin: 0 0 8px">
        推荐说明：“资产数据本地保存，通过经授权的财务摘要提供 AI 规划分析。”
        <br />
        API 密钥仅保存在 Node.js 服务端环境变量，浏览器构建产物绝不包含模型密钥。
      </p>
      <van-button size="small" plain @click="store.refreshHealth">刷新服务状态</van-button>
    </div>

    <!-- Authorization Control -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>出站授权控制</span>
        <van-tag :type="store.isAuthorized ? 'success' : 'default'" data-testid="auth-status-tag">
          {{ store.isAuthorized ? '当前已授权' : '未授权 / 已撤销' }}
        </van-tag>
      </div>
      <p class="h5-muted" style="margin: 0 0 10px">
        撤销授权会立即阻止浏览器端发送任何新的规划请求或追问。已发送到第三方云端模型服务的历史摘要受供应商服务条款约束，无法从历史记录中自动抹除。
      </p>
      <div class="h5-btn-row">
        <van-button
          size="small"
          type="danger"
          plain
          :disabled="!store.isAuthorized"
          data-testid="revoke-auth-btn"
          @click="handleRevoke"
        >
          立即撤销出站授权
        </van-button>
      </div>
    </div>

    <!-- Local Storage & Recovery Boundaries -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>本地存储与加密边界</span>
      </div>
      <ul class="h5-muted" style="margin: 0; padding-left: 18px">
        <li>IndexedDB 仅存储 AES-GCM 密文与不透明索引键，不存储称呼或金额明文索引。</li>
        <li>解锁口令仅在内存推导密钥，不落盘且无开发者找回后门。</li>
        <li>Pinia 状态仅存于运行期内存，“锁定金库”即清空内存中敏感明文。</li>
        <li>更换设备、清除站点数据或使用隐私模式可能导致本地数据丢失，请定期导出备份。</li>
      </ul>
      <div class="h5-btn-row" style="margin-top: 10px">
        <van-button size="small" plain @click="store.lockVault()">锁定金库</van-button>
        <van-button size="small" type="danger" plain @click="handleWipe">
          清空全部本地数据
        </van-button>
      </div>
    </div>

    <section class="h5-card"><div class="h5-card-title">聊天文字的处理方式</div><p class="h5-muted">画像原始金额仍留在浏览器。聊天文字会先在本地识别并替换金额、账号等信息，再发给 AI；自动识别不能保证覆盖所有敏感表达，请勿粘贴密码或完整账户资料。</p></section>
    <VaultBackup />
    <!-- Outbound Audit Log -->
    <div class="h5-card">
      <div class="h5-card-title">
        <span>本地出站审计日志 ({{ auditLogs.length }})</span>
      </div>
      <div v-if="auditLogs.length === 0" class="h5-muted">暂无出站记录。</div>
      <van-cell-group v-else inset>
        <van-cell
          v-for="(item, idx) in auditLogs"
          :key="idx"
          :title="item.action"
          :label="`${item.payloadType} · ${item.details}`"
          :value="item.timestamp.slice(11, 19)"
        />
      </van-cell-group>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import VaultBackup from '../components/VaultBackup.vue';
import { useFinanceStore } from '../stores/finance';

const store = useFinanceStore();

const auditLogs = computed(() => {
  void store.authorizationVersion;
  return store.getGateway().getAuditLog().slice().reverse();
});

function handleRevoke() {
  store.revokeAuthorization();
  showToast('已撤销当前会话出站授权');
}

async function handleWipe() {
  try {
    await showConfirmDialog({
      title: '确认清空全部本地数据？',
      message: '此操作会删除本机 IndexedDB 中的加密画像、交易、检查点与报告且不可恢复。',
    });
    await store.clearAllLocalData();
    showToast('已彻底清空本地数据');
  } catch {
    // cancelled
  }
}
</script>
