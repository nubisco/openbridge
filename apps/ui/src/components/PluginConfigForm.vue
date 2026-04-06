<!--
  Visual form editor generated from a plugin's config.schema.json.
  Handles: string, number, integer, boolean, enum, nested object, array of strings.
-->
<script setup lang="ts">
import { computed } from 'vue'

interface SchemaField {
  type?: string | string[]
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  enumNames?: string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  properties?: Record<string, SchemaField>
  required?: string[]
  items?: SchemaField
  oneOf?: SchemaField[]
  anyOf?: SchemaField[]
  'x-schema-form'?: { type?: string; placeholder?: string }
}

interface HbSchema {
  pluginAlias?: string
  pluginType?: string
  schema?: SchemaField
}

const props = defineProps<{
  hbSchema: HbSchema
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{
  'update:modelValue': [val: Record<string, unknown>]
}>()

function set(path: string[], value: unknown) {
  const copy = JSON.parse(JSON.stringify(props.modelValue))
  let obj: any = copy
  for (let i = 0; i < path.length - 1; i++) {
    if (obj[path[i]] === undefined || typeof obj[path[i]] !== 'object') obj[path[i]] = {}
    obj = obj[path[i]]
  }
  obj[path[path.length - 1]] = value
  emit('update:modelValue', copy)
}

function get(path: string[]): unknown {
  let obj: any = props.modelValue
  for (const key of path) {
    if (obj == null || typeof obj !== 'object') return undefined
    obj = obj[key]
  }
  return obj
}

function resolveType(field: SchemaField): string {
  const t = Array.isArray(field.type) ? field.type[0] : (field.type ?? 'string')
  return t
}

// Add/remove item in array field
function addArrayItem(path: string[], items: SchemaField) {
  const arr = (get(path) as unknown[] | undefined) ?? []
  const def = items.default ?? (resolveType(items) === 'string' ? '' : resolveType(items) === 'number' ? 0 : '')
  set(path, [...arr, def])
}

function removeArrayItem(path: string[], index: number) {
  const arr = [...((get(path) as unknown[] | undefined) ?? [])]
  arr.splice(index, 1)
  set(path, arr)
}

function updateArrayItem(path: string[], index: number, value: unknown) {
  const arr = [...((get(path) as unknown[] | undefined) ?? [])]
  arr[index] = value
  set(path, arr)
}

const rootSchema = computed(() => props.hbSchema.schema ?? { type: 'object', properties: {} })
</script>

<template>
  <div class="pcf-root">
    <template v-if="rootSchema.properties">
      <PluginConfigField
        v-for="(field, key) in rootSchema.properties"
        :key="key"
        :field-key="String(key)"
        :field="field"
        :path="[String(key)]"
        :required="rootSchema.required?.includes(String(key)) ?? false"
        :value="get([String(key)])"
        @change="(v: unknown) => set([String(key)], v)"
        @add-array="(p: string[], items: SchemaField) => addArrayItem(p, items)"
        @remove-array="(p: string[], i: number) => removeArrayItem(p, i)"
        @update-array="(p: string[], i: number, v: unknown) => updateArrayItem(p, i, v)"
      />
    </template>
    <div v-else class="pcf-no-schema">No configurable fields found in schema.</div>
  </div>
</template>

<style lang="scss" scoped>
.pcf-root {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.pcf-no-schema {
  font-size: 0.8rem;
  color: #9ca3af;
}
</style>
