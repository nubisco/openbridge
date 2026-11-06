<template>
  <!-- A full-page task outside the shell: one heading, one primary. -->
  <div class="login">
    <NbPanel class="login__panel">
      <img class="login__mark" src="/logo.svg" alt="" width="44" height="44" />
      <h1 class="type-heading-03">OpenBridge</h1>
      <p class="login__note">Sign in via Nubisco Platform to manage this OpenBridge instance.</p>

      <NbMessage v-if="error" variant="error">
        {{ error }}
      </NbMessage>
      <NbMessage v-else-if="loggedOut" variant="success">You have been signed out.</NbMessage>

      <NbButton variant="primary" :disabled="loading" @click="signIn">
        <span v-if="loading">Redirecting…</span>
        <span v-else>Sign in via Nubisco Platform</span>
      </NbButton>
      <NbButton variant="tertiary" :disabled="loading" @click="pickAccount">Use a different account</NbButton>
    </NbPanel>
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

  // Auth disabled: nobody should be on /login, send them home.
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
/* The consent screen has the same shape: both are the bridge's front doors. */
.login {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: var(--nb-spacing-16);
  background: var(--nb-c-bg-soft);

  &__panel {
    width: min(100%, 28rem);
    display: grid;
    gap: var(--nb-spacing-16);
    text-align: center;

    h1 {
      margin: 0;
    }
  }

  &__mark {
    display: block;
    margin-inline: auto;
  }

  &__note {
    margin: 0;
    color: var(--nb-c-text-muted);
  }
}
</style>
