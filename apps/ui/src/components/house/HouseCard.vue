<template>
  <!-- A small live copy of the House page for the dashboard. The whole card
       is one link to the full plan: the picture is for glancing, the House
       page is for acting. -->
  <NbPanel v-if="house.hasPlan && house.plan" flat title="House">
    <RouterLink to="/house" class="house-card" :aria-label="`Open the house plan. ${summary}`">
      <HouseStage
        :plan="house.plan"
        :devices="house.byRef"
        floor="all"
        mode="iso"
        walls="low"
        overlay="none"
        :labels="false"
        :selected="null"
        preview
      />
      <span class="house-card__summary type-body-sm">{{ summary }}</span>
    </RouterLink>
  </NbPanel>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useHouseStore } from '@/stores/house'
import HouseStage from './HouseStage.vue'
import '@/house/house.scss'

const house = useHouseStore()

/** "2 floors, 11 devices, 3 lights on", from what is on the plan. */
const summary = computed(() => {
  const plan = house.plan
  if (!plan) return ''
  const placed = plan.floors.flatMap((f) => f.placements.map((p) => house.byRef.get(p.ref))).filter((d) => !!d)
  const lights = placed.filter((d) => d!.kind === 'light' && d!.on && d!.reachable).length
  const parts = [
    `${plan.floors.length} floor${plan.floors.length === 1 ? '' : 's'}`,
    `${placed.length} device${placed.length === 1 ? '' : 's'}`,
  ]
  if (lights) parts.push(`${lights} light${lights === 1 ? '' : 's'} on`)
  return parts.join(', ')
})

// Polled like the House page, a little slower: a card is for glancing.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await Promise.all([house.load().catch(() => undefined), house.poll()])
  timer = setInterval(() => house.poll(), 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style lang="scss" scoped>
.house-card {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-8);
  color: inherit;
  text-decoration: none;
  border-radius: var(--nb-radius-control);

  &:hover .house-card__summary {
    color: var(--nb-c-text);
  }

  &:focus-visible {
    outline: 2px solid var(--nb-c-primary);
    outline-offset: 2px;
  }
}

.house-card__summary {
  color: var(--nb-c-text-muted);
}
</style>
