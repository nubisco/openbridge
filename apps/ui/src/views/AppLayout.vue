<template>
  <NbShell :inspector-visible="inspector.visible">
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
    </template>

    <!-- ═══ Topbar ═══ -->
    <template #topbar-left>
      <span v-if="layout.title" class="topbar-title">{{ layout.title }}</span>
      <NbBadge v-if="layout.count !== null">{{ layout.count }}</NbBadge>
    </template>
    <template #topbar-right>
      <component :is="layout.actionsComponent" v-if="layout.actionsComponent" />
    </template>

    <!-- ═══ Inspector ═══ -->
    <template #inspector>
      <PluginInspector v-if="inspector.mode === 'plugin'" />
      <MarketplacePanel v-else-if="inspector.mode === 'marketplace'" />
    </template>

    <!-- ═══ Main content ═══ -->
    <div v-if="updateAvailable && !updateDismissed" class="update-banner">
      <NbIcon name="arrow-circle-up" :size="14" />
      <span>
        OpenBridge
        <strong>v{{ updateAvailable }}</strong>
        is available.
      </span>
      <a href="https://github.com/nubisco/openbridge/releases" target="_blank" rel="noopener" class="update-link">
        See what's new
      </a>
      <button class="update-dismiss" @click="updateDismissed = true">
        <NbIcon name="x" :size="12" />
      </button>
    </div>

    <RouterView />
  </NbShell>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import PluginInspector from '@/components/PluginInspector.vue'
import MarketplacePanel from '@/components/MarketplacePanel.vue'

const route = useRoute()
const daemon = useDaemonStore()
const inspector = useInspectorStore()
const layout = useLayoutStore()

const updateAvailable = ref<string | null>(null)
const updateDismissed = ref(false)

async function checkForUpdate() {
  try {
    const res = await fetch('/api/updates/check')
    if (!res.ok) return
    const data = (await res.json()) as { updateAvailable: boolean; latest: string }
    if (data.updateAvailable && data.latest) updateAvailable.value = data.latest
  } catch {
    // network unavailable — silently ignore
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
// Sidebar logo — local tooltip (NbShell slot can't use NbSidebarLink's scoped tooltip)
.sidebar-logo {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  text-decoration: none;

  &[data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    left: calc(100% + 10px);
    top: 50%;
    transform: translateY(-50%);
    background: rgba(15, 15, 30, 0.95);
    color: #fff;
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

// Daemon status indicator
.daemon-status {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  position: relative;

  &[data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    left: calc(100% + 10px);
    top: 50%;
    transform: translateY(-50%);
    background: rgba(15, 15, 30, 0.95);
    color: #fff;
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

  .daemon-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #6b7280;
    transition: background 0.3s;
  }

  &.online .daemon-dot {
    background: #34d399;
    box-shadow: 0 0 6px rgba(52, 211, 153, 0.6);
  }

  &.offline .daemon-dot {
    background: #f87171;
  }
}

// Topbar left title
.topbar-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #1a1a2e;
}

// Update banner — rendered in the default (main) slot, above RouterView
.update-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 1.5rem;
  background: #0ea5e9;
  color: #fff;
  font-size: 0.8rem;

  .update-link {
    color: #fff;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 2px;
    margin-left: 0.25rem;
  }

  .update-dismiss {
    margin-left: auto;
    background: transparent;
    border: none;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    display: flex;
    align-items: center;
    padding: 0.1rem;

    &:hover {
      color: #fff;
    }
  }
}
</style>
