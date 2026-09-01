<template>
  <NbShell :inspector-visible="inspector.visible" :main-padding="!layout.fullBleed">
    <!-- ═══ Logo ═══ -->
    <template #sidebar-logo>
      <RouterLink to="/dashboard" data-tooltip="OpenBridge" class="sidebar-logo">
        <img src="/logo.svg" width="32" height="32" alt="OpenBridge logo" />
      </RouterLink>
    </template>

    <!-- ═══ Navigation ═══ -->
    <template #sidebar-nav>
      <NbSidebarLink
        v-for="item in navItems"
        :key="item.name"
        :to="item.href"
        :tooltip="item.label"
        :active="route.name === item.name"
        @click.prevent="router.push(item.href)"
      >
        <NbIcon :name="item.icon" :size="18" />
      </NbSidebarLink>
    </template>

    <!-- ═══ Bottom actions ═══ -->
    <template #sidebar-bottom>
      <div
        class="daemon-status"
        :class="daemon.connected ? 'online' : 'offline'"
        :data-tooltip="daemon.connected ? 'Daemon connected' : 'Daemon offline'"
      >
        <span class="daemon-dot" />
      </div>
      <NbUserMenu
        v-if="auth.config.value?.enabled && auth.user.value"
        :user="{ email: auth.user.value.email }"
        :accounts="menuAccounts"
        :accounts-unknown="accountsUnknown"
        :show-profile="false"
        @open="loadIdentities"
        @switch="onSwitchAccount"
        @switch-account="auth.chooseAccount()"
        @add-account="auth.addAccount()"
        @remove="removeAccount"
        @sign-out="signOut"
      >
        <template #default="{ close }">
          <button
            type="button"
            role="menuitem"
            class="nb-user-menu__action nb-user-menu__action--danger"
            @click="((close as () => void)(), auth.logoutEverywhere())"
          >
            <NbIcon name="sign-out" :size="15" />
            Sign out of all apps
          </button>
        </template>
      </NbUserMenu>
    </template>

    <!-- ═══ Topbar ═══ -->
    <!-- The two empty divs are teleport targets. Views render their own chrome
         into them (see stores/layout.ts), which keeps handlers and reactive
         state in the view that owns them. -->
    <template #topbar-left>
      <NbBreadcrumbs :subtitle="layout.title" />
      <NbBadge v-if="layout.count !== null">{{ layout.count }}</NbBadge>
      <div id="ob-topbar-left" class="topbar-slot" />
    </template>
    <template #topbar-right>
      <div id="ob-topbar-right" class="topbar-slot" />
      <NbButton
        variant="ghost"
        size="sm"
        :icon="resolved === 'dark' ? 'sun' : 'moon'"
        :title="resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggle()"
      />
    </template>

    <!-- ═══ Notification banner ═══ -->
    <template v-if="updateAvailable && !updateDismissed" #notification>
      <div class="update-banner">
        <NbIcon name="arrow-circle-up" :size="14" />
        <span>
          OpenBridge
          <strong>v{{ updateAvailable }}</strong>
          is available.
        </span>
        <a href="https://github.com/nubisco/openbridge/releases" target="_blank" rel="noopener" class="update-link">
          See what's new
        </a>
        <NbButton
          variant="ghost"
          size="xs"
          icon="x"
          title="Dismiss"
          class="update-dismiss"
          @click="updateDismissed = true"
        />
      </div>
    </template>

    <!-- ═══ Inspector ═══ -->
    <template #inspector>
      <PluginInspector v-if="inspector.mode === 'plugin'" />
      <MarketplacePanel v-else-if="inspector.mode === 'marketplace'" />
      <DeviceInspector v-else-if="inspector.mode === 'device'" />
    </template>

    <!-- ═══ Live logs ═══ -->
    <!-- App-wide: the log socket is opened here and streams regardless of the
         active view, so the console belongs to the shell, not the dashboard. -->
    <template #bottom>
      <LiveLogsPanel />
    </template>

    <!-- ═══ Main content ═══ -->
    <RouterView />
  </NbShell>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { useAuth, type PlatformIdentity } from '@/composables/useAuth'
import { useTheme } from '@/composables/useTheme'
import PluginInspector from '@/components/PluginInspector.vue'
import MarketplacePanel from '@/components/MarketplacePanel.vue'
import DeviceInspector from '@/components/DeviceInspector.vue'
import LiveLogsPanel from '@/components/LiveLogsPanel.vue'

const route = useRoute()
const router = useRouter()
const daemon = useDaemonStore()
const inspector = useInspectorStore()
const layout = useLayoutStore()
const auth = useAuth()
const { resolved, toggle } = useTheme()

