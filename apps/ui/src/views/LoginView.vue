<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">OpenBridge</h1>
      <p class="login-subtitle">Sign in via Nubisco Platform to manage this OpenBridge instance.</p>

      <NbMessage v-if="error" variant="error" class="login-error">
        {{ error }}
      </NbMessage>
      <NbMessage v-else-if="loggedOut" variant="success" class="login-error">You have been signed out.</NbMessage>

      <NbButton variant="primary" size="lg" :disabled="loading" class="login-btn" @click="signIn">
        <span v-if="loading">Redirecting…</span>
        <span v-else>Sign in via Nubisco Platform</span>
      </NbButton>
      <button class="login-alt" :disabled="loading" @click="pickAccount">Use a different account</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const AUTO_RESUME_KEY = 'openbridge_auto_resume_attempted'

const route = useRoute()
const router = useRouter()
const { user, loadConfig, checkAuth, startPlatformLogin, resumeLastAccount, chooseAccount } = useAuth()

const loading = ref(false)
const error = ref<string | null>(null)
const loggedOut = computed(() => route.query.logged_out === '1')

async function signIn() {
  loading.value = true
  error.value = null
  try {
    const hint = typeof route.query.login_hint === 'string' ? route.query.login_hint : undefined
    await startPlatformLogin(hint ? { loginHint: hint } : {})
  } catch (e) {
    loading.value = false
    error.value = e instanceof Error ? e.message : 'Unable to start sign-in.'
  }
}

async function pickAccount() {
  loading.value = true
  error.value = null
  try {
    await chooseAccount()
  } catch (e) {
    loading.value = false
    error.value = e instanceof Error ? e.message : 'Unable to start sign-in.'
  }
}

onMounted(async () => {
  const cfg = await loadConfig()

  // Auth disabled — nobody should be on /login, send them home.
  if (!cfg.enabled) {
    router.replace('/')
    return
  }

  if (route.query.error === 'account_changed') {
    error.value = 'Your platform account changed. Please sign in again.'
    return
  }

  const loginHint = typeof route.query.login_hint === 'string' ? route.query.login_hint : ''
  const signedIn = await checkAuth()

  if (signedIn) {
    // Launchpad handed us a hint for a DIFFERENT account: honor it by
    // switching through the redirect flow instead of keeping the old user.
    if (loginHint && user.value && user.value.email.toLowerCase() !== loginHint.toLowerCase()) {
      loading.value = true
      await startPlatformLogin({ loginHint })
      return
    }
    router.replace('/')
    return
  }

  // Launchpad launch: land already signed in as the account that was clicked.
  if (loginHint) {
    loading.value = true
    await startPlatformLogin({ loginHint })
    return
  }

  // Session expired: silently resume the account this app was using
  // (login_hint + expected_sub guarantee the same subject comes back).
  // Attempted at most once per tab so a failed resume can't loop.
  if (!loggedOut.value && !sessionStorage.getItem(AUTO_RESUME_KEY)) {
    sessionStorage.setItem(AUTO_RESUME_KEY, '1')
    loading.value = true
    const resumed = await resumeLastAccount()
    if (resumed) return
    loading.value = false
  }
})
</script>

<style scoped lang="scss">
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.login-card {
  width: 100%;
  max-width: 420px;
  padding: 2.5rem 2rem;
  border: 1px solid var(--nb-c-component-plain-border, var(--nb-c-border));
  border-radius: 12px;
  background: var(--nb-c-surface, #fff);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.login-title {
  margin: 0;
  font-size: var(--nb-font-size-24, 24px);
  font-weight: var(--nb-font-weight-bold, 700);
  letter-spacing: -0.4px;
}

.login-subtitle {
  margin: 0;
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-font-size-14);
  line-height: 1.5;
}

.login-error {
  margin: 0;
}

.login-btn {
  margin-top: 0.5rem;
}

.login-alt {
  align-self: center;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-font-size-13, 13px);
  text-decoration: underline;

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}
</style>
