import { createRouter, createWebHashHistory } from 'vue-router';
import ProfileView from '../views/ProfileView.vue';
import TransactionsView from '../views/TransactionsView.vue';
import PlanningView from '../views/PlanningView.vue';
import PrivacyView from '../views/PrivacyView.vue';

export const router = createRouter({
  // Hash history avoids server-side routing edge cases on static fallback
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/profile' },
    { path: '/profile', name: 'profile', component: ProfileView },
    { path: '/transactions', name: 'transactions', component: TransactionsView },
    { path: '/planning', name: 'planning', component: PlanningView },
    { path: '/privacy', name: 'privacy', component: PrivacyView },
  ],
});
