<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import loader from '@monaco-editor/loader'
import { api } from '@/api'
import { useLayoutStore } from '@/stores/layout'

const layout = useLayoutStore()
const editorContainer = ref<HTMLElement | null>(null)
const editor = shallowRef<any>(null)
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const loading = ref(true)

onMounted(async () => {
  layout.setPage('Config')

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
                port: { type: 'number', description: 'HTTP API port (default 8581)' },
                hapPort: { type: 'number', description: 'HomeKit HAP port (default 51826)' },
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

  editor.value = monaco.editor.create(editorContainer.value, {
    value: content,
    language: 'json',
    theme: 'vs-dark',
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

<template>
  <div class="config-view">
    <div class="config-toolbar">
      <div class="toolbar-left">
        <span class="config-path">~/.openbridge/config.json</span>
      </div>
      <div class="toolbar-right">
        <button class="btn-format" title="Format JSON" @click="format">
          <NbIcon name="magic-wand" :size="14" />
          Format
        </button>
        <button class="btn-save" :class="{ saving, saved }" :disabled="saving" @click="save">
          <NbIcon :name="saved ? 'check' : saving ? 'spinner' : 'floppy-disk'" :size="14" />
          {{ saved ? 'Saved!' : saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error-banner">
      <NbIcon name="warning" :size="14" />
      {{ error }}
    </div>

    <div v-if="loading" class="loading-state">
      <NbIcon name="spinner" :size="28" />
      <span>Loading config...</span>
    </div>

    <div v-else ref="editorContainer" class="editor-container" />

    <div class="config-footer">
      <NbIcon name="info" :size="12" />
      Changes take effect after restarting the daemon
    </div>
  </div>
</template>

<style lang="scss" scoped>
.config-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 0.75rem;
}

.config-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
}
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.config-path {
  font-family: monospace;
  font-size: 0.82rem;
  color: #6b7280;
  background: #f3f4f6;
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
}

%btn {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.4rem 0.85rem;
  border-radius: 7px;
  border: none;
  cursor: pointer;
  transition:
    background 0.15s,
    opacity 0.15s;
  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
}

.btn-format {
  @extend %btn;
  background: #f3f4f6;
  color: #374151;
  &:hover:not(:disabled) {
    background: #e5e7eb;
  }
}

.btn-save {
  @extend %btn;
  background: #7c3aed;
  color: #fff;
  &:hover:not(:disabled) {
    background: #6d28d9;
  }
  &.saving {
    background: #8b5cf6;
  }
  &.saved {
    background: #059669;
  }
}

.error-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 0.6rem 0.9rem;
  font-size: 0.82rem;
  color: #dc2626;
  flex-shrink: 0;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 4rem;
  color: #9ca3af;
}

.editor-container {
  flex: 1;
  min-height: 0;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #374151;
}

.config-footer {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.74rem;
  color: #9ca3af;
  flex-shrink: 0;
}
</style>
