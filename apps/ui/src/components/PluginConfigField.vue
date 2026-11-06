<!--
  Renders a single field from a Homebridge config.schema.json schema entry.
  Recursive: nested objects call back into this component.

  Every row is an NbField, so the labels share the inspector's spine and every
  control sits on one edge. Fields are xs, the inspector's density, stated here
  once for the whole form.
-->
<template>
  <!-- Nested object → a group with its own title, children indented under it -->
  <fieldset v-if="resolveType() === 'object' && field.properties" class="pcf-section">
    <legend class="pcf-section-label type-heading-compact">{{ label() }}</legend>
    <PluginConfigField
      v-for="(childField, childKey) in field.properties"
      :key="childKey"
      :field-key="String(childKey)"
      :field="childField"
      :path="[...path, String(childKey)]"
      :required="field.required?.includes(String(childKey)) ?? false"
      :value="nestedValue(String(childKey))"
      @change="(v) => nestedChange(String(childKey), v)"
      @add-array="(p, items) => emit('addArray', p, items)"
      @remove-array="(p, i) => emit('removeArray', p, i)"
      @update-array="(p, i, v) => emit('updateArray', p, i, v)"
    />
  </fieldset>

  <!-- Boolean → NbSwitch -->
  <!-- NbSwitch builds its own input id, so it cannot take the field's: the
       switch is named directly instead. -->
  <NbField
    v-else-if="resolveType() === 'boolean'"
    control="fit"
    :label-for="`${controlId}-input`"
    :hint="field.description"
  >
    <template #label>
      <label class="pcf-label type-label" :for="`${controlId}-input`">
        {{ label() }}
        <span v-if="required" class="pcf-required" aria-hidden="true">*</span>
      </label>
    </template>
    <!-- NbSwitch only accepts primary|secondary; the previous "success"
         was silently ignored, in 3.3.0 too. -->
    <NbSwitch
      :id="controlId"
      :model-value="Boolean(value ?? field.default ?? false)"
      :name="controlId"
      variant="primary"
      @update:model-value="emit('change', $event)"
    />
  </NbField>

  <!-- Enum → NbSelect -->
  <NbField v-else-if="field.enum" :label-for="controlId" :hint="field.description">
    <template #label>
      <label class="pcf-label type-label" :for="controlId">
        {{ label() }}
        <span v-if="required" class="pcf-required" aria-hidden="true">*</span>
      </label>
    </template>
    <NbSelect
      :id="controlId"
      :model-value="selectValue()"
      :options="selectOptions()"
      size="xs"
      @update:model-value="emit('change', $event)"
    />
  </NbField>

  <!-- Array of primitives -->
  <NbField v-else-if="resolveType() === 'array'" align="start" :hint="field.description">
    <template #label>
      <span class="pcf-label pcf-label--array type-label">
        {{ label() }}
        <span v-if="required" class="pcf-required" aria-hidden="true">*</span>
      </span>
    </template>
    <div class="pcf-array">
      <div v-for="(item, idx) in arrayItems()" :key="idx" class="pcf-array-row">
        <NbTextInput
          class="pcf-array-input"
          :model-value="String(item)"
          size="xs"
          :placeholder="`${label()} ${idx + 1}`"
          :aria-label="`${label()} ${idx + 1}`"
          @update:model-value="emit('updateArray', path, idx, $event)"
        />
        <NbButton
          v-nb-tooltip="{ body: `Remove ${label()} ${idx + 1}` }"
          variant="ghost"
          size="sm"
          icon="trash"
          :aria-label="`Remove ${label()} ${idx + 1}`"
          @click="emit('removeArray', path, idx)"
        />
      </div>
      <NbButton
        class="pcf-array-add"
        variant="tertiary"
        size="sm"
        icon="plus"
        @click="emit('addArray', path, field.items ?? { type: 'string' })"
      >
        Add
      </NbButton>
    </div>
  </NbField>

  <!-- Number / integer -->
  <NbField
    v-else-if="resolveType() === 'number' || resolveType() === 'integer'"
    :label-for="controlId"
    :hint="field.description"
  >
    <template #label>
      <label class="pcf-label type-label" :for="controlId">
        {{ label() }}
        <span v-if="required" class="pcf-required" aria-hidden="true">*</span>
      </label>
    </template>
    <template #default="{ describedby }">
      <NbTextInput
        :id="controlId"
        :model-value="value !== undefined ? String(value) : field.default !== undefined ? String(field.default) : ''"
        type="number"
        size="xs"
        :placeholder="field.default !== undefined ? String(field.default) : ''"
        :aria-describedby="describedby"
        @update:model-value="emit('change', Number($event))"
      />
    </template>
  </NbField>

  <!-- Default: string / text -->
  <NbField v-else :label-for="controlId" :hint="field.description">
    <template #label>
      <label class="pcf-label type-label" :for="controlId">
        {{ label() }}
        <span v-if="required" class="pcf-required" aria-hidden="true">*</span>
      </label>
    </template>
    <template #default="{ describedby }">
      <NbTextInput
        :id="controlId"
        :model-value="value !== undefined ? String(value) : field.default !== undefined ? String(field.default) : ''"
        size="xs"
        :placeholder="field.default !== undefined ? String(field.default) : ''"
        :aria-describedby="describedby"
        @update:model-value="emit('change', $event)"
      />
    </template>
  </NbField>
