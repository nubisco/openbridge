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

export interface PlatformIdentity {
  sub: string
  email: string
  name?: string
  auth_time?: number
}

export interface LoginOptions {
  /** Resume or switch to a specific account (platform pre-selects it). */
  loginHint?: string
  /** 'login' forces a fresh OTP; 'select_account' shows the account chooser. */
  prompt?: 'login' | 'select_account'
  /**
   * Marks this round-trip as a non-interactive renewal of an existing
   * session: the callback rejects tokens whose subject differs, instead of
   * silently adopting another account.
   */
  expectedSub?: string
}

const STATE_KEY = 'openbridge_platform_state'
const EXPECTED_SUB_KEY = 'openbridge_platform_expected_sub'
// Remembers the account this app last used on this browser, so a session
// expiry can resume the SAME subject (login_hint + expected_sub) instead of
// whatever identity the platform would otherwise pick.
const LAST_ACCOUNT_KEY = 'openbridge_last_account'

// Module-level singletons — all callers share the same state.
const user = ref<AuthUser | null>(null)
const config = ref<PlatformAuthConfig | null>(null)
const ready = ref(false)

interface LastAccount {
  sub: string
  email: string
}

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

  function getLastAccount(): LastAccount | null {
    try {
      const raw = localStorage.getItem(LAST_ACCOUNT_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as LastAccount
      return parsed.sub && parsed.email ? parsed : null
    } catch {
      return null
    }
  }

  function saveLastAccount(account: LastAccount): void {
    try {
      localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify(account))
    } catch {
      /* storage unavailable */
    }
  }

  function clearLastAccount(): void {
    try {
      localStorage.removeItem(LAST_ACCOUNT_KEY)
    } catch {
      /* storage unavailable */
    }
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
      saveLastAccount({ sub: data.user.id, email: data.user.email })
      ready.value = true
      return true
    } catch {
      user.value = null
      ready.value = true
      return false
    }
  }

  async function startPlatformLogin(options: LoginOptions = {}): Promise<void> {
    const cfg = await loadConfig()
    if (!cfg.enabled || !cfg.issuer) return

    const appId = cfg.appId ?? 'openbridge'
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    sessionStorage.setItem(STATE_KEY, state)
    if (options.expectedSub) sessionStorage.setItem(EXPECTED_SUB_KEY, options.expectedSub)
    else sessionStorage.removeItem(EXPECTED_SUB_KEY)

    const redirectUri = `${window.location.origin}/auth/callback`
    const ssoUrl = new URL(`${cfg.issuer}/api/auth/sso`)
    ssoUrl.searchParams.set('app_id', appId)
    ssoUrl.searchParams.set('redirect_uri', redirectUri)
    ssoUrl.searchParams.set('state', state)
    // No prompt by default: the platform resolves this app's pinned identity
    // (or shows its account chooser), and never hands us a login performed
    // for another product. Explicit prompts are only for "add account" /
    // "choose account" actions.
    if (options.prompt) ssoUrl.searchParams.set('prompt', options.prompt)
    if (options.loginHint) ssoUrl.searchParams.set('login_hint', options.loginHint)
    window.location.href = ssoUrl.toString()
  }

  /** Resume the account this app last used, guaranteeing the same subject. */
  async function resumeLastAccount(): Promise<boolean> {
    const last = getLastAccount()
    if (!last) return false
    await startPlatformLogin({ loginHint: last.email, expectedSub: last.sub })
    return true
  }

  /** Explicit switch to another signed-in (or new) account. */
  async function switchAccount(email: string): Promise<void> {
    await startPlatformLogin({ loginHint: email })
  }

  /** Sign in an additional account via a fresh OTP. */
  async function addAccount(): Promise<void> {
    await startPlatformLogin({ prompt: 'login' })
  }

  /** Let the user pick among the identities on this browser. */
  async function chooseAccount(): Promise<void> {
    await startPlatformLogin({ prompt: 'select_account' })
  }

  /**
   * Identities signed in on this browser. Requires the platform session
   * cookie to be visible cross-origin (CORS + cookie policy); returns []
   * whenever it is not, and callers fall back to the redirect flows.
   */
  async function listIdentities(): Promise<PlatformIdentity[]> {
    const cfg = await loadConfig()
    if (!cfg.enabled || !cfg.issuer) return []
    try {
      const res = await fetch(`${cfg.issuer}/api/auth/identities`, { credentials: 'include' })
      if (!res.ok) return []
      const data = (await res.json()) as { identities?: PlatformIdentity[] }
      return data.identities ?? []
    } catch {
      return []
    }
  }

  /**
   * Sign out of THIS app only. The platform browser session (and any other
   * signed-in products) is left untouched — in the multi-account model an
   * app-level sign-out must not destroy other apps' identities.
   */
  async function logout(): Promise<void> {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => null)
    user.value = null
    clearLastAccount()
    window.location.href = '/login?logged_out=1'
  }

  /**
   * Sign out of the platform entirely: destroys the platform browser session
   * (all identities, all apps) in addition to the local one. Explicit and
   * destructive — only for the dedicated menu action.
   */
  async function logoutEverywhere(): Promise<void> {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => null)
    user.value = null
    clearLastAccount()

    const cfg = config.value
    if (cfg?.enabled && cfg.issuer && cfg.appId) {
      const postLogout = `${window.location.origin}/login?logged_out=1`
      const url = new URL('/api/auth/sso/end-session', cfg.issuer)
      url.searchParams.set('app_id', cfg.appId)
      url.searchParams.set('post_logout_redirect_uri', postLogout)
      window.location.href = url.toString()
      return
    }
    window.location.href = '/login?logged_out=1'
  }

  return {
    user,
    config,
    ready,
    loadConfig,
    checkAuth,
    startPlatformLogin,
    resumeLastAccount,
    switchAccount,
    addAccount,
    chooseAccount,
    listIdentities,
    getLastAccount,
    clearLastAccount,
    logout,
    logoutEverywhere,
  }
}
