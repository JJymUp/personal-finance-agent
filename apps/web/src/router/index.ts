import { createRouter, createWebHashHistory } from 'vue-router';
import ProfileView from '../views/ProfileView.vue';
import ChatView from '../views/ChatView.vue';
import { useFinanceStore } from '../stores/finance';
import PrivacyView from '../views/PrivacyView.vue';

export const router = createRouter({
  // Hash history avoids server-side routing edge cases on static fallback
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/profile', name: 'profile', component: ProfileView },
    { path: '/transactions', redirect: '/chat' },
    { path: '/planning', redirect: '/chat' },
    { path: '/chat', name:'chat', component:ChatView },
    { path: '/privacy', name: 'privacy', component: PrivacyView },
  ],
});

router.beforeEach(to => { if(to.path==='/chat' && !useFinanceStore().profileInitialized) return '/profile'; });
