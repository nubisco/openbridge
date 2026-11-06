<template>
  <div :style="{ height: `${height ?? 220}px`, width: '100%', position: 'relative' }">
    <div ref="containerEl" style="height: 100%; width: 100%" />
    <NbSkeleton
      v-if="!ready"
      variant="block"
      width="100%"
      height="100%"
      radius="none"
      label="Loading editor"
      class="monaco-skeleton"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import loader from '@monaco-editor/loader'
import { useTheme } from '@nubisco/ui'

const props = defineProps<{
  modelValue: string
  height?: number
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { resolved } = useTheme()

const containerEl = ref<HTMLElement | null>(null)
const editor = shallowRef<any>(null)
const ready = ref(false)
let suppressEmit = false

onMounted(async () => {
  const monaco = await loader.init()
  if (!containerEl.value) return

  // Monaco ships its own themes rather than reading CSS variables, so the app
  // theme is mapped onto its nearest built-in and re-applied on change.
  watch(resolved, (mode) => monaco.editor.setTheme(mode === 'dark' ? 'vs-dark' : 'vs'))

  editor.value = monaco.editor.create(containerEl.value, {
    value: props.modelValue,
    language: 'json',
    theme: resolved.value === 'dark' ? 'vs-dark' : 'vs',
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

<style lang="scss" scoped>
// The editor's shape while Monaco boots, laid over the box it will fill.
.monaco-skeleton {
  position: absolute;
  inset: 0;
}
</style>
