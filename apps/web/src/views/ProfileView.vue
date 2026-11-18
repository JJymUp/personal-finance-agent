<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { useFinanceStore } from '../stores/finance';
import type { DebtItem } from '../features/profile/types';
const store=useFinanceStore(); const router=useRouter();
const saving=ref(false);const passphrase=ref('');
const form=reactive({nickname:'',deposit:'',income:'',expenses:'',debtStatus:null as 'none'|'has_debt'|null,
  debts:[] as Array<{original?:DebtItem;id:string;balance:string;payment:string}>});
const unit=computed(()=>store.profile?.currency==='USD'?'美元':'元');
const money=(cents?:number)=>cents===undefined?'':(cents/100).toFixed(2).replace(/\.00$/,'');
watch(()=>store.profile,p=>{
  form.nickname=p?.nickname??'';form.deposit=money(p?.availableDeposit);form.income=money(p?.monthlyIncome?.amount);
  form.expenses=p?.essentialExpenses?.scope==='household'?'':money(p?.essentialExpenses?.amount);
  form.debtStatus=p?.debtStatus==='none'?'none':p?.debtStatus==='has_debt'?'has_debt':null;
  form.debts=(p?.debts??[]).map(d=>({original:{...d},id:d.id,balance:money(d.balance),payment:money(d.repaymentAmount)}));
},{immediate:true});
watch(()=>form.debtStatus,value=>{if(value==='has_debt' && form.debts.length===0)addDebt();});
function addDebt(){form.debts.push({id:`debt_${crypto.randomUUID()}`,balance:'',payment:''});}
function cents(value:string,label:string,optional=false){
 const text=value.trim();if(!text&&optional)return undefined;
 if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw new Error(`请填写${label}，最多保留两位小数`);
 const n=Math.round(Number(text)*100);if(!Number.isSafeInteger(n)||n>10_000_000_000)throw new Error(`${label}超出支持范围`);return n;
}
async function save(){
 if(saving.value)return;saving.value=true;
 try{
  const deposit=cents(form.deposit,'可用存款');const income=cents(form.income,'月收入');const expenses=cents(form.expenses,'月开销',true);
  if(!form.debtStatus)throw new Error('请选择有贷款或无贷款');
  const nickname=form.nickname.trim();const debtStatus=form.debtStatus;
  if(form.debtStatus==='has_debt'&&form.debts.length===0)throw new Error('请填写贷款信息');
  const debts=form.debtStatus==='has_debt'?form.debts.map(row=>({...row.original,id:row.id,
    balance:cents(row.balance,'剩余贷款')!,repaymentAmount:cents(row.payment,'每期还款'),
    frequency:row.original?.frequency==='weekly'?'weekly' as const:'monthly' as const})):[];
  if(!store.isUnlocked){
    if(passphrase.value.length<6)throw new Error('请设置至少6位本地口令');
    if(!await store.unlockVault(passphrase.value))throw new Error('本地口令不正确');
    passphrase.value='';
  }
  const previous=store.profile;const now=new Date().toISOString();
  await store.saveProfile({...previous,currency:previous?.currency??'CNY',nickname,availableDeposit:deposit,
    monthlyIncome:{...previous?.monthlyIncome,status:previous?.monthlyIncome?.status==='variable'?'variable':'fixed',amount:income},
    debtStatus,debts,essentialExpenses:{...previous?.essentialExpenses,amount:expenses,scope:'individual',includesDebt:previous?.essentialExpenses?.scope==='household'?false:previous?.essentialExpenses?.includesDebt??false},
    metadata:{version:previous?.metadata.version??0,dataDate:now.slice(0,10),updatedAt:now,completeness:'initialized'}});
  await router.replace('/chat');
 }catch(error){showToast((error as Error).message);}finally{saving.value=false;}
}
</script>

<template>
 <main class="onboarding h5-page" data-testid="profile-page">
  <div class="onboarding-heading">
   <span class="eyebrow">{{ store.profileInitialized ? '你的基础资料' : '开始之前，先认识一下你' }}</span>
   <h1>{{ store.profileInitialized ? '更新资料' : '简单填几项，之后直接聊' }}</h1>
   <p>资料保存在这台设备上，用来让建议更贴近你的实际情况。</p>
  </div>
  <van-cell-group inset class="simple-profile-fields">
   <van-field v-model="form.nickname" label="怎么称呼你" placeholder="选填" maxlength="30" data-testid="input-nickname" />
   <van-field v-model="form.deposit" :label="`可用存款(${unit})`" inputmode="decimal" placeholder="例如 50000，没有则填 0" data-testid="input-deposit" />
   <van-field v-model="form.income" :label="`到手月收入(${unit})`" inputmode="decimal" placeholder="填写每月大致收入" data-testid="input-income" />
   <van-field v-model="form.expenses" :label="`每月开销(${unit})`" inputmode="decimal" placeholder="选填，你自己承担的生活开销" data-testid="input-expenses" />
   <van-cell title="贷款情况">
    <template #value><van-radio-group v-model="form.debtStatus" direction="horizontal">
      <van-radio name="none">无贷款</van-radio><van-radio name="has_debt">有贷款</van-radio>
    </van-radio-group></template>
   </van-cell>
  </van-cell-group>
  <p class="form-hint">生活开销{{ store.profile?.essentialExpenses?.includesDebt ? '沿用原资料的含还款口径' : '不含下面单独填写的还款' }}。不清楚开销也可以先跳过，聊天时再补充。</p>
  <section v-if="form.debtStatus==='has_debt'" class="simple-debts">
   <van-cell-group v-for="(debt,index) in form.debts" :key="debt.id" inset>
    <van-field v-model="debt.balance" :label="`剩余贷款(${unit})`" inputmode="decimal" placeholder="还需要还多少" />
    <van-field v-model="debt.payment" :label="`${debt.original?.frequency==='weekly'?'每周':'每月'}还款(${unit})`" inputmode="decimal" placeholder="每期实际偿还金额" />
    <van-cell v-if="form.debts.length>1" :title="`移除第 ${index+1} 笔贷款`" @click="form.debts.splice(index,1)" />
   </van-cell-group>
   <button class="text-button" type="button" @click="addDebt">＋ 还有其他贷款</button>
  </section>
  <van-cell-group v-if="!store.isUnlocked" inset>
   <van-field v-model="passphrase" type="password" label="本地口令" placeholder="至少6位，用于加密资料" autocomplete="new-password" data-testid="setup-passphrase" />
  </van-cell-group>
  <p v-if="!store.isUnlocked" class="form-hint">口令只用于本地解锁，请妥善记住。</p>
  <van-button block type="primary" round :loading="saving" @click="save" data-testid="save-profile-btn">保存，开始聊天</van-button>
  <p class="onboarding-footnote">你可以随时在右上角修改这些资料。</p>
 </main>
</template>
