<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useInspectorStore } from '@/stores/inspector'
import { useDaemonStore } from '@/stores/daemon'
import { api, type NpmPackage, type LocalPlugin } from '@/api'
import { useNotifications } from '@/composables/useNotifications'

const inspector = useInspectorStore()
const daemon = useDaemonStore()
const notify = useNotifications()
const uninstalling = ref<string | null>(null)

const query = ref('')
const results = ref<NpmPackage[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)
const installing = ref<string | null>(null)
const installed = ref(new Map<string, string>()) // name → mainFile
const justInstalled = ref<{ name: string; mainFile: string } | null>(null)
const page = ref(0)
const PAGE_SIZE = 20
const localPlugins = ref<LocalPlugin[]>([])
// Marketplace API — enriched data (stars, sponsors, reviews) is already in the response
const MARKETPLACE_API = 'https://marketplace.openbridge.nubisco.io/api'

interface MarketplacePlugin {
  name: string
  display_name: string
  description: string | null
  version: string
  author: string | null
  homepage: string | null
  repository_url: string | null
  npm_url: string
  weekly_downloads: number
  github_stars: number | null
  github_sponsors_url: string | null
  verified: boolean
  deprecated: boolean
  last_published_at: string
  rating_avg: number | null
  rating_count: number
}

function marketplaceToNpmPackage(p: MarketplacePlugin): NpmPackage {
  return {
    name: p.name,
    version: p.version,
    description: p.description ?? '',
    author: p.author ? { name: p.author } : undefined,
    date: p.last_published_at,
    weeklyDownloads: p.weekly_downloads,
    githubStars: p.github_stars ?? undefined,
    githubSponsorsUrl: p.github_sponsors_url ?? undefined,
    documentationUrl: p.homepage ?? undefined,
    links: {
      npm: p.npm_url,
      homepage: p.homepage ?? undefined,
      repository: p.repository_url ?? undefined,
    },
  }
}

// Format download count (e.g., 1000 → "1.0K", 1000000 → "1.0M")
function formatDownloads(count?: number): string {
  if (!count) return '0'
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return count.toString()
}

