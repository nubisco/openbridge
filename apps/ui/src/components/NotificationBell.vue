<template>
  <NbNotificationCenter
    v-model:open="open"
    label="Notifications"
    :unread-count="notifications.unread"
    :item-count="notifications.items.length"
    :loading="loading"
    :error="failed"
    error-title="Could not load notifications"
    error-description="The list below may be out of date."
    empty-title="Nothing to report"
    empty-description="You hear here when a device stops answering, a plugin fails, or an update is out."
    :width="360"
    side="right"
    align="end"
    close-on-select
    close-on-navigate
    @mark-all-read="notifications.markAllRead()"
    @retry="load"
  >
    <template #trigger="{ triggerProps, setTriggerRef, toggle }">
      <!-- One menu item in both rail states, like every other row (Acta's
           shape). Expanded it is a labelled row with the count at its end.
           Collapsed it is the icon alone, with the count on its corner. -->
      <NbSidebarMenu>
        <NbSidebarMenuItem
          :ref="setTriggerRef"
          v-bind="triggerProps"
          label="Notifications"
          :icon="notifications.unread > 0 ? 'bell-ringing' : 'bell'"
          :active="open"
          :badge="notifications.unread > 0 ? notifications.unread : undefined"
          badge-variant="danger"
          @click="toggle"
        />
      </NbSidebarMenu>
    </template>

    <!-- Replacing the header actions keeps the library's pending-safe
         mark-all and adds the way to this device's desktop permission, which
         lives in its own dialog rather than inside the list. -->
    <template #header-actions="{ markAllProps, markAllText }">
      <NbButton
        v-nb-tooltip="{ body: 'Notification settings' }"
        size="xs"
        variant="ghost"
        icon="sliders-horizontal"
        aria-label="Notification settings"
        @click="openSettings"
      />
      <NbButton v-if="notifications.unread > 0" size="xs" variant="ghost" outlined v-bind="markAllProps">
        {{ markAllText }}
      </NbButton>
    </template>

    <NbNotificationCenterItem
      v-for="entry in notifications.items"
      :key="entry.id"
      :title="entry.title"
      :body="entry.body"
      :time="entry.createdAt"
      :read="entry.read"
      :variant="entry.variant"
      :interactive="entry.target !== null"
      @select="openEntry(entry)"
    />
  </NbNotificationCenter>

  <NotificationSettingsModal :open="settingsOpen" @close="settingsOpen = false" />
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useNotificationsStore, type BridgeNotification } from '@/stores/notifications'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore } from '@/stores/inspector'
import { useAuth } from '@/composables/useAuth'
import NotificationSettingsModal from '@/components/NotificationSettingsModal.vue'

/**
 * The bell, after Acta's (`acta/web/src/components/NotificationBell.vue`).
 *
 * The rows are the bridge's events, so there is no person to put in the media
 * slot. The variant carries the consequence (warning for a device or plugin
 * that needs looking at, success for one that recovered, info for an update),
 * and the sentence carries the rest. On a phone the library turns the panel
 * into a sheet by itself, so nothing here changes for it.
 */
const notifications = useNotificationsStore()
const daemon = useDaemonStore()
const inspector = useInspectorStore()
const router = useRouter()
const auth = useAuth()

const open = ref(false)
const loading = ref(false)
const failed = ref(false)
const settingsOpen = ref(false)

/**
 * A failure is its own state and not a flavour of empty: a bell that says
 * "nothing to report" because the request failed is the one wrong answer it
 * can give.
 */
async function load(): Promise<void> {
  loading.value = notifications.items.length === 0
  failed.value = false
  try {
    failed.value = !(await notifications.load())
  } finally {
    loading.value = false
  }
}

/** Opens what the row is about and marks that one read. The rest stay as they were. */
async function openEntry(entry: BridgeNotification): Promise<void> {
  void notifications.markRead(entry.id)
  await openTarget(entry)
}

async function openTarget(entry: BridgeNotification): Promise<void> {
  const target = entry.target
  if (!target) return
  if (target.kind === 'device') {
    await router.push(`/devices/${encodeURIComponent(target.id)}`)
    return
  }
  if (target.kind === 'settings') {
    await router.push('/settings')
    return
  }
  if (target.kind === 'config') {
    await router.push('/config')
    return
  }
  // A plugin opens in its inspector over the plugin list, the way a plugin
  // opens from that list. The layout closes the inspector on a page change,
  // so it is opened once the page has changed.
  if (router.currentRoute.value.name !== 'plugins') {
    await router.push('/plugins')
    await nextTick()
  }
  let plugin = daemon.plugins.find((p) => p.id === target.id)
  if (!plugin) {
    await daemon.fetchPlugins()
    plugin = daemon.plugins.find((p) => p.id === target.id)
  }
  if (plugin) inspector.openPlugin(plugin)
}

function openSettings(): void {
  open.value = false
  settingsOpen.value = true
}

// The read state is the signed-in person's, so another person signing in in
// this tab starts from theirs.
watch(
  () => auth.user.value?.id,
  (now, before) => {
    if (now === before) return
    notifications.reset()
    void load()
  },
)

onMounted(() => {
  notifications.setOpener((n) => void openTarget(n))
  void load()
  notifications.connect()
})
onUnmounted(() => {
  notifications.setOpener(null)
  notifications.disconnect()
})
</script>
