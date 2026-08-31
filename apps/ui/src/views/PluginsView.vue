<template>
  <div class="plugins-view">
    <Teleport defer to="#ob-topbar-right">
      <NbTextInput v-model="search" placeholder="Search plugins..." size="sm" style="width: 200px" />
      <NbButton
        variant="ghost"
        size="sm"
        icon="arrow-clockwise"
        title="Refresh metadata"
        :loading="refreshingMetadata"
        :disabled="refreshingMetadata"
        @click="refreshPluginMetadata(true)"
      />
      <NbButton
        variant="ghost"
        size="sm"
        :icon="view === 'cards' ? 'list' : 'squares-four'"
        :title="view === 'cards' ? 'Show as table' : 'Show as cards'"
        @click="toggleView"
      />
      <NbButton variant="primary" size="sm" icon="magnifying-glass" @click="inspector.openMarketplace()">
        Browse plugins
      </NbButton>
    </Teleport>

    <div v-if="rows.length === 0" class="empty-state">
      <NbIcon name="puzzle-piece" :size="40" />
      <p v-if="search">No plugins matching "{{ search }}"</p>
      <template v-else>
        <p>No plugins loaded yet.</p>
        <NbButton variant="primary" size="sm" icon="magnifying-glass" @click="inspector.openMarketplace()">
          Browse &amp; install plugins
        </NbButton>
      </template>
    </div>

    <PluginList v-else :rows="rows" :view="view" :selected-id="selectedId" @select="selectPlugin" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useDaemonStore } from '@/stores/daemon'
import { useInspectorStore } from '@/stores/inspector'
import { useLayoutStore } from '@/stores/layout'
import { api, type NpmPackage } from '@/api'
import { useNotifications } from '@/composables/useNotifications'
import PluginList, { type PluginRow } from '@/components/PluginList.vue'
import type { PluginInstance } from '@/api'

const daemon = useDaemonStore()
const inspector = useInspectorStore()
const layout = useLayoutStore()
const notify = useNotifications()
const search = ref('')
const enriched = ref(new Map<string, NpmPackage>())
const loadingEnriched = ref(new Set<string>())
const refreshingMetadata = ref(false)

// ─── Card / table presentation ──────────────────────────────────────────────
// A viewing preference, so it belongs to the user rather than to the session.
const VIEW_KEY = 'openbridge.plugins.view'
const view = ref<'cards' | 'table'>(localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards')

function toggleView() {
  view.value = view.value === 'cards' ? 'table' : 'cards'
  localStorage.setItem(VIEW_KEY, view.value)
}

const selectedId = computed(() =>
  inspector.visible && inspector.mode === 'plugin' ? (inspector.selectedPlugin?.id ?? null) : null,
)

// Resolving avatars and npm metadata stays here (it owns the caches); the list
// component just renders what it is handed.
const rows = computed<PluginRow[]>(() =>
  filtered().map((plugin) => {
    const meta = pluginEnriched(plugin)
    return {
      plugin,
      avatarUrl: avatarUrl(plugin),
      isOpenBridge: isOpenBridge(plugin),
      sponsorUrl: meta?.githubSponsorsUrl,
      docsUrl: meta?.documentationUrl,
    }
  }),
)

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

<style lang="scss" scoped>
.plugins-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 4rem;
  color: var(--nb-c-text-subtle);
  text-align: center;
  border: 1px dashed var(--nb-c-border);
  border-radius: 12px;
  p {
    margin: 0;
    font-size: 0.875rem;
  }
}
</style>