async function search(reset = true) {
  if (reset) {
    page.value = 0
    results.value = []
  }
  loading.value = true
  error.value = null
  try {
    const marketplacePage = page.value + 1
    const params = new URLSearchParams({
      q: query.value,
      page: String(marketplacePage),
      limit: String(PAGE_SIZE),
    })
    const res = await fetch(`${MARKETPLACE_API}/plugins?${params}`)
    if (!res.ok) throw new Error(`Marketplace API error: ${res.status}`)
    const data = (await res.json()) as { plugins: MarketplacePlugin[]; total: number }
    const pkgs = data.plugins.map(marketplaceToNpmPackage)
    results.value = reset ? pkgs : [...results.value, ...pkgs]
    total.value = data.total
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function install(pkg: NpmPackage) {
  if (installing.value) return
  installing.value = pkg.name
  error.value = null
  try {
    const res = await api.marketplace.install(pkg.name)
    installed.value.set(pkg.name, res.mainFile)
    justInstalled.value = { name: pkg.name, mainFile: res.mainFile }
    await api.pluginsRefresh()
    await daemon.fetchPlugins()
    notify.success(`Installed ${pkg.name}`)
  } catch (e) {
    error.value = `Failed to install ${pkg.name}: ${e}`
    notify.error(`Failed to install ${pkg.name}`)
  } finally {
    installing.value = null
  }
}

async function uninstall(name: string) {
  if (uninstalling.value) return
  uninstalling.value = name
  error.value = null
  try {
    await api.marketplace.uninstall(name)
    installed.value.delete(name)
    await daemon.fetchPlugins()
    notify.success(`Removed ${name}`)
  } catch (e) {
    error.value = `Failed to uninstall ${name}: ${e}`
    notify.error(`Failed to remove ${name}`)
  } finally {
    uninstalling.value = null
  }
}

async function activateLocal(local: LocalPlugin) {
  if (installing.value || !local.platform) return
  installing.value = local.name
  error.value = null
  try {
    // Find the main file: look for dist/index.js or index.js
    const mainFile = `${local.path}/dist/index.js`
    const platform: Record<string, unknown> = {
      platform: local.platform,
      plugin: mainFile,
    }
    await api.config.savePlatform(platform)
    installed.value.set(local.name, mainFile)
    justInstalled.value = { name: local.name, mainFile }
    await daemon.fetchPlugins()
    notify.success(`Activated ${local.name}`)
  } catch (e) {
    error.value = `Failed to activate ${local.name}: ${e}`
    notify.error(`Failed to activate ${local.name}`)
  } finally {
    installing.value = null
  }
}

function githubAvatarUrl(pkg: NpmPackage): string | null {
  const repo = pkg.links?.repository ?? pkg.links?.homepage ?? ''
  const m = repo.match(/github\.com\/([^/]+)/)
  return m ? `https://github.com/${m[1]}.png?size=48` : null
}

function isOpenBridge(pkg: NpmPackage) {
  return pkg.name.startsWith('openbridge-')
}

function authorName(pkg: NpmPackage): string {
  if (!pkg.author) return ''
  return typeof pkg.author === 'string' ? pkg.author : (pkg.author.name ?? '')
}

function relativeDate(d: string): string {
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function loadMore() {
  page.value++
  search(false)
}

let debounce: ReturnType<typeof setTimeout> | null = null
function onInput() {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => search(), 350)
}

onMounted(async () => {
  try {
    const res = await api.marketplace.installed()
    for (const p of res.packages) installed.value.set(p.name, p.mainFile)
  } catch {
    /* ignore */
  }
  try {
    const res = await api.marketplace.local()
    localPlugins.value = res.plugins
  } catch {
    /* ignore */
  }
  search()
})
</script>

<template>
  <div class="mp-panel">
    <!-- Header -->
    <div class="mp-header">
      <span class="mp-title">Browse Plugins</span>
      <NbButton variant="ghost" size="sm" icon="x" @click="inspector.close()" />
    </div>

    <!-- Search -->
    <div class="mp-search-wrap">
      <NbTextInput v-model="query" placeholder="Search plugins" size="sm" @update:model-value="onInput" />
    </div>

    <div v-if="total > 0" class="mp-count">{{ total.toLocaleString() }} plugins found</div>

    <!-- Just-installed banner -->
    <div v-if="justInstalled" class="mp-installed-banner">
      <NbIcon name="check-circle" :size="14" />
      <div class="mp-installed-body">
        <strong>{{ justInstalled.name }}</strong>
        installed. Click it in your plugins list to configure it.
      </div>
      <button class="mp-dismiss" @click="justInstalled = null"><NbIcon name="x" :size="12" /></button>
    </div>

    <div v-if="error" class="mp-error">
      <NbIcon name="warning" :size="13" />
      {{ error }}
    </div>

    <!-- Local plugins (from configured sources) -->
    <div v-if="localPlugins.length > 0" class="mp-local-section">
      <div class="mp-local-heading">
        <NbIcon name="diamond" :size="11" />
        Local plugins
      </div>
      <div v-for="local in localPlugins" :key="local.name" class="mp-row mp-row--ob mp-row--local">
        <div class="mp-avatar mp-avatar--ob">
          <NbIcon name="diamond" :size="16" />
        </div>
        <div class="mp-info">
          <div class="mp-name-row">
            <span class="mp-name">{{ local.name }}</span>
            <span class="badge badge--native">
              <NbIcon name="diamond" :size="9" />
              Native
            </span>
            <span class="badge badge--local">
              <NbIcon name="folder" :size="9" />
              Local
            </span>
            <span class="mp-ver">v{{ local.version }}</span>
          </div>
          <p v-if="local.description" class="mp-desc">{{ local.description }}</p>
          <div class="mp-meta">
            <span v-if="local.author">{{ local.author }}</span>
          </div>
        </div>
        <div class="mp-action">
          <NbButton v-if="installed.has(local.name)" variant="ghost" size="sm" disabled icon="check">Active</NbButton>
          <NbButton
            v-else
            variant="primary"
            size="sm"
            :loading="installing === local.name"
            :disabled="!!installing || !local.platform"
            :title="!local.platform ? 'No platform declared in package.json openbridge.platform' : ''"
            @click="activateLocal(local)"
          >
            Activate
          </NbButton>
        </div>
      </div>
    </div>

    <!-- Results -->
    <div class="mp-list">
      <div v-if="loading && results.length === 0" class="mp-loading">
        <NbIcon name="spinner" :size="22" />
        <span>Searching npm…</span>
      </div>

      <div v-for="pkg in results" :key="pkg.name" class="mp-row" :class="{ 'mp-row--ob': isOpenBridge(pkg) }">
        <!-- Avatar -->
        <div class="mp-avatar" :class="{ 'mp-avatar--ob': isOpenBridge(pkg) }">
          <img
            v-if="githubAvatarUrl(pkg)"
            :src="githubAvatarUrl(pkg)!"
            :alt="pkg.name"
            class="mp-avatar-img"
            @error="($event.target as HTMLImageElement).style.display = 'none'"
          />
          <!-- fallback icon -->
          <NbIcon v-if="isOpenBridge(pkg)" name="diamond" :size="16" />
          <NbIcon v-else name="puzzle-piece" :size="16" />
        </div>

        <!-- Info -->
        <div class="mp-info">
          <div class="mp-name-row">
            <span class="mp-name">{{ pkg.name }}</span>
            <span v-if="isOpenBridge(pkg)" class="badge badge--native">
              <NbIcon name="diamond" :size="9" />
              Native
            </span>
            <span v-else class="badge badge--hb">
              <NbIcon name="intersect" :size="9" />
              HB
            </span>
            <span class="mp-ver">v{{ pkg.version }}</span>
          </div>
          <p v-if="pkg.description" class="mp-desc">{{ pkg.description }}</p>
          <div class="mp-meta">
            <span v-if="authorName(pkg)">{{ authorName(pkg) }}</span>
            <span v-if="authorName(pkg)" class="mp-sep">·</span>
            <span>{{ relativeDate(pkg.date) }}</span>
          </div>
          <!-- Enriched metadata row -->
          <div class="mp-enriched">
            <span v-if="pkg.weeklyDownloads" class="mp-stat">
              <NbIcon name="cloud-arrow-down" :size="11" />
              {{ formatDownloads(pkg.weeklyDownloads) }}
            </span>
            <span v-if="pkg.githubStars" class="mp-stat">
              <NbIcon name="star" weight="fill" :size="11" />
              {{ formatDownloads(pkg.githubStars) }}
            </span>
            <a
              v-if="pkg.githubSponsorsUrl"
              :href="pkg.githubSponsorsUrl"
              target="_blank"
              rel="noopener"
              class="mp-stat mp-stat--link"
            >
              <NbIcon name="heart" weight="fill" :size="11" />
              Sponsor
            </a>
            <a
              v-if="pkg.documentationUrl"
              :href="pkg.documentationUrl"
              target="_blank"
              rel="noopener"
              class="mp-stat mp-stat--link"
            >
              <NbIcon name="book-open" :size="11" />
              Docs
            </a>
            <a
              :href="`https://marketplace.openbridge.nubisco.io/plugins/${pkg.name}`"
              target="_blank"
              rel="noopener"
              class="mp-stat mp-stat--link mp-stat--marketplace"
            >
              <NbIcon name="arrow-square-out" :size="11" />
              Marketplace
            </a>
          </div>
        </div>

        <!-- Action -->
        <div class="mp-action">
          <template v-if="installed.has(pkg.name)">
            <NbButton
              variant="danger"
              size="sm"
              outlined
              :loading="uninstalling === pkg.name"
              :disabled="!!uninstalling"
              @click="uninstall(pkg.name)"
            >
              Remove
            </NbButton>
          </template>
          <NbButton
            v-else
            variant="primary"
            size="sm"
            :loading="installing === pkg.name"
            :disabled="!!installing"
            @click="install(pkg)"
          >
            Install
          </NbButton>
        </div>
      </div>

      <!-- Load more -->
      <div v-if="results.length > 0 && results.length < total" class="mp-load-more-wrap">
        <NbButton variant="ghost" size="sm" :loading="loading" :disabled="loading" @click="loadMore">
          {{ loading ? 'Loading…' : `Load more (${total - results.length} remaining)` }}
        </NbButton>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.mp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.1rem;
  border-bottom: 1px solid #f0f0f8;
  flex-shrink: 0;
}

.mp-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: #111827;
}

