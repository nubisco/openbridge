<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { api, type NpmPackage } from '@/api'
import { useNotifications } from '@/composables/useNotifications'
import type { PluginInstance } from '@/api'

const daemon = useDaemonStore()
const inspector = useInspectorStore()
const layout = useLayoutStore()
const notify = useNotifications()
const search = ref('')
const enriched = ref(new Map<string, NpmPackage>())
const loadingEnriched = ref(new Set<string>())
const refreshingMetadata = ref(false)

function packageNameFor(plugin: PluginInstance): string {
  // Homebridge instances now expose npm package name in manifest.name.
  // Keep a legacy fallback for older descriptions during transition.
  if (plugin.source === 'homebridge') {
    const desc = plugin.manifest.description ?? ''
    const m = desc.match(/Homebridge platform:\s*([^\s]+)/)
    if (m?.[1]) return m[1]
  }
  return plugin.manifest.name
}

function metadataCandidatesFor(plugin: PluginInstance): string[] {
  const desc = plugin.manifest.description ?? ''
  const fromLegacyDesc = desc.match(/Homebridge platform:\s*([^\s]+)/)?.[1]
  const candidates = [packageNameFor(plugin), fromLegacyDesc, plugin.manifest.name, plugin.id]
  return Array.from(new Set(candidates.filter((v): v is string => !!v && v.trim().length > 0)))
}

function filtered() {
  const q = search.value.toLowerCase()
  return daemon.plugins.filter(
    (p) => p.manifest.name.toLowerCase().includes(q) || (p.manifest.description ?? '').toLowerCase().includes(q),
  )
}

function selectPlugin(plugin: PluginInstance) {
  if (inspector.selectedPlugin?.id === plugin.id && inspector.visible && inspector.mode === 'plugin') {
    inspector.close()
  } else {
    inspector.openPlugin(plugin)
  }
}

function isOpenBridge(plugin: PluginInstance) {
  return plugin.manifest.name.includes('openbridge-') || plugin.source === 'native'
}

function pluginEnriched(plugin: PluginInstance): NpmPackage | undefined {
  // Prefer in-memory refreshed metadata first.
  const candidates = metadataCandidatesFor(plugin)
  for (const c of candidates) {
    const data = enriched.value.get(c)
    if (data) return data
  }
  // Fall back to stored metadata coming from daemon cache.
  if (plugin.enrichedMetadata) {
    return plugin.enrichedMetadata as unknown as NpmPackage
  }
  return undefined
}

async function fetchEnrichedForPlugin(plugin: PluginInstance, force = false) {
  const candidates = metadataCandidatesFor(plugin)
  for (const name of candidates) {
    if (!force && enriched.value.has(name)) continue
    if (!force && loadingEnriched.value.has(name)) continue
    loadingEnriched.value.add(name)
    try {
      const data = await api.marketplace.enriched(name)
      const next = new Map(enriched.value)
      next.set(name, data)
      // Also store under canonical package key to stabilize lookups.
      next.set(packageNameFor(plugin), data)
      enriched.value = next

      // Keep plugin instance in sync so template immediately reflects persisted metadata.
      plugin.enrichedMetadata = data as unknown as Record<string, unknown>

      if (data.documentationUrl || data.githubSponsorsUrl || data.links?.repository) {
        return
      }
    } catch {
      /* ignore */
    } finally {
      const next = new Set(loadingEnriched.value)
      next.delete(name)
      loadingEnriched.value = next
    }
  }
}

// Cache of packageName → resolved avatar URL (empty string = no avatar)
const avatarCache = ref(new Map<string, string>())

function githubAvatarFromRepositoryUrl(repoUrl: string): string | null {
  const normalized = repoUrl
    .trim()
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
  const m = normalized.match(/github\.com[/:]([^/]+)/)
  return m ? `https://github.com/${m[1]}.png?size=48` : null
}

function avatarUrl(plugin: PluginInstance): string | null {
  const enrichedMeta = pluginEnriched(plugin)
  const repo = enrichedMeta?.links?.repository ?? enrichedMeta?.links?.homepage ?? ''
  if (repo) {
    const fromEnriched = githubAvatarFromRepositoryUrl(repo)
    if (fromEnriched) return fromEnriched
  }

  const candidates = metadataCandidatesFor(plugin)
  for (const c of candidates) {
    const url = avatarCache.value.get(c)
    if (url) return url
  }
  return null
}

