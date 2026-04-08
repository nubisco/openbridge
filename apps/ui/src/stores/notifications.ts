import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type NotificationVariant = 'success' | 'error' | 'warning' | 'info'

export interface NotificationItem {
  id: string
  variant: NotificationVariant
  message: string
  title?: string
  duration?: number
}

const MAX_VISIBLE = 4

export const useNotificationsStore = defineStore('notifications', () => {
  const queue = ref<NotificationItem[]>([])

  const visible = computed(() => queue.value.slice(0, MAX_VISIBLE))

  function add(item: NotificationItem) {
    queue.value.push(item)
  }

  function remove(id: string) {
    const idx = queue.value.findIndex((n) => n.id === id)
    if (idx !== -1) queue.value.splice(idx, 1)
  }

  function clear() {
    queue.value = []
  }

  return { queue, visible, add, remove, clear }
})