.mp-search-wrap {
  padding: 0.75rem 1.1rem 0;
  flex-shrink: 0;
}

.mp-count {
  padding: 0.35rem 1.1rem 0;
  font-size: 0.72rem;
  color: #9ca3af;
  flex-shrink: 0;
}

.mp-installed-banner {
  margin: 0.5rem 1.1rem 0;
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: 8px;
  padding: 0.55rem 0.7rem;
  font-size: 0.78rem;
  color: #065f46;
  flex-shrink: 0;

  .mp-installed-body {
    flex: 1;
  }
  .mp-dismiss {
    background: none;
    border: none;
    cursor: pointer;
    color: #6b7280;
    padding: 0;
    display: flex;
  }
}

.mp-error {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.5rem 1.1rem 0;
  font-size: 0.78rem;
  color: #dc2626;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 0.5rem 0.7rem;
  flex-shrink: 0;
}

.mp-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem 0;
}

.mp-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 3rem 1rem;
  color: #9ca3af;
  font-size: 0.82rem;
}

// ─── Result row ───────────────────────────────────────────────────────────────
.mp-row {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.65rem 1.1rem;
  transition: background 0.1s;
  border-left: 3px solid transparent;
  &:hover {
    background: #f9f9fc;
  }

  // OpenBridge native plugin highlight
  &.mp-row--ob {
    border-left-color: #7c3aed;
    background: linear-gradient(90deg, rgba(124, 58, 237, 0.04) 0%, transparent 100%);
    &:hover {
      background: linear-gradient(90deg, rgba(124, 58, 237, 0.08) 0%, #f9f9fc 100%);
    }
  }
}

.mp-avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 8px;
  background: #f0f0f8;
  color: #9ca3af;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  position: relative;

  &.mp-avatar--ob {
    background: linear-gradient(135deg, #7c3aed, #4f46e5);
    color: #fff;
  }
}

.mp-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
  z-index: 1;
}

