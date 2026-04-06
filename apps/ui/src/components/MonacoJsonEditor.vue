<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import loader from '@monaco-editor/loader'

const props = defineProps<{
  modelValue: string
  height?: number
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const containerEl = ref<HTMLElement | null>(null)
const editor = shallowRef<any>(null)
const ready = ref(false)
let suppressEmit = false

onMounted(async () => {
  const monaco = await loader.init()
  if (!containerEl.value) return

  editor.value = monaco.editor.create(containerEl.value, {
    value: props.modelValue,
    language: 'json',
    theme: 'vs-dark',
    fontSize: 12,
    fontFamily: '"MesloLGS NF", monospace',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'off',
    wordWrap: 'on',
    automaticLayout: true,
    tabSize: 2,
    folding: false,
    renderLineHighlight: 'none',
    overviewRulerLanes: 0,
    scrollbar: { verticalScrollbarSize: 6 },
  })

  editor.value.onDidChangeModelContent(() => {
    if (!suppressEmit) {
      emit('update:modelValue', editor.value.getValue())
    }
  })

  ready.value = true
})

onBeforeUnmount(() => {
  editor.value?.dispose()
})

// Sync external value changes (e.g. plugin switch) into the editor
watch(
  () => props.modelValue,
  (newVal) => {
    if (!editor.value) return
    const current = editor.value.getValue()
    if (current !== newVal) {
      suppressEmit = true
      editor.value.setValue(newVal)
      suppressEmit = false
    }
  },
)
</script>

<template>
  <div :style="{ height: `${height ?? 220}px`, width: '100%', position: 'relative' }">
    <div ref="containerEl" style="height: 100%; width: 100%" />
    <div v-if="!ready" class="monaco-skeleton" />
  </div>
</template>

<style scoped>
.monaco-skeleton {
  position: absolute;
  inset: 0;
  background: #1e1e1e;
  border-radius: inherit;
  display: flex;
  align-items: center;
  justify-content: center;
}
.monaco-skeleton::after {
  content: '';
  width: 40px;
  height: 40px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: rgba(255, 255, 255, 0.4);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
