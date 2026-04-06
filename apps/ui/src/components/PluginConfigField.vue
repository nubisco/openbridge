<!--
  Renders a single field from a Homebridge config.schema.json schema entry.
  Recursive — nested objects call back into this component.
-->
<script setup lang="ts">
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

<template>
  <!-- Nested object → section with children -->
  <div v-if="resolveType() === 'object' && field.properties" class="pcf-section">
    <div class="pcf-section-label">{{ label() }}</div>
    <div class="pcf-section-body">
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
    </div>
  </div>

  <!-- Boolean → NbSwitch -->
  <div v-else-if="resolveType() === 'boolean'" class="pcf-row pcf-row--switch">
    <div class="pcf-label-wrap">
      <span class="pcf-label">
        {{ label() }}
        <span v-if="required" class="pcf-required">*</span>
      </span>
      <span v-if="field.description" class="pcf-hint">{{ field.description }}</span>
    </div>
    <NbSwitch
      :model-value="Boolean(value ?? field.default ?? false)"
      :name="`pcf-${path.join('-')}`"
      size="sm"
      variant="success"
      @update:model-value="emit('change', $event)"
    />
  </div>

  <!-- Enum → NbSelect -->
  <div v-else-if="field.enum" class="pcf-row">
    <label class="pcf-label">
      {{ label() }}
      <span v-if="required" class="pcf-required">*</span>
    </label>
    <div class="pcf-control">
      <NbSelect
        :model-value="selectValue()"
        :options="selectOptions()"
        size="sm"
        @update:model-value="emit('change', $event)"
      />
      <span v-if="field.description" class="pcf-hint">{{ field.description }}</span>
    </div>
  </div>

  <!-- Array of primitives -->
  <div v-else-if="resolveType() === 'array'" class="pcf-row pcf-row--array">
    <label class="pcf-label">
      {{ label() }}
      <span v-if="required" class="pcf-required">*</span>
    </label>
    <div class="pcf-control">
      <div class="pcf-array">
        <div v-for="(item, idx) in arrayItems()" :key="idx" class="pcf-array-row">
          <NbTextInput
            :model-value="String(item)"
            size="sm"
            :placeholder="`${label()} ${idx + 1}`"
            style="flex: 1"
            @update:model-value="emit('updateArray', path, idx, $event)"
          />
          <NbButton variant="ghost" size="sm" icon="trash" @click="emit('removeArray', path, idx)" />
        </div>
        <NbButton
          variant="ghost"
          size="sm"
          icon="plus"
          @click="emit('addArray', path, field.items ?? { type: 'string' })"
        >
          Add
        </NbButton>
      </div>
      <span v-if="field.description" class="pcf-hint">{{ field.description }}</span>
    </div>
  </div>

  <!-- Number / integer -->
  <div v-else-if="resolveType() === 'number' || resolveType() === 'integer'" class="pcf-row">
    <label class="pcf-label">
      {{ label() }}
      <span v-if="required" class="pcf-required">*</span>
    </label>
    <div class="pcf-control">
      <NbTextInput
        :model-value="value !== undefined ? String(value) : field.default !== undefined ? String(field.default) : ''"
        type="number"
        size="sm"
        :placeholder="field.default !== undefined ? String(field.default) : ''"
        style="max-width: 180px"
        @update:model-value="emit('change', Number($event))"
      />
      <span v-if="field.description" class="pcf-hint">{{ field.description }}</span>
    </div>
  </div>

  <!-- Default: string / text -->
  <div v-else class="pcf-row">
    <label class="pcf-label">
      {{ label() }}
      <span v-if="required" class="pcf-required">*</span>
    </label>
    <div class="pcf-control">
      <NbTextInput
        :model-value="value !== undefined ? String(value) : field.default !== undefined ? String(field.default) : ''"
        size="sm"
        :placeholder="field.default !== undefined ? String(field.default) : ''"
        @update:model-value="emit('change', $event)"
      />
      <span v-if="field.description" class="pcf-hint">{{ field.description }}</span>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.pcf-section {
  border: 1px solid #e8e8f0;
  border-radius: 8px;
  overflow: hidden;
}

.pcf-section-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #9ca3af;
  background: #f9f9fc;
  padding: 0.45rem 0.75rem;
  border-bottom: 1px solid #e8e8f0;
}

.pcf-section-body {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.pcf-row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 0.5rem 0.75rem;
  align-items: start;

  &--switch {
    align-items: center;
    .pcf-label-wrap {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
  }

  &--array {
    align-items: start;
  }
}

.pcf-label {
  font-size: 0.82rem;
  font-weight: 500;
  color: #374151;
  padding-top: 0.3rem;
}

.pcf-label-wrap {
  grid-column: 1;
}

.pcf-required {
  color: #ef4444;
  margin-left: 2px;
}

.pcf-control {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.pcf-hint {
  font-size: 0.71rem;
  color: #9ca3af;
  line-height: 1.4;
}

.pcf-array {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.pcf-array-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
</style>
