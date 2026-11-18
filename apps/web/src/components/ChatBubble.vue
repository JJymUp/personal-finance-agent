<script setup lang="ts">
import type { ChatMessage } from '../features/chat/types';
defineProps<{message:ChatMessage}>();
</script>
<template><article class="chat-message" :class="[`chat-message--${message.role}`,`chat-message--${message.status}`]" :data-testid="message.role==='assistant'?'assistant-message':'user-message'">
 <span v-if="message.role==='assistant'" class="assistant-mark" aria-hidden="true">✦</span>
 <div class="chat-bubble"><p>{{ message.text }}</p><span v-if="message.status==='pending'" class="typing-dots" aria-label="正在处理">···</span></div>
</article></template>
