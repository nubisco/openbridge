<template>
  <NbModal close-appearance="button" :open="open" title="Notifications" size="sm" @close="emit('close')">
    <div class="notify">
      <p class="notify__lede">
        The bell tells you when a device has not answered for ten minutes, when it comes back, when a plugin fails, and
        when an update is out. Nothing is sent by email.
      </p>

      <h3 class="notify__heading">This device</h3>
      <p class="notify__lede">
        A desktop notification arrives the moment something happens, while OpenBridge is open in a tab. It is per
        browser, so allowing it here says nothing about your phone.
      </p>

      <NbButton v-if="permission === 'default'" size="sm" variant="secondary" icon="bell" @click="askForDesktop">
        Allow notifications on this device
      </NbButton>
      <!-- Callout rather than inline: these are standing facts about the
           browser, and dismissing one would not make it untrue. -->
      <NbBanner v-else-if="permission === 'granted'" status="success" variant="callout">
        Allowed on this device.
      </NbBanner>
      <NbBanner v-else-if="permission === 'denied'" status="info" variant="callout">
        Blocked on this device. Browsers only ask once, so turning it back on means changing the site permission in the
        address bar.
      </NbBanner>
      <NbBanner v-else status="info" variant="callout">
        This browser does not support desktop notifications, or only allows them on a secure (https) address.
      </NbBanner>
    </div>
  </NbModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useNotificationsStore, type DesktopPermission } from '@/stores/notifications'

/**
 * The walkthrough to this browser's notification permission, after Acta's
 * (`acta/web/src/components/settings/SettingsNotifications.vue`). Kept out of
 * the bell's panel, which is a list and not a settings page.
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const notifications = useNotificationsStore()

function current(): DesktopPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

const permission = ref(current())
watch(
  () => props.open,
  (open) => {
    if (open) permission.value = current()
  },
)

async function askForDesktop(): Promise<void> {
  permission.value = await notifications.enableDesktopNotifications()
}
</script>

<style lang="scss" scoped>
.notify {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.75rem;
}

.notify__heading {
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.notify__lede {
  margin: 0;
  color: var(--nb-c-text-muted);
}
</style>
