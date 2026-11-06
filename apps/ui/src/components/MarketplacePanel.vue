<template>
  <!-- Renders inside the shell inspector, so it takes the inspector's density:
       xs fields, 12 of padding, 8 between controls. -->
  <div class="mp-panel">
    <div class="mp-header">
      <h2 class="mp-title type-heading-01">Browse plugins</h2>
      <!-- This panel searches npm and is deliberately narrow: install what you
           already know you want. The marketplace site ranks, reviews and
           compares, which needs room this drawer does not have, so it opens in
           its own tab rather than trying to reproduce it here. -->
      <NbButton
        v-nb-tooltip="{ body: 'Open the full marketplace in a new tab' }"
        variant="link"
        size="xs"
        icon="arrow-square-out"
        :href="MARKETPLACE_URL"
        target="_blank"
      >
        Marketplace
      </NbButton>
    </div>

    <div class="mp-top">
      <NbTextInput
        v-model="query"
        placeholder="Search plugins"
        size="xs"
        aria-label="Search plugins"
        @update:model-value="onInput"
      />

      <NbBanner
        v-if="justInstalled"
        status="success"
        dismissible
        :title="`${justInstalled.name} installed`"
        @dismiss="justInstalled = null"
      >
        Click it in your plugins list to configure it.
      </NbBanner>

      <NbMessage v-if="error" variant="error">{{ error }}</NbMessage>
    </div>

    <div class="mp-scroll">
      <!-- Local plugins (from configured sources) -->
      <NbContainedList v-if="localPlugins.length > 0" title="Local plugins" class="mp-list">
        <NbContainedListItem v-for="local in localPlugins" :key="local.name">
          <template #leading>
            <span class="mp-avatar">
              <NbIcon name="diamond" size="sm" />
            </span>
          </template>
          {{ local.name }}
          <template #line>
            <span class="mp-detail">
              <span class="mp-badges">
                <NbBadge variant="neutral" size="sm" icon="diamond">Native</NbBadge>
                <NbBadge variant="info" size="sm" icon="folder">Local</NbBadge>
                <span class="tabular">v{{ local.version }}</span>
              </span>
              <span v-if="local.description" class="mp-desc">{{ local.description }}</span>
              <span v-if="local.author">{{ local.author }}</span>
            </span>
          </template>
          <template #trailing>
            <NbButton
              v-if="installed.has(local.name)"
              v-nb-tooltip="{ body: 'Already active' }"
              variant="tertiary"
              size="sm"
              disabled
              icon="check"
            >
              Active
            </NbButton>
            <NbButton
              v-else
              v-nb-tooltip="!local.platform ? { body: 'No platform declared in package.json openbridge.platform' } : {}"
              variant="tertiary"
              size="sm"
              :loading="installing === local.name"
              :disabled="!!installing || !local.platform"
              :aria-label="`Activate ${local.name}`"
              @click="activateLocal(local)"
            >
              Activate
            </NbButton>
          </template>
        </NbContainedListItem>
      </NbContainedList>

      <!-- Results -->
      <div v-if="loading && results.length === 0" class="mp-loading">
        <NbInlineLoading status="active" label="Searching npm…" />
      </div>

      <NbContainedList v-if="results.length > 0" title="Plugins" class="mp-list">
        <template v-if="total > 0" #meta>
          <span class="tabular">{{ total.toLocaleString() }} found</span>
        </template>
        <NbContainedListItem v-for="pkg in results" :key="pkg.name">
          <template #leading>
            <span class="mp-avatar">
              <img
                v-if="githubAvatarUrl(pkg)"
                :src="githubAvatarUrl(pkg)!"
                :alt="pkg.name"
                class="mp-avatar-img"
                @error="($event.target as HTMLImageElement).style.display = 'none'"
              />
              <!-- fallback icon -->
              <NbIcon :name="isOpenBridge(pkg) ? 'diamond' : 'puzzle-piece'" size="sm" />
            </span>
          </template>
          {{ pkg.name }}
          <template #line>
            <span class="mp-detail">
              <span v-if="pkg.description" class="mp-desc">{{ pkg.description }}</span>
              <span class="mp-meta">
                <span class="tabular">v{{ pkg.version }}</span>
                <span v-if="authorName(pkg)">· {{ authorName(pkg) }}</span>
                <span>· {{ relativeDate(pkg.date) }}</span>
                <span v-if="pkg.weeklyDownloads" class="tabular">
                  · {{ formatDownloads(pkg.weeklyDownloads) }} weekly downloads
                </span>
                <span v-if="pkg.githubStars" class="tabular">· {{ formatDownloads(pkg.githubStars) }} stars</span>
              </span>
              <span class="mp-links">
                <NbButton
                  v-if="pkg.githubSponsorsUrl"
                  variant="link"
                  size="xs"
                  :href="pkg.githubSponsorsUrl"
                  target="_blank"
                  :aria-label="`Sponsor ${pkg.name}`"
                >
                  Sponsor
                </NbButton>
                <NbButton
                  v-if="pkg.documentationUrl"
                  variant="link"
                  size="xs"
                  :href="pkg.documentationUrl"
                  target="_blank"
                  :aria-label="`Docs for ${pkg.name}`"
                >
                  Docs
                </NbButton>
                <NbButton
                  variant="link"
                  size="xs"
                  icon="arrow-square-out"
                  :href="`https://marketplace.openbridge.nubisco.io/plugins/${pkg.name}`"
                  target="_blank"
                  :aria-label="`Marketplace page for ${pkg.name}`"
                >
                  Marketplace
                </NbButton>
              </span>
            </span>
          </template>
          <!-- Many rows, so no row's action is filled: install steps down to
               tertiary, and remove is the outlined danger it already was. -->
          <template #trailing>
            <NbButton
              v-if="installed.has(pkg.name)"
              variant="danger"
              size="sm"
              outlined
              :loading="uninstalling === pkg.name"
              :disabled="!!uninstalling"
              :aria-label="`Remove ${pkg.name}`"
              @click="uninstall(pkg.name)"
            >
              Remove
            </NbButton>
            <NbButton
              v-else
              variant="tertiary"
              size="sm"
              :loading="installing === pkg.name"
              :disabled="!!installing"
              :aria-label="`Install ${pkg.name}`"
              @click="install(pkg)"
            >
              Install
            </NbButton>
          </template>
        </NbContainedListItem>
      </NbContainedList>

      <!-- Load more -->
      <div v-if="results.length > 0 && results.length < total" class="mp-load-more">
        <NbButton variant="tertiary" size="sm" :loading="loading" :disabled="loading" @click="loadMore">
          {{ loading ? 'Loading…' : `Load more (${total - results.length} remaining)` }}
        </NbButton>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useToast } from '@nubisco/ui'
