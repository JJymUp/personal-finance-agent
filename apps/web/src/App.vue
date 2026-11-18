<script setup lang="ts">
import { onMounted,ref,computed } from 'vue';
import { useRouter,useRoute } from 'vue-router';
import { useFinanceStore } from './stores/finance';
const store=useFinanceStore();const router=useRouter();const route=useRoute();
const passphrase=ref('');const error=ref('');const busy=ref(false);const loading=ref(true);
const ready=computed(()=>store.isUnlocked && store.profileInitialized);
onMounted(async()=>{try{await store.checkStoredVault();}catch{error.value='无法访问本地存储，请检查浏览器设置。';}finally{loading.value=false;}});
async function unlock(){if(busy.value)return;busy.value=true;error.value='';try{
 if(!await store.unlockVault(passphrase.value))throw new Error('口令不正确，请再试一次');
 passphrase.value='';await router.replace(store.profileInitialized?'/chat':'/profile');
}catch(e){error.value=(e as Error).message;}finally{busy.value=false;}}
</script>
<template>
 <div class="h5-shell chat-first-shell">
  <van-nav-bar title="个人财务助手" :left-arrow="ready && route.path!=='/chat'" @click-left="router.push('/chat')">
   <template v-if="ready" #right><div class="header-actions"><button type="button" @click="router.push('/profile')">资料</button><button type="button" @click="router.push('/privacy')">隐私</button></div></template>
  </van-nav-bar>
  <div v-if="loading" class="app-loading">正在打开本地资料…</div>
  <div v-else-if="!store.capabilities.isSupported" class="h5-page"><p>当前浏览器不支持安全存储，请使用新版浏览器或 HTTPS 页面。</p></div>
  <div v-else-if="store.hasStoredVault===null && error" class="h5-page"><p role="alert">{{ error }}</p></div>
  <main v-else-if="store.hasStoredVault && !store.isUnlocked" class="unlock-page" data-testid="vault-gate">
   <span class="eyebrow">欢迎回来</span><h1>解锁后，继续聊</h1><p class="h5-muted">你的资料和对话仅加密保存在这台设备上。</p>
   <van-field v-model="passphrase" type="password" placeholder="输入本地口令" @keyup.enter="unlock" data-testid="unlock-passphrase-input" />
   <p v-if="error" class="error-text" data-testid="unlock-error">{{ error }}</p>
   <van-button block round type="primary" :loading="busy" @click="unlock" data-testid="unlock-btn">解锁</van-button>
  </main>
  <router-view v-else />
 </div>
</template>
