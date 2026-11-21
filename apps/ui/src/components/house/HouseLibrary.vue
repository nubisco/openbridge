<template>
  <!-- What can be put on the plan. Each item can be dragged onto the
       blueprint, or tapped and then placed with a tap on the plan, which works
       for a finger and a keyboard alike. -->
  <div class="house-library">
    <section v-for="g in groups" :key="g.title" class="house-library__group" :aria-label="g.title">
      <h3 class="house-library__title type-heading-compact">{{ g.title }}</h3>
      <p v-if="g.note" class="house-library__note type-helper-text">{{ g.note }}</p>
      <div class="house-library__items">
        <NbButton
          v-for="it in g.items"
          :key="libraryKey(it.item)"
          size="sm"
          :variant="active === libraryKey(it.item) ? 'primary' : 'secondary'"
          :icon="it.icon"
          :aria-pressed="active === libraryKey(it.item)"
          class="house-library__item"
          @pointerdown="(e: PointerEvent) => emit('grab', e, it.item)"
          @click="emit('pick', it.item)"
        >
          {{ it.label }}
        </NbButton>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { HouseFurnitureKind } from '@/api'
import { FURNITURE_NAME } from '@/house/editor'
import { DEVICE_ICON, FURNITURE_ICON, libraryKey, presetIcon, type LibraryItem } from '@/house/library'
import type { LiveDevice } from '@/house/live'
import { DOOR_PRESETS, WINDOW_PRESETS } from '@/house/openings'

const props = defineProps<{
  /** Devices not on the plan yet, in the order to list them. */
  unplaced: LiveDevice[]
  /** The key of the item the next tap on the plan puts down, if any. */
  active: string | null
}>()

const emit = defineEmits<{
  /** Tapped: the next tap on the plan puts it down. */
  pick: [item: LibraryItem]
  /** Pressed: it may be dragged onto the plan. */
  grab: [e: PointerEvent, item: LibraryItem]
}>()

const groups = computed(() => [
  {
    title: 'Doors',
    note: 'Drop one on a wall.',
    items: DOOR_PRESETS.map((p) => ({
      item: { type: 'opening', preset: p } as LibraryItem,
      label: p.label,
      icon: presetIcon(p),
    })),
  },
  {
    title: 'Windows',
    note: '',
    items: WINDOW_PRESETS.map((p) => ({
      item: { type: 'opening', preset: p } as LibraryItem,
      label: p.label,
      icon: presetIcon(p),
    })),
  },
  {
    title: 'Furniture',
    note: 'A tap on the plan puts one of the usual size there.',
    items: (Object.keys(FURNITURE_NAME) as HouseFurnitureKind[]).map((k) => ({
      item: { type: 'furniture', kind: k } as LibraryItem,
      label: FURNITURE_NAME[k],
      icon: FURNITURE_ICON[k],
    })),
  },
  {
    title: 'Devices not on the plan yet',
    note: props.unplaced.length ? '' : 'Every device is on the plan.',
    items: props.unplaced.map((d) => ({
      item: { type: 'device', ref: d.ref } as LibraryItem,
      label: d.name,
      icon: DEVICE_ICON[d.kind],
    })),
  },
])
</script>

<style lang="scss" scoped>
.house-library {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-12);
}

.house-library__title {
  margin: 0 0 var(--nb-spacing-4);
}

.house-library__note {
  margin: 0 0 var(--nb-spacing-8);
  color: var(--nb-c-text-muted);
}

.house-library__items {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-4);
}

// Dragged from, so the page does not scroll or select under the finger.
.house-library__item {
  touch-action: none;
  user-select: none;
}
</style>