import { useDaemonStore } from '@/stores/daemon'
import { api, type NpmPackage, type LocalPlugin } from '@/api'

const daemon = useDaemonStore()
const toast = useToast()
const uninstalling = ref<string | null>(null)

// The public marketplace. Kept as a constant rather than read from the
// daemon because this panel already talks to npm directly and the daemon
// holds no marketplace address of its own.
const MARKETPLACE_URL = 'https://marketplace.openbridge.nubisco.io'

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
// Marketplace API: enriched data (stars, sponsors, reviews) is already in the response
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
  thumb_up: number
  thumb_down: number
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
    toast.success(`Installed ${pkg.name}`)
  } catch (e) {
    error.value = `Failed to install ${pkg.name}: ${e}`
    toast.error(`Failed to install ${pkg.name}`)
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
    toast.success(`Removed ${name}`)
  } catch (e) {
    error.value = `Failed to uninstall ${name}: ${e}`
    toast.error(`Failed to remove ${name}`)
  } finally {
    uninstalling.value = null
  }
}

async function activateLocal(local: LocalPlugin) {
  if (installing.value || !local.platform) return
  installing.value = local.name
  error.value = null
  try {
    // Save as a unified plugin entry in config.plugins
    await api.config.savePlugin(local.name, { platform: local.platform })
    installed.value.set(local.name, `${local.path}/dist/index.js`)
    justInstalled.value = { name: local.name, mainFile: `${local.path}/dist/index.js` }
    await daemon.fetchPlugins()
    toast.success(`Activated ${local.name}`)
  } catch (e) {
    error.value = `Failed to activate ${local.name}: ${e}`
    toast.error(`Failed to activate ${local.name}`)
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
  return pkg.name.includes('openbridge-') || (Array.isArray(pkg.badges) && pkg.badges.includes('openbridge-plugin'))
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

<style lang="scss" scoped>
.mp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

// Pinned above the scrolling list, like every inspector's own header.
.mp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--nb-spacing-8);
  padding: var(--nb-spacing-12);
  border-bottom: 1px solid var(--nb-c-layer-1);
  flex-shrink: 0;
}

.mp-title {
  margin: 0;
  color: var(--nb-c-text);
}

.mp-top {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-8);
  padding: var(--nb-spacing-12) var(--nb-spacing-12) 0;
  flex-shrink: 0;
}

// On a phone the sheet's dismiss button sits over the top right corner, where
// the Marketplace link is, so the header keeps clear of it.
@include variables.phone {
  .mp-header {
    padding-right: calc(var(--nb-spacing-12) + var(--nb-shell-inspector-dismiss-inset, 0px));
  }
}

// The rows carry 8 of their own inset, so 4 here puts their text on the same
// 12 edge as the header and the search above.
.mp-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-12);
  padding: var(--nb-spacing-12) var(--nb-spacing-4);
}

.mp-loading {
  display: flex;
  justify-content: center;
  padding: var(--nb-spacing-48) var(--nb-spacing-16);
}

.mp-avatar {
  position: relative;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--nb-radius-md);
  background: var(--nb-c-layer-2);
  color: var(--nb-c-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.mp-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 1;
}

// NbContainedListItem keeps its line to one, ellipsised. A result needs its
// description, its facts and its links, so this block wraps inside it.
.mp-detail {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-4);
  padding-top: var(--nb-spacing-2);
  white-space: normal;
}

.mp-badges,
.mp-meta,
.mp-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--nb-spacing-4);
}

.mp-meta {
  color: var(--nb-c-text-subtle);
}

.mp-links {
  gap: var(--nb-spacing-8);
}

.mp-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mp-load-more {
  display: flex;
  justify-content: center;
}
</style>
