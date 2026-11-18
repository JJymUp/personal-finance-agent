<script setup lang="ts">
import { ref } from 'vue';
import { showToast } from 'vant';
import { useFinanceStore } from '../stores/finance';
const store=useFinanceStore();const showImport=ref(false);const input=ref('');const passphrase=ref('');const exported=ref('');
async function exportData(){try{exported.value=await store.exportBackup();showToast('已生成加密备份，请妥善保存');}catch(e){showToast((e as Error).message);}}
async function restore(){try{await store.importBackup(input.value,passphrase.value);showImport.value=false;input.value='';passphrase.value='';showToast('资料已恢复');}catch(e){showToast((e as Error).message);}}
</script>
<template><section class="h5-card"><div class="h5-card-title">加密备份与恢复</div><p class="h5-muted">清理浏览器数据可能丢失资料。备份包含画像与聊天记录，恢复会替换当前本地资料。</p>
<div class="h5-btn-row"><van-button size="small" @click="exportData">导出备份</van-button><van-button size="small" @click="showImport=true">恢复备份</van-button></div>
<van-field v-if="exported" v-model="exported" readonly type="textarea" rows="4" label="加密备份" />
<van-popup v-model:show="showImport" position="bottom" round style="padding:20px"><van-field v-model="input" type="textarea" rows="4" label="备份内容" /><van-field v-model="passphrase" type="password" label="备份口令" /><van-button block type="primary" @click="restore">恢复资料</van-button></van-popup>
</section></template>
