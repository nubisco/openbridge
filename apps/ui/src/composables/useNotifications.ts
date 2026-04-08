import { useNotificationsStore } from '@/stores/notifications'
import type { NotificationVariant } from '@/stores/notifications'

export interface NotifyOptions {
  title?: string
  duration?: number
}

let _counter = 0

function uid(): string {
  return `notif-${Date.now()}-${++_counter}`
}

export function useNotifications() {
  const store = useNotificationsStore()

  function notify(variant: NotificationVariant, message: string, options?: NotifyOptions) {
    store.add({
      id: uid(),
      variant,
      message,
      title: options?.title,
      duration: options?.duration ?? (variant === 'error' ? 6000 : 3200),
    })
  }

  return {
    success: (message: string, options?: NotifyOptions) => notify('success', message, options),
    error: (message: string, options?: NotifyOptions) => notify('error', message, options),
    warning: (message: string, options?: NotifyOptions) => notify('warning', message, options),
    info: (message: string, options?: NotifyOptions) => notify('info', message, options),
    dismiss: (id: string) => store.remove(id),
    clear: () => store.clear(),
  }
}