async function fetchAvatarFor(name: string, force = false) {
  if (!force && avatarCache.value.has(name)) return
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      avatarCache.value.set(name, '')
      return
    }
    const data = await res.json()
    const repoUrl: string = data?.repository?.url ?? data?.homepage ?? ''
    avatarCache.value.set(name, githubAvatarFromRepositoryUrl(repoUrl) ?? '')
  } catch {
    avatarCache.value.set(name, '')
  }
}

async function refreshPluginMetadata(force = false) {
  if (refreshingMetadata.value) return
  refreshingMetadata.value = true
  try {
    if (force) {
      enriched.value = new Map()
      avatarCache.value = new Map()
    }
    const plugins = daemon.plugins
    for (const plugin of plugins) {
      const candidates = metadataCandidatesFor(plugin)
      for (const c of candidates) {
        await fetchAvatarFor(c, force)
      }
      await fetchEnrichedForPlugin(plugin, force)
    }
    if (force) notify.success('Plugin metadata refreshed')
  } catch {
    notify.error('Failed to refresh plugin metadata')
  } finally {
    refreshingMetadata.value = false
  }
}

onMounted(async () => {
  await daemon.fetchPlugins()
})

watch(
  () => daemon.plugins.length,
  (n) => {
    layout.setPage('Plugins', n)
  },
  { immediate: true },
)
</script>

<template>
  <div class="plugins-view">
    <div class="plugins-toolbar">
      <NbTextInput v-model="search" placeholder="Search plugins..." size="sm" style="width: 240px" />
      <NbButton
        variant="ghost"
        size="sm"
        icon="arrow-clockwise"
        :loading="refreshingMetadata"
        :disabled="refreshingMetadata"
        @click="refreshPluginMetadata(true)"
      >
        Refresh metadata
      </NbButton>
      <div class="toolbar-spacer" />
      <NbButton variant="primary" size="sm" icon="magnifying-glass" @click="inspector.openMarketplace()">
        Browse plugins
      </NbButton>
    </div>

    <div v-if="filtered().length === 0" class="empty-state">
      <NbIcon name="puzzle-piece" :size="40" />
      <p v-if="search">No plugins matching "{{ search }}"</p>
      <template v-else>
        <p>No plugins loaded yet.</p>
        <NbButton variant="primary" size="sm" icon="magnifying-glass" @click="inspector.openMarketplace()">
          Browse &amp; install plugins
        </NbButton>
      </template>
    </div>

    <div v-else class="plugin-cards">
      <div
        v-for="plugin in filtered()"
        :key="plugin.id"
        class="plugin-card"
        :class="[
          `plugin-card--${plugin.status}`,
          {
            selected: inspector.selectedPlugin?.id === plugin.id && inspector.visible && inspector.mode === 'plugin',
            'plugin-card--ob': isOpenBridge(plugin),
          },
        ]"
        @click="selectPlugin(plugin)"
      >
        <div class="plugin-card-header">
          <div class="plugin-avatar" :class="`plugin-avatar--${plugin.status}`">
            <img
              v-if="avatarUrl(plugin)"
              :src="avatarUrl(plugin)!"
              :alt="plugin.manifest.name"
              class="plugin-avatar-img"
              @error="($event.target as HTMLImageElement).style.display = 'none'"
            />
            <NbIcon v-if="!avatarUrl(plugin) && isOpenBridge(plugin)" name="diamond" :size="20" />
            <NbIcon v-else-if="!avatarUrl(plugin)" name="puzzle-piece" :size="20" />
          </div>
          <div class="plugin-meta">
            <div class="plugin-name">{{ plugin.manifest.name }}</div>
            <div v-if="plugin.source === 'homebridge' && plugin.platformName" class="plugin-platform">
              Platform: {{ plugin.platformName }}
            </div>
            <div class="plugin-version">
              v{{ plugin.manifest.version }}
              <span
                v-if="plugin.availableUpdate"
                class="update-badge"
                :title="'Update available: v' + plugin.availableUpdate"
              >
                v{{ plugin.availableUpdate }} available
              </span>
            </div>
          </div>
          <div class="plugin-status-badge" :class="plugin.status">{{ plugin.status }}</div>
        </div>

        <p v-if="plugin.manifest.description" class="plugin-desc">{{ plugin.manifest.description }}</p>
        <p v-if="plugin.manifest.author" class="plugin-author">by {{ plugin.manifest.author }}</p>
        <div v-if="pluginEnriched(plugin)" class="plugin-enriched">
          <a
            v-if="pluginEnriched(plugin)?.githubSponsorsUrl"
            :href="pluginEnriched(plugin)?.githubSponsorsUrl"
            class="plugin-stat plugin-stat--link"
            target="_blank"
            rel="noopener"
            @click.stop
          >
            <NbIcon name="heart" weight="fill" :size="11" />
            Sponsor
          </a>
          <a
            v-if="pluginEnriched(plugin)?.documentationUrl"
            :href="pluginEnriched(plugin)?.documentationUrl"
            class="plugin-stat plugin-stat--link"
            target="_blank"
            rel="noopener"
            @click.stop
          >
            <NbIcon name="book-open" :size="11" />
            Docs
          </a>
        </div>
        <div v-if="plugin.error" class="plugin-error">{{ plugin.error }}</div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.plugins-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.plugins-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.toolbar-spacer {
  flex: 1;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 4rem;
  color: #9ca3af;
  text-align: center;
  border: 1px dashed #e8e8f0;
  border-radius: 12px;
  p {
    margin: 0;
    font-size: 0.875rem;
  }
}

