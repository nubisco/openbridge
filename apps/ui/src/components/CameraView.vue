<template>
  <!-- A camera's picture, in OpenBridge itself. Live when the camera can
       stream, as Motion JPEG an <img> plays as it arrives. The stream runs
       only while this is on screen: unmounting drops the connection, and the
       bridge stops the camera's process. -->
  <figure class="camera-view">
    <img
      v-show="loaded"
      :key="src"
      class="camera-view__img"
      :src="src"
      :alt="`${name}, ${showing === 'live' ? 'live' : 'latest picture'}`"
      @load="loaded = true"
      @error="onError"
    />
    <div v-if="!loaded" class="camera-view__wait type-body-sm">
      {{ failed ? 'The camera did not send a picture.' : 'Connecting to the camera...' }}
    </div>
    <figcaption class="camera-view__caption type-body-sm">
      <span v-if="showing === 'live'" class="camera-view__live">Live</span>
      <span v-else>Picture every few seconds</span>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  deviceId: string
  name: string
  /** What the device offers. */
  video: 'snapshot' | 'live'
}>()

/** Live first. A stream that fails or is full falls back to snapshots. */
const showing = ref<'live' | 'snapshot'>(props.video)
const tick = ref(Date.now())
const loaded = ref(false)
const failed = ref(false)

const base = computed(() => `/api/devices/${encodeURIComponent(props.deviceId)}`)
const src = computed(() => (showing.value === 'live' ? `${base.value}/live` : `${base.value}/snapshot?t=${tick.value}`))

function onError() {
  if (showing.value === 'live') {
    showing.value = 'snapshot'
    return
  }
  if (!loaded.value) failed.value = true
}

// Snapshots refresh while shown. The previous picture stays up until the next
// arrives, so it never flashes empty.
let timer: ReturnType<typeof setInterval> | null = null
watch(
  showing,
  (mode) => {
    if (timer) clearInterval(timer)
    timer = mode === 'snapshot' ? setInterval(() => (tick.value = Date.now()), 3000) : null
  },
  { immediate: true },
)
watch(
  () => props.deviceId,
  () => {
    showing.value = props.video
    loaded.value = false
    failed.value = false
  },
)
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style lang="scss" scoped>
.camera-view {
  margin: 0 0 var(--nb-spacing-12);
}

.camera-view__img,
.camera-view__wait {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--nb-radius-md);
  background: #0d1117;
}

.camera-view__wait {
  display: grid;
  place-items: center;
  color: #c9d1d9;
}

.camera-view__caption {
  margin-top: var(--nb-spacing-4);
  color: var(--nb-c-text-muted);
}

.camera-view__live::before {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: #e5484d;
  vertical-align: 1px;
}
</style>
