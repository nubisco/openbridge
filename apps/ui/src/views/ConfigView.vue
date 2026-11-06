<template>
  <div class="config-view">
    <!-- The file being edited reads as page identity, so it sits beside the
         breadcrumb rather than taking a row out of the editor. -->
    <component :is="topbarLeft.Outlet">
      <span class="config-path">~/.openbridge/config.json</span>
    </component>

    <!-- On a phone the actions fold: Save stays as an icon and Format moves
         into the overflow menu, so the path beside the breadcrumb keeps its room. -->
    <component :is="topbarRight.Outlet">
      <NbActionGroup :items="actions" size="sm" overflow="phone" />
    </component>

    <NbBanner v-if="error" status="error" :title="error" flush />

    <NbSpinner v-if="loading" size="lg" label="Loading config" show-label class="loading-state" />

    <div v-else ref="editorContainer" class="editor-container" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, shallowRef, watch } from 'vue'
import loader from '@monaco-editor/loader'
import { api } from '@/api'
import { useLayoutStore } from '@/stores/layout'
import { useTheme, usePhoneLayout, type IActionGroupItem, useShellSlot } from '@nubisco/ui'
import * as iconMagicWand from '@nubisco/ui/icons/magic-wand'
import * as iconFloppyDisk from '@nubisco/ui/icons/floppy-disk'
import * as iconCheck from '@nubisco/ui/icons/check'
// Controls this view puts in the shell topbar.
const topbarLeft = useShellSlot('topbar-left')
const topbarRight = useShellSlot('topbar-right')

const layout = useLayoutStore()
const { resolved } = useTheme()
const editorContainer = ref<HTMLElement | null>(null)
const editor = shallowRef<any>(null)
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const loading = ref(true)
const { phone } = usePhoneLayout()

const actions = computed<IActionGroupItem[]>(() => [
  { id: 'format', label: 'Format', icon: iconMagicWand, variant: 'ghost', onSelect: format },
  {
    id: 'save',
    label: saved.value ? 'Saved!' : saving.value ? 'Saving…' : 'Save',
    icon: saved.value ? iconCheck : iconFloppyDisk,
    variant: 'primary',
    priority: 'primary',
    loading: saving.value,
    onSelect: save,
  },
])

// A phone has no room for the minimap, and a line running off a 390px screen
// can only be read by scrolling sideways, so it wraps there instead.
const phoneEditorOptions = (isPhone: boolean) => ({
  minimap: { enabled: !isPhone },
  wordWrap: isPhone ? ('on' as const) : ('off' as const),
})

onMounted(async () => {
  layout.setPage('Config', undefined, { fullBleed: true })

  // Load the config content
  let content = '{}'
  try {
    const res = await api.config.get()
    content = res.content
  } catch (e) {
    error.value = `Failed to load config: ${e}`
  } finally {
    loading.value = false
  }

  // Boot Monaco
  const monaco = await loader.init()

  // Register the OpenBridge JSON schema
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    schemas: [
      {
        uri: 'openbridge://config-schema',
        fileMatch: ['*'],
        schema: {
          type: 'object',
          properties: {
            bridge: {
              type: 'object',
              description: 'Bridge configuration',
              properties: {
                name: { type: 'string', description: 'Bridge display name' },
                port: { type: 'number', description: 'HTTP API port (default 8582)' },
                hapPort: { type: 'number', description: 'HomeKit HAP port (default 51829)' },
                pincode: { type: 'string', description: 'HomeKit pairing PIN (format: XXX-XX-XXX)' },
                username: { type: 'string', description: 'HAP username (MAC address format)' },
                logLevel: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
              },
            },
            platforms: {
              type: 'array',
              description: 'Homebridge-compatible platform plugins',
              items: {
                type: 'object',
                required: ['platform'],
                properties: {
                  platform: { type: 'string', description: 'Platform identifier' },
                  plugin: { type: 'string', description: 'Absolute path to the plugin JS file' },
                  enabled: { type: 'boolean', default: true },
                },
                additionalProperties: true,
              },
            },
            plugins: {
              type: 'array',
              description: 'Native OpenBridge plugins',
              items: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  path: { type: 'string' },
                  enabled: { type: 'boolean', default: true },
                  config: { type: 'object' },
                },
              },
            },
          },
        },
      },
    ],
  })

  if (!editorContainer.value) return

  // Monaco ships its own themes rather than reading CSS variables, so the app
  // theme is mapped onto its nearest built-in and re-applied on change.
  watch(resolved, (mode) => monaco.editor.setTheme(mode === 'dark' ? 'vs-dark' : 'vs'))

  editor.value = monaco.editor.create(editorContainer.value, {
    value: content,
    language: 'json',
    theme: resolved.value === 'dark' ? 'vs-dark' : 'vs',
    fontSize: 13,
    fontFamily: '"MesloLGS NF", monospace',
    ...phoneEditorOptions(phone.value),
    scrollBeyondLastLine: false,
    formatOnPaste: true,
    formatOnType: true,
    tabSize: 2,
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true },
    lineNumbers: 'on',
    renderLineHighlight: 'all',
    smoothScrolling: true,
  })
  watch(phone, (isPhone) => editor.value?.updateOptions(phoneEditorOptions(isPhone)))
})

onBeforeUnmount(() => {
  editor.value?.dispose()
})

async function save() {
  if (saving.value) return
  saving.value = true
  error.value = null
  saved.value = false
  try {
    const content = editor.value?.getValue() ?? ''
    await api.config.save(content)
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2500)
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

function format() {
  editor.value?.getAction('editor.action.formatDocument')?.run()
}
</script>

<style lang="scss" scoped>
.config-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

// Contributed beside the breadcrumb in the shell topbar. A path is code, so it
// takes the mono set rather than a size of its own.
.config-path {
  font-family: var(--nb-type-code-sm-family);
  font-size: var(--nb-type-code-sm-size);
  font-weight: var(--nb-type-code-sm-weight);
  line-height: var(--nb-type-code-sm-line-height);
  letter-spacing: var(--nb-type-code-sm-letter-spacing);
  color: var(--nb-c-text-muted);
  background: var(--nb-c-field-bg);
  padding: var(--nb-spacing-4) var(--nb-spacing-8);
  border-radius: var(--nb-radius-control-sm);

  // The topbar is the width of the screen on a phone: the path gives way first.
  @include variables.phone {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.loading-state {
  padding: var(--nb-spacing-48);
  justify-content: center;
}

// Edge to edge: an editor should fill its pane, not float in a rounded card.
.editor-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
