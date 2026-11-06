<template>
  <!-- ═══ Cards ═══ -->
  <!-- Peers, so flat tiles on the page ground rather than each a raised
       region. NbCard draws the title, the support line, the hover and the
       selection, and lines the footers up along a row. -->
  <NbCardGrid v-if="view === 'cards'" min="260px" gap="md">
    <NbCard
      v-for="row in rows"
      :key="row.plugin.id"
      flat
      clickable
      orientation="horizontal"
      class="plugin-card"
      :title="row.plugin.manifest.name"
      :selected="row.plugin.id === selectedId"
      @select="emit('select', row.plugin)"
    >
      <template #icon>
        <span class="plugin-avatar">
          <img
            v-if="row.avatarUrl"
            :src="row.avatarUrl"
            :alt="row.plugin.manifest.name"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
          <NbIcon v-else :name="row.isOpenBridge ? 'diamond' : 'puzzle-piece'" size="md" />
        </span>
      </template>

      <!-- One status carrier: the badge. The coloured edge it used to repeat
           said the same thing a second time in the same hue. -->
      <template #meta>
        <NbBadge :variant="statusVariant(row.plugin.status)" size="sm">{{ row.plugin.status }}</NbBadge>
      </template>

      <template #subtitle>
        <span class="plugin-support">
          <span class="tabular">v{{ row.plugin.manifest.version }}</span>
          <span v-if="row.plugin.source === 'homebridge' && row.plugin.platformName">
            · Platform: {{ row.plugin.platformName }}
          </span>
          <NbBadge v-if="row.plugin.availableUpdate" variant="info" size="sm">
            v{{ row.plugin.availableUpdate }} available
          </NbBadge>
        </span>
      </template>

      <p v-if="row.plugin.manifest.description" class="plugin-desc">{{ row.plugin.manifest.description }}</p>
      <p v-if="row.plugin.manifest.author" class="plugin-desc">by {{ row.plugin.manifest.author }}</p>
      <p v-if="row.plugin.error" class="plugin-error">{{ row.plugin.error }}</p>

      <template v-if="row.sponsorUrl || row.docsUrl" #footer>
        <!-- The card is a button: a click or key on a link stays on the link. -->
        <span class="plugin-links" @click.stop @keydown.stop>
          <NbButton
            v-if="row.sponsorUrl"
            variant="link"
            size="xs"
            :href="row.sponsorUrl"
            target="_blank"
            :aria-label="`Sponsor ${row.plugin.manifest.name}`"
          >
            Sponsor
          </NbButton>
          <NbButton
            v-if="row.docsUrl"
            variant="link"
            size="xs"
            :href="row.docsUrl"
            target="_blank"
            :aria-label="`Docs for ${row.plugin.manifest.name}`"
          >
            Docs
          </NbButton>
        </span>
      </template>
    </NbCard>
  </NbCardGrid>

  <!-- ═══ Table ═══ -->
  <NbDataTable
    v-else
    :columns="columns"
    :rows="tableRows"
    row-key="id"
    size="sm"
    zebra
    stack-on-phone
    :sort-state="sortState"
    @sort="sortState = $event"
    @row-click="(row: TableRow) => emit('select', row.plugin)"
  >
    <template #cell-name="{ row }">
      <div class="cell-name">
        <span class="plugin-avatar plugin-avatar--sm">
          <img
            v-if="row.avatarUrl"
            :src="row.avatarUrl"
            :alt="row.name"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
          <NbIcon v-else :name="row.isOpenBridge ? 'diamond' : 'puzzle-piece'" size="sm" />
        </span>
        <div class="cell-name__text">
          <div class="type-heading-compact">{{ row.name }}</div>
          <div v-if="row.platform" class="type-body-sm cell-muted">Platform: {{ row.platform }}</div>
        </div>
      </div>
    </template>

    <template #cell-version="{ row }">
      <span class="cell-version">
        <span class="tabular">{{ row.version }}</span>
        <NbBadge v-if="row.availableUpdate" variant="info" size="sm">v{{ row.availableUpdate }}</NbBadge>
      </span>
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
  if (status === 'running') return 'success'
  if (status === 'error') return 'danger'
  if (status === 'loading') return 'info'
  return 'neutral'
}

// ─── Table mode ─────────────────────────────────────────────────────────────
// NbDataTable is *controlled*: it emits sort intent and renders whatever rows
// it is handed, so the ordering is applied here rather than inside it.
const sortState = ref<IDataTableSortState | null>({ key: 'name', direction: 'asc' })

// On a phone each row is a card: the plugin is its title, version, source and
// status share the line under it, and the author is the one labelled pair.
// The widths only apply to the desktop table.
const columns: IDataTableColumn[] = [
  { key: 'name', header: 'Plugin', sortable: true, primary: true },
  { key: 'version', header: 'Version', sortable: true, width: 140, phoneMeta: true },
  { key: 'source', header: 'Source', sortable: true, width: 120, phoneMeta: true },
  { key: 'status', header: 'Status', sortable: true, width: 120, phoneMeta: true },
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
.plugin-card {
  // A long package name breaks anywhere, and the support line and the links
  // wrap under it rather than widening the tile.
  min-width: 0;
}

.plugin-avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: var(--nb-radius-md);
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
    width: 24px;
    height: 24px;
    border-radius: var(--nb-radius-sm);
  }
}

.plugin-support {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--nb-spacing-4);
}

// NbCard sets the body in body-sm and muted. Paragraphs only need their
// margins taken off and a step between them.
.plugin-desc {
  margin: 0;
}

.plugin-desc + .plugin-desc {
  margin-top: var(--nb-spacing-4);
}

.plugin-error {
  margin: var(--nb-spacing-8) 0 0;
  color: var(--nb-c-danger);
  word-break: break-word;
}

.plugin-links {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--nb-spacing-8);
}

.cell-name {
  display: flex;
  align-items: center;
  gap: var(--nb-spacing-8);
}

.cell-muted {
  color: var(--nb-c-text-muted);
}

.cell-version {
  display: inline-flex;
  align-items: center;
  gap: var(--nb-spacing-4);
}
</style>