.plugin-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.plugin-card {
  background: #fff;
  border: 1.5px solid #e8e8f0;
  border-radius: 12px;
  padding: 1rem;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;

  &:hover {
    border-color: #c4b5fd;
    box-shadow: 0 2px 12px rgba(124, 58, 237, 0.08);
  }
  &.selected {
    border-color: #7c3aed;
    box-shadow: 0 2px 12px rgba(124, 58, 237, 0.15);
  }

  // Status border coloring (left accent)
  border-left-width: 3px;
  &--running {
    border-left-color: var(--nb-c-success, #10b981);
  }
  &--error {
    border-left-color: var(--nb-c-danger, #ef4444);
  }
  &--loading {
    border-left-color: var(--nb-c-warning, #f59e0b);
  }
  &--stopped,
  &--idle {
    border-left-color: #e8e8f0;
  }

  &--ob {
    background: linear-gradient(145deg, rgba(124, 58, 237, 0.04) 0%, #fff 60%);
    &:hover {
      border-color: #7c3aed;
      box-shadow: 0 2px 16px rgba(124, 58, 237, 0.18);
    }
  }
}

.plugin-card-header {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.plugin-avatar {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f0f0f8;
  color: #6b7280;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  overflow: hidden;
  position: relative;

  // Status only affects the icon color, not background
  &--running {
    color: var(--nb-c-success, #10b981);
  }
  &--error {
    color: var(--nb-c-danger, #ef4444);
  }
  &--loading {
    color: var(--nb-c-warning, #f59e0b);
  }

  &--ob {
    // OB plugins keep their purple gradient
    background: linear-gradient(135deg, #7c3aed, #4f46e5) !important;
    color: #fff !important;
  }
}

.plugin-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
  z-index: 1;
}

.plugin-meta {
  flex: 1;
  min-width: 0;
}
.plugin-name {
  font-weight: 600;
  font-size: 0.875rem;
  color: #111827;
}
.plugin-version {
  font-size: 0.75rem;
  color: #9ca3af;
  display: flex;
  align-items: center;
  gap: 6px;
}

.update-badge {
  font-size: 0.65rem;
  font-weight: 600;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
  padding: 1px 6px;
  border-radius: 4px;
}

.plugin-platform {
  font-size: 0.7rem;
  color: #6b7280;
}

.plugin-status-badge {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: #f3f4f6;
  color: #6b7280;
  &.running {
    background: #d1fae5;
    color: #065f46;
  }
  &.error {
    background: #fee2e2;
    color: #991b1b;
  }
  &.loading {
    background: #fef3c7;
    color: #92400e;
  }
}

.plugin-badges {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
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

.plugin-desc {
  font-size: 0.82rem;
  color: #6b7280;
  margin: 0;
  line-height: 1.4;
}
.plugin-author {
  font-size: 0.75rem;
  color: #9ca3af;
  margin: 0;
}

.plugin-enriched {
  margin-top: 0.2rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.plugin-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.65rem;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 0.14rem 0.36rem;
}

.plugin-stat--link {
  text-decoration: none;
  color: #7c3aed;
  background: rgba(124, 58, 237, 0.08);
  border: 1px solid rgba(124, 58, 237, 0.2);
}

.plugin-error {
  font-size: 0.78rem;
  color: #dc2626;
  background: #fef2f2;
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
}
</style>
