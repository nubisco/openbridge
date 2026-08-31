<template>
  <div class="config-view">
    <!-- The file being edited reads as page identity, so it sits beside the
         breadcrumb rather than taking a row out of the editor. -->
    <Teleport defer to="#ob-topbar-left">
      <span class="config-path">~/.openbridge/config.json</span>
    </Teleport>

    <Teleport defer to="#ob-topbar-right">
      <NbButton variant="ghost" size="sm" icon="magic-wand" title="Format JSON" @click="format">Format</NbButton>
      <NbButton
        variant="primary"
        size="sm"
        :icon="saved ? 'check' : 'floppy-disk'"
        :loading="saving"
        :disabled="saving"
        title="Changes take effect after restarting the daemon"
        @click="save"
      >
        {{ saved ? 'Saved!' : saving ? 'Saving…' : 'Save' }}
      </NbButton>
    </Teleport>

    <div v-if="error" class="error-banner">
      <NbIcon name="warning" :size="14" />
      {{ error }}
    </div>

    <div v-if="loading" class="loading-state">
      <NbIcon name="spinner" :size="28" />
      <span>Loading config...</span>
    </div>

    <div v-else ref="editorContainer" class="editor-container" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, shallowRef, watch } from 'vue'
import loader from '@monaco-editor/loader'
import { api } from '@/api'
import { useLayoutStore } from '@/stores/layout'
import { useTheme } from '@/composables/useTheme'

const layout = useLayoutStore()
const { resolved } = useTheme()
const editorContainer = ref<HTMLElement | null>(null)
const editor = shallowRef<any>(null)
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const loading = ref(true)

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
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    formatOnPaste: true,
    formatOnType: true,
    tabSize: 2,
    automaticLayout: true,
    wordWrap: 'off',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true },
    lineNumbers: 'on',
    renderLineHighlight: 'all',
    smoothScrolling: true,
  })
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

// Teleported next to the breadcrumb in the shell topbar.
.config-path {
  font-family: monospace;
  font-size: 0.82rem;
  color: var(--nb-c-text-muted);
  background: var(--nb-c-field-bg);
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
}

// A full-width strip now that the view runs edge to edge.
.error-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: color-mix(in srgb, var(--nb-c-danger) 12%, var(--nb-c-surface));
  border-bottom: 1px solid color-mix(in srgb, var(--nb-c-danger) 35%, transparent);
  padding: 0.6rem 0.9rem;
  font-size: 0.82rem;
  color: var(--nb-c-danger);
  flex-shrink: 0;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 4rem;
  color: var(--nb-c-text-subtle);
}

// Edge to edge: an editor should fill its pane, not float in a rounded card.
.editor-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
