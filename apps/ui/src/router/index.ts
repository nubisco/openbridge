import { createRouter, createWebHistory } from 'vue-router'
import AppLayout from '@/views/AppLayout.vue'
import DashboardView from '@/views/DashboardView.vue'
import PluginsView from '@/views/PluginsView.vue'
import DevicesView from '@/views/DevicesView.vue'
import ConfigView from '@/views/ConfigView.vue'
import SettingsView from '@/views/SettingsView.vue'
import TerminalView from '@/views/TerminalView.vue'
import LoginView from '@/views/LoginView.vue'
import AuthCallbackView from '@/views/AuthCallbackView.vue'
import { useAuth } from '@/composables/useAuth'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/auth/callback', name: 'auth-callback', component: AuthCallbackView },
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

// When platform auth is enabled, gate the application routes. When disabled
// (default for OSS deployments without the platform integration), let
// everything through unchanged.
let authChecked = false

router.beforeEach(async (to) => {
  if (to.name === 'login' || to.name === 'auth-callback') return true

  const { config, user, loadConfig, checkAuth } = useAuth()
  if (!config.value) await loadConfig()
  if (!config.value?.enabled) return true

  if (!authChecked) {
    const ok = await checkAuth()
    authChecked = true
    if (!ok) return '/login'
  } else if (!user.value) {
    return '/login'
  }
  return true
})
