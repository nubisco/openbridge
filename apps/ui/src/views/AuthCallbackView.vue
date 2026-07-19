<template>
  <div class="callback-page">
    <NbMessage v-if="error" variant="error">{{ error }}</NbMessage>
    <p v-else class="callback-loading">Signing you in…</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'

const route = useRoute()
const router = useRouter()
const { checkAuth, clearLastAccount } = useAuth()

const error = ref<string | null>(null)

onMounted(async () => {
  const token = typeof route.query.token === 'string' ? route.query.token : ''
  const state = typeof route.query.state === 'string' ? route.query.state : ''
  const platformError = typeof route.query.error === 'string' ? route.query.error : ''
  const stored = sessionStorage.getItem('openbridge_platform_state')
  sessionStorage.removeItem('openbridge_platform_state')
  // Set only for non-interactive renewals: the daemon must reject a token
  // whose subject differs from the session being renewed.
  const expectedSub = sessionStorage.getItem('openbridge_platform_expected_sub')
  sessionStorage.removeItem('openbridge_platform_expected_sub')

  if (platformError) {
    error.value =
      platformError === 'not_a_member'
        ? 'Your account does not have access to this OpenBridge instance.'
        : platformError === 'domain_not_allowed'
          ? 'Your account is not eligible for this OpenBridge instance.'
          : `Sign-in failed: ${platformError}`
    return
  }

  if (!stored || !state || stored !== state) {
    error.value = 'The sign-in request is no longer valid. Please try again.'
    return
  }

  if (!token) {
    error.value = 'Platform did not return an OpenBridge access token.'
    return
  }

  // Exchange the platform token for a local openbridge session cookie.
  const res = await fetch('/auth/platform/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ token, ...(expectedSub ? { expected_sub: expectedSub } : {}) }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    if (data?.error === 'subject_mismatch') {
      // The renewal came back as a different account. Never adopt it —
      // forget the expectation and restart an interactive login.
      clearLastAccount()
      router.replace({ path: '/login', query: { error: 'account_changed' } })
      return
    }
    error.value =
      data?.error === 'invalid_token'
        ? 'Your platform sign-in is no longer valid. Please try again.'
        : data?.error === 'wrong_app'
          ? 'The sign-in was issued for a different application. Please try again.'
          : 'Sign-in failed. Please try again.'
    return
  }

  await checkAuth()
  // Successful sign-in re-arms the login page's one-shot silent resume.
  sessionStorage.removeItem('openbridge_auto_resume_attempted')
  router.replace('/')
})
</script>

<style scoped lang="scss">
.callback-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.callback-loading {
  color: var(--nb-c-text-subtle);
  font-size: var(--nb-font-size-14);
}
</style>
