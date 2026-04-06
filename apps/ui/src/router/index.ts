import { createRouter, createWebHistory } from 'vue-router'
import AppLayout from '@/views/AppLayout.vue'
import DashboardView from '@/views/DashboardView.vue'
import PluginsView from '@/views/PluginsView.vue'
import DevicesView from '@/views/DevicesView.vue'
import ConfigView from '@/views/ConfigView.vue'
import SettingsView from '@/views/SettingsView.vue'
import TerminalView from '@/views/TerminalView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: AppLayout,
      redirect: '/dashboard',
      children: [
        { path: 'dashboard', name: 'dashboard', component: DashboardView },
        { path: 'plugins', name: 'plugins', component: PluginsView },
        { path: 'devices', name: 'devices', component: DevicesView },
        { path: 'config', name: 'config', component: ConfigView },
        { path: 'settings', name: 'settings', component: SettingsView },
        { path: 'terminal', name: 'terminal', component: TerminalView },
      ],
    },
  ],
})