async function signOut() {
  await auth.logout()
}

// ─── Account menu (NbUserMenu) ──────────────────────────────────────────────
// Identities load when the menu opens; when the platform can't expose them
// cross-origin the menu falls back to the redirect account chooser
// (accountsUnknown). The current account is matched by our own session's
// sub, never by the platform's active flag.
const identities = ref<PlatformIdentity[]>([])
const accountsUnknown = ref(true)

const menuAccounts = computed(() =>
  identities.value.map((identity) => ({
    id: identity.sub,
    email: identity.email,
    name: identity.name,
    current: identity.sub === auth.user.value?.id,
  })),
)

async function loadIdentities() {
  const list = await auth.listIdentities()
  identities.value = list
  accountsUnknown.value = list.length === 0
}

function onSwitchAccount(account: { email: string }) {
  auth.switchAccount(account.email)
}

async function removeAccount(account: { id: string }) {
  await auth.removeIdentity(account.id)
  await loadIdentities()
}

const updateAvailable = ref<string | null>(null)
const updateDismissed = ref(false)

async function checkForUpdate() {
  try {
    const res = await fetch('/api/updates/check')
    if (!res.ok) return
    const data = (await res.json()) as { updateAvailable: boolean; latest: string }
    if (data.updateAvailable && data.latest) updateAvailable.value = data.latest
  } catch {
    // network unavailable: silently ignore
  }
}

const navItems = [
  { name: 'dashboard', icon: 'house', label: 'Dashboard', href: '/dashboard' },
  { name: 'plugins', icon: 'puzzle-piece', label: 'Plugins', href: '/plugins' },
  { name: 'devices', icon: 'devices', label: 'Devices', href: '/devices' },
  { name: 'config', icon: 'brackets-curly', label: 'Config', href: '/config' },
  { name: 'terminal', icon: 'terminal', label: 'Terminal', href: '/terminal' },
  { name: 'settings', icon: 'gear', label: 'Settings', href: '/settings' },
]

// Close inspector when navigating away
watch(
  () => route.name,
  () => inspector.close(),
)

onMounted(async () => {
  await daemon.fetchHealth()
  await daemon.fetchPlugins()
  // Preload recent history: the socket only delivers entries from now on, and
  // the logs panel is mounted app-wide.
  daemon.fetchLogs()
  daemon.connectLiveLogs()

  // Poll health every 10s
  const interval = setInterval(() => daemon.fetchHealth(), 10_000)
  onUnmounted(() => clearInterval(interval))

  // Check for updates once on load (non-blocking)
  checkForUpdate()
})
onUnmounted(() => daemon.disconnectLiveLogs())
</script>

<style lang="scss" scoped>
// Flyout tooltip for items in the sidebar rail. The rail keeps its dark chrome
// in both themes (--nb-shell-sidebar-bg), so the tooltip is derived from the
// same variable rather than from the page surface.
@mixin rail-tooltip {
  &[data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    left: calc(100% + 10px);
    top: 50%;
    transform: translateY(-50%);
    background: color-mix(in srgb, var(--nb-shell-sidebar-bg) 95%, transparent);
    color: var(--nb-c-white);
    padding: 0.3rem 0.65rem;
    border-radius: 5px;
    font-size: 0.76rem;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s;
    z-index: 500;
  }

  &[data-tooltip]:hover::after {
    opacity: 1;
  }
}

// Sidebar logo: local tooltip (NbShell slot can't use NbSidebarLink's scoped tooltip)
.sidebar-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  text-decoration: none;

  @include rail-tooltip;
}

// Daemon status indicator
.daemon-status {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  position: relative;

  @include rail-tooltip;

  .daemon-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--nb-c-component-inactive);
    transition: background 0.3s;
  }

  &.online .daemon-dot {
    background: var(--nb-c-success);
    box-shadow: 0 0 6px color-mix(in srgb, var(--nb-c-success) 60%, transparent);
  }

  &.offline .daemon-dot {
    background: var(--nb-c-danger);
  }
}

// Teleport targets for per-view topbar chrome
.topbar-slot {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

// Update banner: rendered in the #notification slot above the topbar
.update-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 1.5rem;
  background: var(--nb-c-info);
  color: var(--nb-c-info-a11y);
  font-size: 0.78rem;

  .update-link {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    margin-left: 0.25rem;
  }

  .update-dismiss {
    margin-left: auto;
    background: transparent;
    border: none;
    color: inherit;
    opacity: 0.8;
    cursor: pointer;
    display: flex;
    align-items: center;
    padding: 0.1rem;

    &:hover {
      opacity: 1;
    }
  }
}
</style>
