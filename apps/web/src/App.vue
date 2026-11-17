<template>
  <div class="h5-shell">
    <van-nav-bar
      title="Maggot 财务规划"
      fixed
      placeholder
      :right-text="store.isUnlocked ? '锁定' : ''"
      @click-right="handleQuickLock"
    />

    <!-- Capability Failure Gate (H-02: No plaintext fallback) -->
    <div v-if="!store.capabilities.isSupported" class="h5-page" data-testid="capability-error">
      <div class="h5-card">
        <div class="h5-card-title">
          <span>浏览器安全存储不可用</span>
          <van-tag type="danger">拒绝降级</van-tag>
        </div>
        <van-notice-bar
          v-for="(reason, idx) in store.capabilities.missingReasons"
          :key="idx"
          color="#ee0a24"
          background="#fff1f0"
          wrapable
          :scrollable="false"
          style="margin-bottom: 8px"
        >
          {{ reason }}
        </van-notice-bar>
        <p class="h5-muted" style="margin: 0">
          为防止您的财务隐私明文保存，本应用禁止在缺少 Web Crypto 或 IndexedDB 时降级为明文存储。请切换至受支持的现代浏览器或 HTTPS / localhost 安全上下文。
        </p>
      </div>
    </div>

    <!-- Local Encrypted Vault Gate (O-01 ~ O-03) -->
    <div v-else-if="!store.isUnlocked" class="h5-page" data-testid="vault-gate">
      <div class="h5-card">
        <div class="h5-card-title">
          <span>本地加密金库解锁</span>
          <van-tag type="primary">AES-GCM-256</van-tag>
        </div>
        <p class="h5-muted" style="margin: 0 0 12px">
          请输入本地加密口令（首次输入将自动初始化加密金库）。口令仅用于浏览器本地派生密钥，绝不上传服务端，亦无找回后门。
        </p>

        <van-cell-group inset>
          <van-field
            v-model="passphrase"
            type="password"
            label="本地口令"
            placeholder="请输入至少 4 位本地口令"
            data-testid="unlock-passphrase-input"
            @keyup.enter="handleUnlock"
          />
        </van-cell-group>

        <div style="margin-top: 12px">
          <van-button
            type="primary"
            block
            :loading="isUnlocking"
            data-testid="unlock-btn"
            @click="handleUnlock"
          >
            解锁 / 初始化本地金库
          </van-button>
        </div>

        <van-notice-bar
          v-if="unlockError"
          color="#ee0a24"
          background="#fff1f0"
          wrapable
          :scrollable="false"
          style="margin-top: 10px"
          data-testid="unlock-error"
        >
          {{ unlockError }}
        </van-notice-bar>
      </div>

      <div class="h5-card">
        <div class="h5-card-title"><span>浏览器数据边界说明（H-03）</span></div>
        <p class="h5-muted" style="margin: 0">
          精确财务记录仅存储在当前站点浏览器存储中，不会自动跨设备同步。清除站点数据、更换域名或退出隐私浏览可能清空数据，请在解锁后及时导出加密备份。
        </p>
      </div>
    </div>

    <!-- Main Unlocked H5 App -->
    <template v-else>
      <router-view />
      <van-tabbar route fixed safe-area-inset-bottom>
        <van-tabbar-item replace to="/profile" icon="user-o" data-testid="tab-profile">
          画像
        </van-tabbar-item>
        <van-tabbar-item replace to="/transactions" icon="orders-o" data-testid="tab-transactions">
          账单
        </van-tabbar-item>
        <van-tabbar-item replace to="/planning" icon="chart-trending-o" data-testid="tab-planning">
          规划
        </van-tabbar-item>
        <van-tabbar-item replace to="/privacy" icon="shield-o" data-testid="tab-privacy">
          隐私
        </van-tabbar-item>
      </van-tabbar>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { showToast } from 'vant';
import { useFinanceStore } from './stores/finance';

const store = useFinanceStore();
const passphrase = ref('');
const unlockError = ref('');
const isUnlocking = ref(false);

async function handleUnlock() {
  unlockError.value = '';
  if (!passphrase.value.trim()) {
    unlockError.value = '口令不能为空';
    return;
  }

  isUnlocking.value = true;
  try {
    const ok = await store.unlockVault(passphrase.value);
    if (!ok) {
      unlockError.value = '解锁失败：口令与本地验证记录不匹配';
      return;
    }
    passphrase.value = '';
    showToast('本地金库已解锁');
  } catch (err) {
    unlockError.value = (err as Error).message;
  } finally {
    isUnlocking.value = false;
  }
}

function handleQuickLock() {
  if (!store.isUnlocked) return;
  store.lockVault();
  showToast('已锁定并清空内存明文');
}
</script>
