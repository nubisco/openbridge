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

const logoSrc = '/logo.svg'

const logoSize = ref(32)

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

<template>
  <NbGrid class="app-layout">
    <!-- ═══ SIDEBAR ═══ -->
    <nav class="app-sidebar">
      <RouterLink to="/dashboard" class="sidebar-logo" data-tooltip="OpenBridge">
        <img :src="logoSrc" :width="logoSize" :height="logoSize" alt="Openbridge logo" class="openbridge-logo__icon" />
      </RouterLink>

      <div class="sidebar-nav">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          :to="item.href"
          class="sidebar-link"
          :class="{ active: route.name === item.name }"
          :data-tooltip="item.label"
        >
          <NbIcon :name="item.icon" :size="18" />
        </RouterLink>
      </div>

      <div class="sidebar-spacer" />

      <div class="sidebar-bottom">
        <!-- Daemon status indicator -->
        <div
          class="daemon-status"
          :class="daemon.connected ? 'online' : 'offline'"
          :data-tooltip="daemon.connected ? 'Daemon connected' : 'Daemon offline'"
        >
          <span class="daemon-dot" />
        </div>
      </div>
    </nav>

    <!-- ═══ CONTENT ═══ -->
    <div class="app-content">
      <header class="app-topbar">
        <div class="topbar-left">
          <span v-if="layout.title" class="topbar-title">{{ layout.title }}</span>
          <NbBadge v-if="layout.count !== null">{{ layout.count }}</NbBadge>
        </div>
        <div class="topbar-right">
          <component :is="layout.actionsComponent" v-if="layout.actionsComponent" />
        </div>
      </header>
      <!-- Update banner -->
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

      <main class="app-main">
        <RouterView />
      </main>
    </div>

    <!-- ═══ INSPECTOR / MARKETPLACE ═══ -->
    <aside v-show="inspector.visible" class="app-inspector">
      <PluginInspector v-if="inspector.mode === 'plugin'" />
      <MarketplacePanel v-else-if="inspector.mode === 'marketplace'" />
    </aside>
  </NbGrid>
</template>

<style lang="scss" scoped>
@mixin sidebar-tooltip {
  &::after {
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
  &:hover::after {
    opacity: 1;
  }
}

.app-layout {
  height: 100vh;
  overflow: hidden;
  background: #f5f6fa;
}

.app-sidebar {
  width: 56px;
  flex-shrink: 0;
  background: #1a1a2e;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem 0;
  height: 100%;
  overflow: visible;
  z-index: 100;
  gap: 0;
}

.sidebar-logo {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 0.75rem;
  flex-shrink: 0;
  position: relative;
  @include sidebar-tooltip;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0 6px;
}

.sidebar-link {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  text-decoration: none;
  color: rgba(255, 255, 255, 0.5);
  transition:
    background 0.15s,
    color 0.15s;
  position: relative;
  flex-shrink: 0;

  &:hover {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.9);
  }
  &.active {
    background: rgba(124, 58, 237, 0.25);
    color: #a78bfa;
  }
  @include sidebar-tooltip;
}

.sidebar-spacer {
  flex: 1;
}

.sidebar-bottom {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 6px 0.5rem;
  gap: 8px;
  width: 100%;
}

.daemon-status {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  position: relative;
  @include sidebar-tooltip;

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

.app-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fff;
}

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

.app-topbar {
  flex-shrink: 0;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 1.5rem;
  border-bottom: 1px solid #f0f0f8;
  background: #fff;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.topbar-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #1a1a2e;
}

.app-main {
  flex: 1;
  padding: 1.5rem 1.75rem;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.app-inspector {
  width: 560px;
  flex-shrink: 0;
  border-left: 1px solid #e8e8f0;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  height: 100%;
}
</style>
