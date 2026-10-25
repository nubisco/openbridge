<template>
  <!-- The rail collapses from the top, beside the brand (the fleet standard).
       One menu serves both states: a labelled row expanded, an icon with a
       flyout label collapsed. On a phone it is the drawer, and the shell
       renders no header toggle there. -->
  <NbShell
    :inspector-visible="inspector.visible"
    :main-padding="!layout.fullBleed"
    :sidebar-variant="nav.variant.value"
    sidebar-header-action-position="start"
    sidebar-header-action-compact="swap"
  >
    <!-- ═══ Brand ═══ -->
    <template #sidebar-logo>
      <RouterLink to="/dashboard" class="sidebar-brand-link" aria-label="OpenBridge, dashboard">
        <NbSidebarBrand title="OpenBridge">
          <template #icon>
            <img src="/logo.svg" width="28" height="28" alt="" />
          </template>
        </NbSidebarBrand>
      </RouterLink>
    </template>
    <template #sidebar-header-action>
      <NbSidebarHeaderToggle @toggle="nav.toggle" />
    </template>

    <!-- ═══ Navigation ═══ -->
    <template #sidebar-nav>
      <NbSidebarMenu>
        <NbSidebarMenuItem
          v-for="item in navItems"
          :key="item.name"
          :icon="item.icon"
          :label="item.label"
          :to="item.href"
          :active="route.name === item.name"
        />
      </NbSidebarMenu>
    </template>

    <!-- ═══ Bottom actions ═══ -->
    <template #sidebar-bottom>
      <!-- The fleet's bottom order: Documentation, Sponsor, Settings, the
           person, then this product's own status. Openbridge has no
           notifications yet, so that row is absent rather than empty.
           External links open a new tab from here because the menu item has no
           `target`, and stepping out to read must not lose the page open here. -->
      <NbSidebarMenu>
        <NbSidebarMenuItem icon="book" label="Documentation" :href="DOCS_URL" @click.prevent="openExternal(DOCS_URL)" />
        <!-- Openbridge is free, with no hosted service around it, so it is the
             one product that asks for sponsorship (see "Every rail has the same
             anatomy" in the workspace AGENTS.md). Same URL as FUNDING.yml. -->
        <NbSidebarMenuItem
          icon="heart"
          label="Sponsor"
          :href="SPONSOR_URL"
          @click.prevent="openExternal(SPONSOR_URL)"
        />
        <!-- Instance configuration. A self-hosted instance has no tenant above
             it, so this is the tenant-level Settings and sits in its slot. -->
        <NbSidebarMenuItem icon="gear" label="Settings" to="/settings" :active="route.name === 'settings'" />
      </NbSidebarMenu>
      <NbUserMenu
        v-if="auth.config.value?.enabled && auth.user.value"
        :user="{ email: auth.user.value.email, name: auth.user.value.name, picture: auth.user.value.picture }"
        trigger="identity"
        show-theme
        :accounts="menuAccounts"
        :accounts-unknown="accountsUnknown"
        :show-account-actions="auth.isNubiscoPlatform.value"
        :show-profile="auth.isNubiscoPlatform.value"
        :brand="auth.isNubiscoPlatform.value ? 'footer' : undefined"
        @open="loadIdentities"
        @switch="onSwitchAccount"
        @switch-account="auth.chooseAccount()"
        @add-account="auth.addAccount()"
        @remove="removeAccount"
        @profile="openProfile"
        @sign-out="signOut"
      >
        <template #default="{ close }">
          <NbMenuItem
            icon="sign-out"
            label="Sign out of all apps"
            danger
            @select="((close as () => void)(), auth.logoutEverywhere())"
          />
        </template>
      </NbUserMenu>
      <!-- Status, not a destination, and the one thing only Openbridge has, so
           it sits last, apart from the rows every product shares. -->
      <NbSidebarStatus :label="daemonLabel" :status="daemon.connected ? 'success' : 'danger'" />
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
    </template>

    <!-- ═══ Notification banner ═══ -->
    <!-- `flush` spans the slot edge to edge; `inline` rather than `callout`
         because an available update is an outcome you can acknowledge, and
         callout ignores `dismissible` by design. -->
    <template v-if="updateAvailable && !updateDismissed" #notification>
      <NbBanner
        status="info"
        icon="arrow-circle-up"
        flush
        dismissible
        :title="`OpenBridge v${updateAvailable} is available`"
        @dismiss="updateDismissed = true"
      >
        <template #action>
          <NbButton
            variant="ghost"
            size="sm"
            href="https://github.com/nubisco/openbridge/releases"
            target="_blank"
            rel="noopener"
          >
            See what's new
          </NbButton>
        </template>
      </NbBanner>
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
import { useSidebarVariant } from '@nubisco/ui'
import { useRoute } from 'vue-router'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { useAuth, type PlatformIdentity } from '@/composables/useAuth'
import PluginInspector from '@/components/PluginInspector.vue'
import MarketplacePanel from '@/components/MarketplacePanel.vue'
import DeviceInspector from '@/components/DeviceInspector.vue'
import LiveLogsPanel from '@/components/LiveLogsPanel.vue'

const route = useRoute()
const daemon = useDaemonStore()
const inspector = useInspectorStore()
const layout = useLayoutStore()
const auth = useAuth()

// Collapsed or expanded is the person's choice, remembered per browser, never
// derived from the route.
const nav = useSidebarVariant({ storageKey: 'openbridge.sidebar' })

const daemonLabel = computed(() => (daemon.connected ? 'Daemon connected' : 'Daemon offline'))

const DOCS_URL = 'https://docs.nubisco.io/openbridge/'
const SPONSOR_URL = 'https://github.com/sponsors/joseporto'

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener')
}

async function signOut() {
  await auth.logout()
}

/**
 * The profile is the platform's, not ours.
 *
 * Products do not build a profile page or an avatar upload: a person changes
 * both in one place, and every app picks the change up at the next sign-in.
 */
function openProfile() {
  const issuer = auth.config.value?.issuer
  if (!issuer) return
  window.open(`${issuer}/profile`, '_blank', 'noopener')
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
// The brand links home. NbSidebarBrand lays out the mark and the name for both
// rail states. The link only has to stretch and drop its underline.
.sidebar-brand-link {
  display: flex;
  min-width: 0;
  width: 100%;
  color: inherit;
  text-decoration: none;
}

// Teleport targets for per-view topbar chrome
.topbar-slot {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
