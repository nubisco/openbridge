<template>
  <div class="marketplace-view">
    <Teleport defer to="#ob-topbar-right">
      <NbTextInput
        v-model="query"
        size="sm"
        placeholder="Search Homebridge plugins..."
        style="width: 260px"
        @input="onInput"
      />
    </Teleport>
    <Teleport v-if="total > 0" defer to="#ob-topbar-left">
      <span class="result-count">{{ total.toLocaleString() }} plugins</span>
    </Teleport>

    <!-- Post-install guidance -->
    <NbPanel v-if="justInstalled" class="install-success">
      <div class="install-success-header">
        <NbIcon name="check-circle" :size="16" />
        <strong>{{ justInstalled.name }} installed</strong>
        <NbButton variant="ghost" size="xs" icon="x" title="Dismiss" @click="justInstalled = null" />
      </div>
      <p>To use this plugin, add a platform entry to your config and restart the daemon:</p>
      <pre class="config-snippet">
{
  "platform": "YourPlatformName",
  "plugin": "{{ justInstalled.mainFile }}"
}</pre
      >
      <NbButton variant="secondary" size="sm" outlined icon="gear" @click="goToConfig">Open Config Editor</NbButton>
    </NbPanel>

    <NbMessage v-if="error" variant="error">{{ error }}</NbMessage>

    <div v-if="loading && results.length === 0" class="loading-state">
      <NbIcon name="spinner" :size="28" />
      <span>Searching npm registry...</span>
    </div>

    <div v-else-if="results.length === 0 && !loading" class="empty-state">
      <NbIcon name="package" :size="36" />
      <p>No plugins found for "{{ query }}"</p>
    </div>

    <NbGrid v-else dir="col" gap="sm" class="plugin-list">
      <NbPanel v-for="pkg in results" :key="pkg.name" class="plugin-row">
        <div class="plugin-row-icon">
          <NbIcon name="puzzle-piece" :size="18" />
        </div>
        <div class="plugin-row-body">
          <div class="plugin-row-header">
            <span class="plugin-name">{{ pkg.name }}</span>
            <span class="plugin-version">v{{ pkg.version }}</span>
            <NbBadge variant="purple" size="sm">Homebridge</NbBadge>
          </div>
          <p v-if="pkg.description" class="plugin-desc">{{ pkg.description }}</p>
          <div class="plugin-meta">
            <span v-if="authorName(pkg)">by {{ authorName(pkg) }}</span>
            <span v-if="authorName(pkg)" class="sep">·</span>
            <span>updated {{ relativeDate(pkg.date) }}</span>
            <span v-if="pkg.links?.npm" class="sep">·</span>
            <a v-if="pkg.links?.npm" :href="pkg.links.npm" target="_blank" class="npm-link">npm</a>
          </div>
        </div>
        <div class="plugin-row-actions">
          <NbButton v-if="installed.has(pkg.name)" variant="ghost" size="sm" icon="check" disabled>Installed</NbButton>
          <NbButton
            v-else
            variant="primary"
            size="sm"
            :loading="installing === pkg.name"
            :disabled="!!installing"
            @click="install(pkg)"
          >
            {{ installing === pkg.name ? 'Installing…' : 'Install' }}
          </NbButton>
        </div>
      </NbPanel>

      <div v-if="results.length < total" class="load-more">
        <NbButton variant="secondary" size="sm" outlined :loading="loading" @click="loadMore">
          {{ loading ? 'Loading…' : `Load more (${total - results.length} remaining)` }}
        </NbButton>
      </div>
    </NbGrid>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useLayoutStore } from '@/stores/layout'
import { api, type NpmPackage } from '@/api'

const layout = useLayoutStore()
const router = useRouter()

const query = ref('')
const results = ref<NpmPackage[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)
const installing = ref<string | null>(null)
// Persisted: keyed by package name → { mainFile, pluginsDir }
const installed = ref<Map<string, { mainFile: string; pluginsDir: string }>>(new Map())
const justInstalled = ref<{ name: string; mainFile: string; pluginsDir: string } | null>(null)
const page = ref(0)
const PAGE_SIZE = 20

async function search(reset = true) {
  if (reset) page.value = 0
  loading.value = true
  error.value = null
  try {
    const res = await api.marketplace.search(query.value, page.value * PAGE_SIZE, PAGE_SIZE)
    results.value = reset ? res.objects.map((o) => o.package) : [...results.value, ...res.objects.map((o) => o.package)]
    total.value = res.total
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  page.value++
  await search(false)
}

async function install(pkg: NpmPackage) {
  if (installing.value) return
  installing.value = pkg.name
  error.value = null
  try {
    const res = await api.marketplace.install(pkg.name)
    installed.value.set(pkg.name, { mainFile: res.mainFile, pluginsDir: res.pluginsDir })
    justInstalled.value = { name: pkg.name, mainFile: res.mainFile, pluginsDir: res.pluginsDir }
  } catch (e) {
    error.value = `Failed to install ${pkg.name}: ${e}`
  } finally {
    installing.value = null
  }
}

function goToConfig() {
  router.push('/config')
}

function authorName(pkg: NpmPackage): string {
  if (!pkg.author) return ''
  if (typeof pkg.author === 'string') return pkg.author
  return pkg.author.name ?? ''
}

function relativeDate(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

let debounce: ReturnType<typeof setTimeout> | null = null
function onInput() {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => search(), 400)
}

onMounted(async () => {
  layout.setPage('Marketplace')
  // Load already-installed packages from daemon
  try {
    const res = await api.marketplace.installed()
    for (const p of res.packages) {
      installed.value.set(p.name, { mainFile: p.mainFile, pluginsDir: '' })
    }
  } catch {
    /* ignore */
  }
  search()
})
</script>

<style lang="scss" scoped>
.marketplace-view {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

// Teleported next to the breadcrumb.
.result-count {
  font-size: 0.8rem;
  color: var(--nb-c-text-muted);
}

.install-success {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-color: color-mix(in srgb, var(--nb-c-success) 35%, transparent);

  p {
    margin: 0;
    font-size: 0.82rem;
    color: var(--nb-c-text-muted);
  }
}

.install-success-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.86rem;
  color: var(--nb-c-success);

  // Pushes the dismiss control to the far edge without a spacer element.
  :last-child {
    margin-left: auto;
  }
}

.config-snippet {
  margin: 0;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: var(--nb-c-layer-1);
  font-family: 'MesloLGS NF', monospace;
  font-size: 0.74rem;
  line-height: 1.5;
  color: var(--nb-c-text-muted);
  overflow-x: auto;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 4rem;
  color: var(--nb-c-text-subtle);
  text-align: center;

  p {
    margin: 0;
    font-size: 0.875rem;
  }
}

// NbPanel supplies the surface; this is the row's internal layout only.
.plugin-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.plugin-row-icon {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--nb-c-layer-2);
  color: var(--nb-c-text-muted);
}

.plugin-row-body {
  flex: 1;
  min-width: 0;
}

.plugin-row-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.plugin-name {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--nb-c-text);
  word-break: break-word;
}

.plugin-version {
  font-size: 0.74rem;
  color: var(--nb-c-text-subtle);
}

.plugin-desc {
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--nb-c-text-muted);
}

.plugin-meta {
  margin-top: 0.3rem;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
  font-size: 0.74rem;
  color: var(--nb-c-text-subtle);

  .sep {
    opacity: 0.6;
  }

  .npm-link {
    color: var(--nb-c-primary);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}

.plugin-row-actions {
  flex-shrink: 0;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 0.5rem 0;
}
</style>
