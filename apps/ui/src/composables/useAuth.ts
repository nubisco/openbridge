import { ref } from 'vue'

export interface AuthUser {
  id: string
  email: string
}

export interface PlatformAuthConfig {
  enabled: boolean
  issuer: string | null
  appId: string | null
}

// Module-level singletons — all callers share the same state.
const user = ref<AuthUser | null>(null)
const config = ref<PlatformAuthConfig | null>(null)
const ready = ref(false)

export function useAuth() {
  async function loadConfig(): Promise<PlatformAuthConfig> {
    if (config.value) return config.value
    const res = await fetch('/auth/platform/config')
    if (!res.ok) {
      const fallback: PlatformAuthConfig = { enabled: false, issuer: null, appId: null }
      config.value = fallback
      return fallback
    }
    const data = (await res.json()) as PlatformAuthConfig
    config.value = data
    return data
  }

  async function checkAuth(): Promise<boolean> {
    const cfg = await loadConfig()
    if (!cfg.enabled) {
      // Auth disabled: pretend we're authenticated, openbridge is fully public.
      user.value = null
      ready.value = true
      return true
    }
    try {
      const res = await fetch('/auth/me', { credentials: 'include' })
      if (!res.ok) {
        user.value = null
        ready.value = true
        return false
      }
      const data = (await res.json()) as { user: AuthUser }
      user.value = data.user
      ready.value = true
      return true
    } catch {
      user.value = null
      ready.value = true
      return false
    }
  }

  async function startPlatformLogin(): Promise<void> {
    const cfg = await loadConfig()
    if (!cfg.enabled || !cfg.issuer) return

    const appId = cfg.appId ?? 'openbridge'
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    sessionStorage.setItem('openbridge_platform_state', state)

    const redirectUri = `${window.location.origin}/auth/callback`
    const ssoUrl = new URL(`${cfg.issuer}/api/auth/sso`)
    ssoUrl.searchParams.set('app_id', appId)
    ssoUrl.searchParams.set('redirect_uri', redirectUri)
    ssoUrl.searchParams.set('state', state)
    // Force the platform to prompt for credentials so we never inherit
    // a stale platform session belonging to a different identity.
    ssoUrl.searchParams.set('prompt', 'login')
    window.location.href = ssoUrl.toString()
  }

  async function logout(): Promise<void> {
    // 1. Clear the local openbridge session.
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => null)
    user.value = null

    // 2. Tell the platform to destroy its session as well, so the next
    //    sign-in prompts the user instead of silently re-authenticating.
    const cfg = config.value
    if (cfg?.enabled && cfg.issuer && cfg.appId) {
      const postLogout = `${window.location.origin}/login`
      const url = new URL('/api/auth/sso/end-session', cfg.issuer)
      url.searchParams.set('app_id', cfg.appId)
      url.searchParams.set('post_logout_redirect_uri', postLogout)
      window.location.href = url.toString()
      return
    }
    window.location.href = '/login'
  }

  return { user, config, ready, loadConfig, checkAuth, startPlatformLogin, logout }
}
