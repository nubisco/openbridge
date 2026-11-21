<template>
  <!-- The floors, top to bottom like a lift, floating on the left of the plan.
       The live view and the editor use the same menu. The live view can also
       show every floor at once. The editor adds, renames and deletes floors. -->
  <div
    class="house-floor-menu"
    :class="{ 'is-phone': phone }"
    role="group"
    aria-label="Floors"
    data-nb-appearance="rounded"
  >
    <!-- On a phone only the icon shows, and the label is its accessible name. -->
    <NbButton
      v-if="allowAll && floors.length > 1"
      size="sm"
      :variant="modelValue === 'all' ? 'primary' : 'ghost'"
      icon="stack"
      :aria-pressed="modelValue === 'all'"
      :aria-label="phone ? 'All floors' : undefined"
      @click="emit('update:modelValue', 'all')"
    >
      <template v-if="!phone">All floors</template>
    </NbButton>
    <NbButton
      v-for="f in topDown"
      :key="f.id"
      size="sm"
      :variant="modelValue === f.id ? 'primary' : 'ghost'"
      :aria-pressed="modelValue === f.id"
      :title="f.name"
      @click="emit('update:modelValue', f.id)"
    >
      {{ phone ? shortName(f) : f.name }}
    </NbButton>
    <div v-if="editable" class="house-floor-menu__actions">
      <NbButton
        v-nb-tooltip="{ body: 'Add a floor on top', position: phone ? 'top' : 'right', aria: 'none' }"
        size="sm"
        variant="ghost"
        icon="plus"
        aria-label="Add a floor on top"
        @click="emit('add')"
      />
      <NbActionGroup
        v-if="current"
        :items="actions"
        overflow="always"
        :phone-visible="0"
        :overflow-label="`More actions for ${current.name}`"
        @select="onAction"
      />
    </div>

    <NbModal close-appearance="button" :open="renaming" title="Rename floor" size="sm" @close="renaming = false">
      <NbForm id="house-floor-rename" @submit.prevent="rename">
        <NbTextInput id="house-floor-name" v-model="name" label="Floor name" :maxlength="80" />
      </NbForm>
      <template #footer>
        <NbButton type="button" variant="secondary" @click="renaming = false">Cancel</NbButton>
        <NbButton type="submit" form="house-floor-rename" variant="primary" :disabled="!name.trim()">Rename</NbButton>
      </template>
    </NbModal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import * as iconPencil from '@nubisco/ui/icons/pencil-simple'
import * as iconTrash from '@nubisco/ui/icons/trash'
import type { HouseFloor } from '@/api'

const props = withDefaults(
  defineProps<{
    floors: HouseFloor[]
    /** A floor id, or `all` when every floor is shown. */
    modelValue: string
    phone?: boolean
    /** Offer "All floors" (the live view). */
    allowAll?: boolean
    /** Offer adding, renaming and deleting floors (the editor). */
    editable?: boolean
  }>(),
  { phone: false, allowAll: false, editable: false },
)

const emit = defineEmits<{
  'update:modelValue': [id: string]
  add: []
  rename: [id: string, name: string]
  delete: [id: string]
}>()

const topDown = computed(() => props.floors.slice().sort((a, b) => b.level - a.level))
const current = computed(() => props.floors.find((f) => f.id === props.modelValue) ?? null)

/** G for the ground floor, B1 for the first basement, 1 for the first floor up. */
const shortName = (f: HouseFloor) => (f.level === 0 ? 'G' : f.level < 0 ? `B${-f.level}` : String(f.level))

const actions = computed(() => [
  { id: 'rename', label: 'Rename floor', icon: iconPencil },
  {
    id: 'delete',
    label: 'Delete floor',
    icon: iconTrash,
    danger: true,
    // A house keeps at least one floor.
    disabled: props.floors.length < 2,
  },
])

const renaming = ref(false)
const name = ref('')

function onAction(id: string) {
  const f = current.value
  if (!f) return
  if (id === 'rename') {
    name.value = f.name
    renaming.value = true
  } else if (id === 'delete') emit('delete', f.id)
}

function rename() {
  const f = current.value
  const n = name.value.trim()
  if (f && n) emit('rename', f.id, n)
  renaming.value = false
}
</script>

<style lang="scss" scoped>
.house-floor-menu {
  position: absolute;
  z-index: 1;
  left: var(--nb-spacing-8);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--nb-spacing-4);
  // Concentric with the pill buttons inside: the panel's corner is the
  // button's (half its height) plus the inset that holds it off the edge.
  padding: var(--nb-overlay-inset, var(--nb-spacing-4));
  border-radius: calc(var(--nb-field-height-sm) / 2 + var(--nb-overlay-inset, var(--nb-spacing-4)));
  // A page surface floating on the stage, in the page's theme, so the
  // library's buttons read as they do everywhere else in light and dark.
  background: var(--nb-c-layer-1);
  border: 1px solid var(--nb-c-border);

  &.is-phone {
    top: auto;
    bottom: var(--nb-spacing-8);
    transform: none;
    flex-direction: row;
  }
}

// Adding and the selected floor's actions, under the floors, set apart by a line.
.house-floor-menu__actions {
  display: flex;
  justify-content: center;
  gap: var(--nb-spacing-4);
  padding-top: var(--nb-spacing-4);
  border-top: 1px solid var(--nb-c-border);

  .is-phone & {
    padding-top: 0;
    padding-left: var(--nb-spacing-4);
    border-top: none;
    border-left: 1px solid var(--nb-c-border);
  }
}
</style>
