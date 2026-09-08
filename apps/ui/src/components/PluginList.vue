<template>
  <!-- ═══ Cards ═══ -->
  <!-- Plain CSS grid rather than NbGrid: NbGrid's `grid` prop is a 16-column
       span applied to the element itself, not a container column count, so it
       cannot express "fit as many ~260px cards per row as will go". NbPanel
       still supplies every card's surface, which is the part worth reusing. -->
  <div v-if="view === 'cards'" class="plugin-cards">
    <NbPanel
      v-for="row in rows"
      :key="row.plugin.id"
      class="plugin-card"
      :class="{ 'plugin-card--selected': row.plugin.id === selectedId }"
      @click="emit('select', row.plugin)"
    >
      <span class="plugin-card__accent" :class="`plugin-card__accent--${row.plugin.status}`" />

      <NbGrid dir="row" align="start" gap="sm" class="plugin-card__header">
        <div class="plugin-avatar">
          <img
            v-if="row.avatarUrl"
            :src="row.avatarUrl"
            :alt="row.plugin.manifest.name"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
          <NbIcon v-else :name="row.isOpenBridge ? 'diamond' : 'puzzle-piece'" :size="20" />
        </div>

        <div class="plugin-meta">
          <div class="plugin-name">{{ row.plugin.manifest.name }}</div>
          <div v-if="row.plugin.source === 'homebridge' && row.plugin.platformName" class="plugin-platform">
            Platform: {{ row.plugin.platformName }}
          </div>
          <div class="plugin-version">
            v{{ row.plugin.manifest.version }}
            <NbBadge v-if="row.plugin.availableUpdate" variant="blue" size="sm">
              v{{ row.plugin.availableUpdate }} available
            </NbBadge>
          </div>
        </div>

        <NbBadge :variant="statusVariant(row.plugin.status)">{{ row.plugin.status }}</NbBadge>
      </NbGrid>

      <p v-if="row.plugin.manifest.description" class="plugin-desc">{{ row.plugin.manifest.description }}</p>
      <p v-if="row.plugin.manifest.author" class="plugin-author">by {{ row.plugin.manifest.author }}</p>

      <div v-if="row.sponsorUrl || row.docsUrl" class="plugin-links">
        <a v-if="row.sponsorUrl" :href="row.sponsorUrl" target="_blank" rel="noopener" @click.stop>
          <NbIcon name="heart" weight="fill" :size="11" />
          Sponsor
        </a>
        <a v-if="row.docsUrl" :href="row.docsUrl" target="_blank" rel="noopener" @click.stop>
          <NbIcon name="book-open" :size="11" />
          Docs
        </a>
      </div>

      <div v-if="row.plugin.error" class="plugin-error">{{ row.plugin.error }}</div>
    </NbPanel>
  </div>

  <!-- ═══ Table ═══ -->
  <NbDataTable
    v-else
    :columns="columns"
    :rows="tableRows"
    row-key="id"
    size="sm"
    zebra
    :sort-state="sortState"
    @sort="sortState = $event"
    @row-click="(row: TableRow) => emit('select', row.plugin)"
  >
    <template #cell-name="{ row }">
      <div class="cell-name">
        <div class="plugin-avatar plugin-avatar--sm">
          <img
            v-if="row.avatarUrl"
            :src="row.avatarUrl"
            :alt="row.name"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
          <NbIcon v-else :name="row.isOpenBridge ? 'diamond' : 'puzzle-piece'" :size="14" />
        </div>
        <div>
          <div class="plugin-name">{{ row.name }}</div>
          <div v-if="row.platform" class="plugin-platform">Platform: {{ row.platform }}</div>
        </div>
      </div>
    </template>

    <template #cell-version="{ row }">
      {{ row.version }}
      <NbBadge v-if="row.availableUpdate" variant="blue" size="sm">v{{ row.availableUpdate }}</NbBadge>
    </template>

    <template #cell-status="{ row }">
      <NbBadge :variant="statusVariant(row.status)">{{ row.status }}</NbBadge>
    </template>
  </NbDataTable>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { IDataTableColumn, IDataTableSortState } from '@nubisco/ui'
import type { PluginInstance } from '@/api'

export interface PluginRow {
  plugin: PluginInstance
  avatarUrl: string | null
  isOpenBridge: boolean
  sponsorUrl?: string
  docsUrl?: string
}

const props = defineProps<{
  rows: PluginRow[]
  view: 'cards' | 'table'
  selectedId?: string | null
}>()

const emit = defineEmits<{ select: [plugin: PluginInstance] }>()

function statusVariant(status: string) {
  if (status === 'running') return 'green'
  if (status === 'error') return 'red'
  if (status === 'loading') return 'blue'
  return 'grey'
}

// ─── Table mode ─────────────────────────────────────────────────────────────
// NbDataTable is *controlled*: it emits sort intent and renders whatever rows
// it is handed, so the ordering is applied here rather than inside it.
const sortState = ref<IDataTableSortState | null>({ key: 'name', direction: 'asc' })