.mp-info {
  flex: 1;
  min-width: 0;
}

.mp-name-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  margin-bottom: 0.2rem;
}
.mp-name {
  font-size: 0.82rem;
  font-weight: 600;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-ver {
  font-size: 0.68rem;
  color: #9ca3af;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.62rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.1rem 0.4rem;
  border-radius: 20px;
  flex-shrink: 0;

  &--native {
    background: linear-gradient(135deg, #7c3aed, #4f46e5);
    color: #fff;
    box-shadow: 0 1px 4px rgba(124, 58, 237, 0.4);
  }
  &--hb {
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fcd34d;
  }
}

.mp-desc {
  font-size: 0.75rem;
  color: #6b7280;
  margin: 0 0 0.2rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mp-meta {
  font-size: 0.68rem;
  color: #9ca3af;
  display: flex;
  gap: 0.3rem;
  .mp-sep {
    color: #d1d5db;
  }
}

.mp-enriched {
  font-size: 0.68rem;
  color: #9ca3af;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.25rem;
  flex-wrap: wrap;
}

.mp-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.4rem;
  background: #f3f4f6;
  border-radius: 4px;
  color: #6b7280;
  font-size: 0.65rem;
  white-space: nowrap;

  &.mp-stat--link {
    cursor: pointer;
    color: #7c3aed;
    background: rgba(124, 58, 237, 0.08);
    border: 1px solid rgba(124, 58, 237, 0.2);
    text-decoration: none;
    transition: all 0.15s;
    &:hover {
      background: rgba(124, 58, 237, 0.12);
      border-color: rgba(124, 58, 237, 0.3);
    }
  }

  &.mp-stat--marketplace {
    font-weight: 600;
  }
}

.mp-action {
  flex-shrink: 0;
  padding-top: 2px;
}

// ─── Local plugins section ────────────────────────────────────────────────────
.mp-local-section {
  flex-shrink: 0;
  border-bottom: 1px solid #f0f0f8;
  padding-bottom: 0.25rem;
}

.mp-local-heading {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.68rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #7c3aed;
  padding: 0.5rem 1.1rem 0.25rem;
}

.mp-row--local {
  background: linear-gradient(90deg, rgba(124, 58, 237, 0.06) 0%, transparent 100%);
  &:hover {
    background: linear-gradient(90deg, rgba(124, 58, 237, 0.1) 0%, #f9f9fc 100%);
  }
}

.badge--local {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.62rem;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0.1rem 0.4rem;
  border-radius: 20px;
  flex-shrink: 0;
  background: #ede9fe;
  color: #6d28d9;
  border: 1px solid #c4b5fd;
}

.mp-load-more-wrap {
  display: flex;
  justify-content: center;
  padding: 0.5rem 1.1rem;
}
</style>
