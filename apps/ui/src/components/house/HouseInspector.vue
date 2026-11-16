<template>
  <!-- The House page's inspector: the device picked on the plan, with its
       controls. It reads the same live state the plan draws, from the house
       store, so the two never disagree. -->
  <div class="house-inspector nb-inspector">
    <HouseDevicePanel :device="device" :where="where" @changed="house.poll()" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useHouseStore } from '@/stores/house'
import { useInspectorStore } from '@/stores/inspector'
import { placementRoom } from '@/house/geometry'
import HouseDevicePanel from './HouseDevicePanel.vue'

const house = useHouseStore()
const inspector = useInspectorStore()

const device = computed(() => (inspector.houseRef ? (house.byRef.get(inspector.houseRef) ?? null) : null))

/** "Kitchen, Ground floor", read from the plan as it is now. */
const where = computed(() => {
  const at = placementRoom(house.plan, inspector.houseRef ?? '')
  if (!at) return 'Not on the plan'
  return at.room ? `${at.room.name}, ${at.floor.name}` : at.floor.name
})
</script>

<style lang="scss" scoped>
.house-inspector {
  padding: var(--nb-spacing-8);
}
</style>