</template>

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
  properties?: Record<string, SchemaField>
  required?: string[]
  items?: SchemaField
  oneOf?: SchemaField[]
  anyOf?: SchemaField[]
}

const props = defineProps<{
  fieldKey: string
  field: SchemaField
  path: string[]
  required: boolean
  value: unknown
}>()

const emit = defineEmits<{
  change: [value: unknown]
  addArray: [path: string[], items: SchemaField]
  removeArray: [path: string[], index: number]
  updateArray: [path: string[], index: number, value: unknown]
}>()

// One id per field, from its path, so the label points at its control. The
// switch's name was already this, so a boolean keeps the name it had.
const controlId = computed(() => `pcf-${props.path.join('-')}`)

function resolveType(): string {
  const t = Array.isArray(props.field.type) ? props.field.type[0] : (props.field.type ?? 'string')
  return t
}

function label(): string {
  return props.field.title ?? props.fieldKey.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())
}

function selectOptions() {
  return (props.field.enum ?? []).map((v, i) => ({
    value: v as string,
    label: props.field.enumNames?.[i] ?? String(v),
  }))
}

function selectValue(): string {
  return (props.value ?? props.field.default ?? '') as string
}

function nestedValue(key: string): unknown {
  const v = props.value as Record<string, unknown> | undefined
  return v?.[key]
}

function nestedChange(key: string, val: unknown) {
  const copy =
    typeof props.value === 'object' && props.value !== null ? { ...(props.value as Record<string, unknown>) } : {}
  copy[key] = val
  emit('change', copy)
}

function arrayItems(): unknown[] {
  return Array.isArray(props.value) ? (props.value as unknown[]) : []
}
</script>

<style lang="scss" scoped>
// A nested object: its title, then its fields indented under a hairline so the
// nesting reads at a glance. The same rhythm as the panel the form sits in.
.pcf-section {
  margin: 0;
  min-width: 0;
  border: 0;
  border-left: 1px solid var(--nb-c-border);
  padding: 0 0 0 var(--nb-spacing-12);
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-8);
}

.pcf-section-label {
  padding: 0;
  margin-bottom: var(--nb-spacing-8);
  color: var(--nb-c-text);
}

// NbField's own label is not used, because it has no way to mark a field
// required. This matches it: muted, one line, ellipsized.
.pcf-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--nb-c-text-muted);
}

// Top-aligned against a list of inputs, so it sits level with the first one.
.pcf-label--array {
  padding-top: var(--nb-spacing-4);
}

.pcf-required {
  color: var(--nb-c-danger);
  margin-left: var(--nb-spacing-2);
}

.pcf-array {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--nb-spacing-8);
}

.pcf-array-row {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-4);
  align-self: stretch;
}

.pcf-array-input {
  flex: 1;
  min-width: 0;
}
</style>
