<template>
  <NbModal
    close-appearance="button"
    :open="open"
    title="New token"
    size="sm"
    :close-on-overlay="!name"
    @close="emit('close')"
  >
    <NbForm id="new-token-form" @submit.prevent="submit">
      <NbBanner v-if="serverError" status="error" variant="inline" :title="serverError" />
      <NbTextInput
        id="new-token-name"
        ref="nameInput"
        v-model="name"
        label="Name"
        placeholder="Claude on my laptop"
        :error="nameError"
        @blur="validateName"
      />
      <!-- Read-only is the default: most of what an agent is asked here is
           a question about the house, and answering it moves nothing. -->
      <NbSelect
        id="new-token-access"
        v-model="access"
        label="Access"
        :options="[
          { label: 'Read only: devices, history, events and logs', value: 'read' },
          { label: 'Read and control: can also operate devices', value: 'control' },
        ]"
      />
    </NbForm>
    <template #footer>
      <NbButton type="button" variant="secondary" @click="emit('close')">Cancel</NbButton>
      <NbButton type="submit" form="new-token-form" variant="primary" :loading="saving">Create token</NbButton>
    </template>
  </NbModal>
</template>

<script setup lang="ts">
/**
 * Creates a token for the MCP endpoint, after Tally's
 * (tally/apps/web/src/components/NewTokenModal.vue). The secret is handed to
 * the parent once and never fetched again.
 */
import { ref, watch } from 'vue'
import type { NbTextInput } from '@nubisco/ui'
import { api } from '@/api'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [token: string] }>()

const name = ref('')
const access = ref<'read' | 'control'>('read')
const saving = ref(false)
const serverError = ref('')
const nameError = ref<string | undefined>()
const nameInput = ref<InstanceType<typeof NbTextInput> | null>(null)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = ''
    access.value = 'read'
    serverError.value = ''
    nameError.value = undefined
    requestAnimationFrame(() => nameInput.value?.focus())
  },
)

function validateName() {
  nameError.value = name.value.trim() ? undefined : 'Give the token a name you will recognise later'
}

async function submit() {
  validateName()
  if (nameError.value) return
  saving.value = true
  serverError.value = ''
  try {
    const { token } = await api.access.createToken(name.value.trim(), access.value)
    emit('created', token)
  } catch (e) {
    serverError.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
</script>
