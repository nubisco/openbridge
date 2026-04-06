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

<template>
  <div class="marketplace-view">
    <div class="marketplace-toolbar">
      <div class="search-wrap">
        <NbIcon name="magnifying-glass" :size="15" class="search-icon" />
        <input v-model="query" placeholder="Search Homebridge plugins..." class="search-input" @input="onInput" />
      </div>
      <span v-if="total > 0" class="result-count">{{ total.toLocaleString() }} plugins</span>
    </div>

    <!-- Post-install guidance -->
    <div v-if="justInstalled" class="install-success">
      <div class="install-success-header">
        <NbIcon name="check-circle" :size="16" />
        <strong>{{ justInstalled.name }} installed</strong>
        <button class="dismiss-btn" @click="justInstalled = null"><NbIcon name="x" :size="13" /></button>
      </div>
      <p>To use this plugin, add a platform entry to your config and restart the daemon:</p>
      <pre class="config-snippet">
{
  "platform": "YourPlatformName",
  "plugin": "{{ justInstalled.mainFile }}"
}</pre
      >
      <button class="btn-open-config" @click="goToConfig">
        <NbIcon name="gear" :size="13" />
        Open Config Editor
      </button>
    </div>

    <div v-if="error" class="error-banner">
      <NbIcon name="warning" :size="14" />
      {{ error }}
    </div>

    <div v-if="loading && results.length === 0" class="loading-state">
      <NbIcon name="spinner" :size="28" />
      <span>Searching npm registry...</span>
    </div>

    <div v-else-if="results.length === 0 && !loading" class="empty-state">
      <NbIcon name="package" :size="36" />
      <p>No plugins found for "{{ query }}"</p>
    </div>

    <div v-else class="plugin-list">
      <div v-for="pkg in results" :key="pkg.name" class="plugin-row">
        <div class="plugin-row-icon">
          <NbIcon name="puzzle-piece" :size="18" />
        </div>
        <div class="plugin-row-body">
          <div class="plugin-row-header">
            <span class="plugin-name">{{ pkg.name }}</span>
            <span class="plugin-version">v{{ pkg.version }}</span>
            <span class="hb-badge">
              <NbIcon name="intersect" :size="10" />
              Homebridge
            </span>
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
          <button v-if="installed.has(pkg.name)" class="btn-installed" disabled>
            <NbIcon name="check" :size="13" />
            Installed
          </button>
          <!-- fallthrough to installing/install -->
          <button v-else-if="installing === pkg.name" class="btn-installing" disabled>
            <NbIcon name="spinner" :size="13" />
            Installing...
          </button>
          <button v-else class="btn-install" :disabled="!!installing" @click="install(pkg)">Install</button>
        </div>
      </div>

      <div v-if="results.length < total" class="load-more">
        <button class="btn-load-more" :disabled="loading" @click="loadMore">
          {{ loading ? 'Loading...' : `Load more (${total - results.length} remaining)` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.marketplace-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}

.marketplace-toolbar {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.search-wrap {
  position: relative;
  flex: 1;
  max-width: 420px;

  .search-icon {
    position: absolute;
    left: 0.6rem;
    top: 50%;
    transform: translateY(-50%);
    color: #9ca3af;
    pointer-events: none;
  }
}

.search-input {
  width: 100%;
  padding: 0.45rem 0.75rem 0.45rem 2rem;
  border: 1px solid #e8e8f0;
  border-radius: 8px;
  font-size: 0.875rem;
  outline: none;
  transition: border-color 0.15s;
  &:focus {
    border-color: #a78bfa;
  }
}

.result-count {
  font-size: 0.78rem;
  color: #9ca3af;
}

.install-success {
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.82rem;

  .install-success-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #065f46;
    font-size: 0.875rem;
    strong {
      flex: 1;
    }
  }

  p {
    margin: 0;
    color: #374151;
  }

  .config-snippet {
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    font-size: 0.75rem;
    font-family: monospace;
    color: #1a1a2e;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .btn-open-config {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: #059669;
    color: #fff;
    border: none;
    border-radius: 7px;
    padding: 0.4rem 0.9rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    align-self: flex-start;
    &:hover {
      background: #047857;
    }
  }

  .dismiss-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: #6b7280;
    padding: 2px;
    display: flex;
    &:hover {
      color: #111827;
    }
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
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 4rem 2rem;
  color: #9ca3af;
  text-align: center;
  p {
    margin: 0;
    font-size: 0.875rem;
  }
}

.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.plugin-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  background: #fff;
  border: 1.5px solid #e8e8f0;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  transition: border-color 0.12s;
  &:hover {
    border-color: #c4b5fd;
  }
}

.plugin-row-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 8px;
  background: #f0eeff;
  color: #7c3aed;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
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
  margin-bottom: 0.25rem;
}

.plugin-name {
  font-weight: 600;
  font-size: 0.875rem;
  color: #111827;
}

.plugin-version {
  font-size: 0.72rem;
  color: #9ca3af;
  background: #f3f4f6;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

.hb-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.67rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-radius: 20px;
  padding: 0.1rem 0.45rem;
}

.plugin-desc {
  font-size: 0.82rem;
  color: #6b7280;
  margin: 0 0 0.35rem;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-meta {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.74rem;
  color: #9ca3af;

  .sep {
    color: #d1d5db;
  }
  .npm-link {
    color: #7c3aed;
    text-decoration: none;
    &:hover {
      text-decoration: underline;
    }
  }
}

.plugin-row-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding-top: 2px;
}

%btn-base {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.35rem 0.85rem;
  border-radius: 7px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  transition:
    background 0.15s,
    opacity 0.15s;
  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
}

.btn-install {
  @extend %btn-base;
  background: #7c3aed;
  color: #fff;
  &:not(:disabled):hover {
    background: #6d28d9;
  }
}

.btn-installing {
  @extend %btn-base;
  background: #e5e7eb;
  color: #6b7280;
}

.btn-installed {
  @extend %btn-base;
  background: #d1fae5;
  color: #065f46;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 0.75rem 0;
}

.btn-load-more {
  font-size: 0.82rem;
  color: #7c3aed;
  background: none;
  border: 1.5px solid #e8e8f0;
  border-radius: 8px;
  padding: 0.45rem 1.25rem;
  cursor: pointer;
  transition: border-color 0.15s;
  &:hover:not(:disabled) {
    border-color: #a78bfa;
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
}
</style>
