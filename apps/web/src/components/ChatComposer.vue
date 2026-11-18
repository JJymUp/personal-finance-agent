<script setup lang="ts">
const text=defineModel<string>({required:true});
defineProps<{busy:boolean;clarifying:boolean}>();
const emit=defineEmits<{send:[];stop:[]}>();
function keydown(event:KeyboardEvent){if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();emit('send');}}
</script>
<template><footer class="chat-composer">
 <div class="composer-box"><textarea v-model="text" :disabled="busy&&!clarifying" :placeholder="clarifying?'在这里补充，或输入「先跳过」':'聊聊你的预算、目标或困惑…'" rows="2" maxlength="1000" aria-label="聊天消息" data-testid="chat-input" @keydown="keydown" />
 <button v-if="busy&&!clarifying" type="button" class="send-button stop-button" aria-label="停止回复" @click="emit('stop')">■</button>
 <button v-else type="button" class="send-button" :disabled="!text.trim()" aria-label="发送消息" data-testid="chat-send" @click="emit('send')">↑</button></div>
 <p>仅发送处理后的文字与画像摘要 · 建议仅作参考</p>
</footer></template>
