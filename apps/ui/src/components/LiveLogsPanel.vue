<template>
  <NbShellPanel v-model:size="size" title="Live logs">
    <template #toolbar>
      <div class="logs-filter">
        <!-- xs, not sm: the field height token for xs (3.5 base units) is the
             same as --nb-shell-panel-header-height, so the control sits inside
             the header band instead of overflowing it. -->
        <NbSelect v-model="logFilter" multiple :options="pluginFilterOptions" placeholder="All plugins" size="xs" />
      </div>
      <NbButton
        v-nb-tooltip="{ body: 'Clear logs' }"
        size="xs"
        variant="ghost"
        icon="trash"
        aria-label="Clear logs"
        @click="clearLogs"
      />
    </template>

    <div ref="logsEl" class="log-list">
      <div v-if="filteredLogs.length === 0" class="log-empty type-body-compact">No log entries yet.</div>
      <div v-for="(entry, i) in filteredLogs" :key="i" class="log-line">
        <span class="log-time tabular">{{ new Date(entry.timestamp).toLocaleTimeString() }}</span>
        <span class="log-level" :class="`log-level--${entry.level}`">{{ entry.level.toUpperCase() }}</span>
        <span class="log-plugin">{{ entry.plugin }}</span>
        <span class="log-msg">{{ entry.message }}</span>
      </div>
    </div>
  </NbShellPanel>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import type { TShellPanelSize } from '@nubisco/ui'
import { useDaemonStore } from '@/stores/daemon'

const daemon = useDaemonStore()

// The panel is app-wide, so its size is a user preference rather than view
// state: without persisting it the console springs back open on every
// navigation and reload.
const SIZE_KEY = 'openbridge.logs.panelSize'
const VALID_SIZES: TShellPanelSize[] = ['collapsed', 'default', 'full']

const size = ref<TShellPanelSize>('collapsed')

onMounted(() => {
  const stored = localStorage.getItem(SIZE_KEY) as TShellPanelSize | null
  if (stored && VALID_SIZES.includes(stored)) size.value = stored
})

watch(size, (value) => localStorage.setItem(SIZE_KEY, value))

const logFilter = ref<string[]>([]) // empty = show all
const logsEl = ref<HTMLElement | null>(null)

const pluginFilterOptions = computed(() => [
  { value: 'system', label: 'system' },
  ...daemon.plugins.map((p) => ({ value: p.manifest.name, label: p.manifest.name })),
])

const filteredLogs = computed(() => {
  if (logFilter.value.length === 0) return daemon.logs
  return daemon.logs.filter((e) => logFilter.value.includes(e.plugin))
})

function clearLogs() {
  daemon.logs.length = 0
}

// Follow the tail, but only when the user is already at the bottom: otherwise
// scrolling back to read an older entry gets yanked away by the next line.
watch(
  () => filteredLogs.value.length,
  async () => {
    const el = logsEl.value
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (!atBottom) return
    await nextTick()
    el.scrollTop = el.scrollHeight
  },
)
</script>

<style lang="scss" scoped>
.logs-filter {
  width: 220px;

  // The panel header also holds the title and three size controls, so on a
  // phone the filter takes what is left instead of pushing them off.
  @include variables.phone {
    width: auto;
    flex: 1 1 0;
    min-width: 0;
  }
}

// No background of its own: the NbShellPanel surface shows through, so the
// console follows the active theme instead of pinning one palette. The log is
// code, so it reads in the library's mono set (Plex Mono at 12px) rather than
// the terminal's Meslo, which only the terminal and the editors need for glyphs.
.log-list {
  height: 100%;
  overflow-y: auto;
  padding: var(--nb-spacing-4) var(--nb-spacing-8);
  font-family: var(--nb-type-code-sm-family);
  font-size: var(--nb-type-code-sm-size);
  font-weight: var(--nb-type-code-sm-weight);
  line-height: var(--nb-type-code-sm-line-height);
  letter-spacing: var(--nb-type-code-sm-letter-spacing);
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-2);
}

.log-empty {
  color: var(--nb-c-text-muted);
  padding-block: var(--nb-spacing-16);
  text-align: center;
}

.log-line {
  display: flex;
  gap: var(--nb-spacing-8);
  align-items: baseline;

  @include variables.phone {
    flex-wrap: wrap;
    row-gap: 0;
  }

  &:hover {
    background: var(--nb-c-surface-hover);
    border-radius: var(--nb-radius-control-sm);
  }
}

.log-time {
  color: var(--nb-c-text-subtle);
  flex-shrink: 0;
}

// The level is told apart by its hue and its word, not by weight: semibold
// is for 14px and up, and the line is 12px.
.log-level {
  flex-shrink: 0;
  width: 5ch;

  &--debug {
    color: var(--nb-c-text-subtle);
  }
  &--info {
    color: var(--nb-c-info);
  }
  &--warn {
    color: var(--nb-c-warning);
  }
  &--error {
    color: var(--nb-c-danger);
  }
}

.log-plugin {
  color: var(--nb-c-primary);
  flex-shrink: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-msg {
  color: var(--nb-c-text-muted);
  flex: 1;
  word-break: break-word;

  // Beside time, level and plugin a phone leaves the message a few characters
  // a line, so there it takes a line of its own under them.
  @include variables.phone {
    flex-basis: 100%;
  }
}
</style>
