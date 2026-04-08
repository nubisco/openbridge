<script setup lang="ts">
import { watch } from 'vue'
import { useNotificationsStore } from '@/stores/notifications'

const notifications = useNotificationsStore()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

watch(
  () => notifications.visible.map((n) => ({ id: n.id, duration: n.duration ?? 3200 })),
  (items) => {
    for (const item of items) {
      if (timers.has(item.id)) continue
      const timer = setTimeout(() => {
        notifications.remove(item.id)
        timers.delete(item.id)
      }, item.duration)
      timers.set(item.id, timer)
    }
  },
  { immediate: true, deep: true },
)

function dismiss(id: string) {
  const timer = timers.get(id)
  if (timer) {
    clearTimeout(timer)
    timers.delete(id)
  }
  notifications.remove(id)
}
</script>

<template>
  <div class="toast-layer" aria-live="polite" aria-atomic="true">
    <div v-for="n in notifications.visible" :key="n.id" class="toast" :class="`toast--${n.variant}`">
      <div class="toast-body">
        <div v-if="n.title" class="toast-title">{{ n.title }}</div>
        <div class="toast-message">{{ n.message }}</div>
      </div>
      <button class="toast-close" @click="dismiss(n.id)">
        <NbIcon name="x" :size="12" />
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.toast-layer {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  width: min(90vw, 360px);
}

.toast {
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.08);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.55rem;
  padding: 0.55rem 0.6rem 0.6rem;

  &--success {
    border-color: #86efac;
    background: #f0fdf4;
  }

  &--error {
    border-color: #fca5a5;
    background: #fef2f2;
  }

  &--warning {
    border-color: #fcd34d;
    background: #fffbeb;
  }

  &--info {
    border-color: #93c5fd;
    background: #eff6ff;
  }
}

.toast-body {
  min-width: 0;
  flex: 1;
}

.toast-title {
  font-size: 0.74rem;
  font-weight: 700;
  color: #111827;
  margin-bottom: 0.12rem;
}

.toast-message {
  font-size: 0.78rem;
  color: #374151;
  line-height: 1.35;
}

.toast-close {
  border: none;
  background: transparent;
  color: #6b7280;
  padding: 0.15rem;
  cursor: pointer;
  border-radius: 6px;

  &:hover {
    background: rgba(0, 0, 0, 0.06);
  }
}
</style>