const columns: IDataTableColumn[] = [
  { key: 'name', header: 'Plugin', sortable: true },
  { key: 'version', header: 'Version', sortable: true, width: 140 },
  { key: 'source', header: 'Source', sortable: true, width: 120 },
  { key: 'status', header: 'Status', sortable: true, width: 120 },
  { key: 'author', header: 'Author', sortable: true },
]

// NbDataTable is generic over `T extends Record<string, unknown>`, so a row
// interface needs an index signature to be assignable. Without it the rows,
// the row-click handler and every cell slot fall back to `unknown`.
// (@nubisco/ui 4.1.2; only visible once the plugin emits components.d.ts.)
interface TableRow {
  [key: string]: unknown
  id: string
  name: string
  version: string
  availableUpdate?: string
  source: string
  status: string
  author: string
  platform?: string
  avatarUrl: string | null
  isOpenBridge: boolean
  plugin: PluginInstance
}

const tableRows = computed<TableRow[]>(() => {
  const mapped = props.rows.map((row) => ({
    id: row.plugin.id,
    name: row.plugin.manifest.name,
    version: `v${row.plugin.manifest.version}`,
    availableUpdate: row.plugin.availableUpdate,
    source: row.plugin.source === 'homebridge' ? 'Homebridge' : 'Native',
    status: row.plugin.status,
    author: row.plugin.manifest.author ?? '—',
    platform: row.plugin.source === 'homebridge' ? row.plugin.platformName : undefined,
    avatarUrl: row.avatarUrl,
    isOpenBridge: row.isOpenBridge,
    plugin: row.plugin,
  }))

  const sort = sortState.value
  if (!sort || sort.direction === 'none') return mapped

  const dir = sort.direction === 'asc' ? 1 : -1
  return [...mapped].sort(
    (a, b) =>
      dir * String(a[sort.key as keyof typeof a] ?? '').localeCompare(String(b[sort.key as keyof typeof b] ?? '')),
  )
})
</script>

<style lang="scss" scoped>
.plugin-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
  // Stretch, not start: only some plugins publish sponsor/docs links, and
  // letting cards size to their own content made a row ragged wherever one
  // card happened to have them.
  align-items: stretch;
}

// NbPanel supplies the surface, border and layer. Only the things it cannot
// know about live here: the status accent, selection ring and inner rhythm.
.plugin-card {
  position: relative;
  overflow: hidden;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  transition:
    border-color 0.15s,
    background 0.15s;

  &:hover {
    background: var(--nb-c-surface-hover);
  }

  &--selected {
    border-color: var(--nb-c-primary);
    box-shadow: 0 0 0 1px var(--nb-c-primary);
  }
}

.plugin-card__accent {
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;

  &--running {
    background: var(--nb-c-success);
  }
  &--error {
    background: var(--nb-c-danger);
  }
  &--stopped,
  &--idle {
    background: var(--nb-c-component-inactive);
  }
  &--loading {
    background: var(--nb-c-info);
  }
}

.plugin-card__header {
  margin-bottom: 0.6rem;
}

.plugin-avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--nb-c-layer-2);
  color: var(--nb-c-text-muted);
  overflow: hidden;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  &--sm {
    width: 22px;
    height: 22px;
    border-radius: 6px;
  }
}

.plugin-meta {
  flex: 1;
  min-width: 0;
}

.plugin-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--nb-c-text);
  word-break: break-word;
}

.plugin-platform {
  font-size: 0.72rem;
  color: var(--nb-c-text-muted);
}

.plugin-version {
  font-size: 0.72rem;
  color: var(--nb-c-text-subtle);
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.plugin-desc {
  margin: 0 0 0.4rem;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--nb-c-text-muted);
}

.plugin-author {
  margin: 0;
  font-size: 0.74rem;
  color: var(--nb-c-text-subtle);
}

.plugin-links {
  display: flex;
  gap: 0.4rem;
  // Pinned to the bottom so the links line up across a row instead of
  // floating at whatever height the description happens to end.
  margin-top: auto;
  padding-top: 0.5rem;

  // Same recipe NbBadge uses for its tinted variants: a 12% fill of the
  // semantic colour behind that colour as text. The previous outline-only
  // treatment leaned on --nb-c-border, which is deliberately near-invisible.
  a {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
    font-weight: 500;
    padding: 0.15rem 0.5rem;
    border-radius: 99px;
    background: color-mix(in srgb, var(--nb-c-primary) 12%, var(--nb-c-surface));
    color: var(--nb-c-primary);
    text-decoration: none;

    &:hover {
      background: color-mix(in srgb, var(--nb-c-primary) 22%, var(--nb-c-surface));
    }
  }
}

.plugin-error {
  margin-top: 0.5rem;
  font-size: 0.72rem;
  color: var(--nb-c-danger);
  word-break: break-word;
}

.cell-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
