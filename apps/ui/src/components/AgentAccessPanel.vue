<template>
  <NbPanel class="agents">
    <div class="agents__header">
      <div class="agents__icon">
        <NbIcon name="robot" :size="18" />
      </div>
      <div>
        <h2 class="agents__title">AI agents</h2>
        <p class="agents__subtitle">
          Let Claude and other MCP clients read your devices and their history, and with control access, operate them.
        </p>
      </div>
    </div>

    <!-- Off by default: nothing here works until the owner turns it on. -->
    <NbMessage v-if="enabled === false" variant="helper">
      The MCP endpoint is off on this bridge. Start OpenBridge with
      <code>OPENBRIDGE_MCP=on</code>
      in its environment to turn it on, then create a token here.
      <a href="https://docs.nubisco.io/openbridge/guide/mcp" target="_blank" rel="noopener">How to turn it on</a>
    </NbMessage>

    <template v-if="enabled">
      <NbBanner
        v-if="freshToken"
        status="info"
        variant="inline"
        title="Copy this token now. It is not shown again."
        dismissible
        @close="freshToken = ''"
      >
        <NbField v-slot="{ id }" label="Token" orientation="stack">
          <div class="agents__reveal">
            <NbTextInput :id="id" :model-value="freshToken" readonly size="sm" class="agents__mono" />
            <NbCopyButton :text="freshToken" label="Copy" copied-label="Copied" />
          </div>
        </NbField>
        <NbField v-slot="{ id }" label="Connect Claude Code" orientation="stack">
          <div class="agents__reveal">
            <NbTextInput :id="id" :model-value="cliCommand(freshToken)" readonly size="sm" class="agents__mono" />
            <NbCopyButton :text="cliCommand(freshToken)" label="Copy" copied-label="Copied" />
          </div>
        </NbField>
      </NbBanner>

      <NbField v-slot="{ id }" label="MCP endpoint" orientation="stack">
        <div class="agents__reveal">
          <NbTextInput :id="id" :model-value="endpoint" readonly size="sm" class="agents__mono" />
          <NbCopyButton :text="endpoint" label="Copy" copied-label="Copied" />
        </div>
      </NbField>
      <NbMessage variant="helper">
        Every request needs a token, even when sign-in is off. Create one below and paste it into your client, or add
        the endpoint as a connector and approve it in your browser. claude.ai and the Claude app connect from the cloud,
        so their connectors need this bridge on an https address reachable from the internet.
        <a href="https://docs.nubisco.io/openbridge/guide/mcp" target="_blank" rel="noopener">How to connect</a>
      </NbMessage>

      <div class="agents__section-head">
        <h3 class="agents__section-title">Tokens</h3>
        <NbButton size="sm" variant="primary" icon="plus" @click="creating = true">New token</NbButton>
      </div>
      <NbDataTable
        stack-on-phone
        :columns="tokenColumns"
        :rows="tokenRows"
        row-key="id"
        size="sm"
        aria-label="Tokens"
        :loading="loading"
      >
        <template #cell-actions="{ row }">
          <NbButton size="sm" variant="ghost" @click="revokeToken(String(row.id), String(row.name))">Revoke</NbButton>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No tokens yet"
            description="Create one to connect Claude Code or another MCP client."
          />
        </template>
      </NbDataTable>

      <h3 class="agents__section-title">Connected applications</h3>
      <NbDataTable
        stack-on-phone
        :columns="connectionColumns"
        :rows="connectionRows"
        row-key="clientId"
        size="sm"
        aria-label="Connected applications"
        :loading="loading"
      >
        <template #cell-actions="{ row }">
          <NbButton size="sm" variant="ghost" @click="disconnect(String(row.clientId), String(row.name))">
            Disconnect
          </NbButton>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="Nothing connected"
            description="Applications you approve through a connector sign-in appear here."
          />
        </template>
      </NbDataTable>
    </template>

    <NbMessage v-if="error" variant="error">{{ error }}</NbMessage>

    <NewTokenModal :open="creating" @close="creating = false" @created="onCreated" />
  </NbPanel>
</template>

<script setup lang="ts">
/**
 * Tokens and connections for the MCP endpoint, after Tally's Your settings
 * (tally/apps/web/src/views/PersonalSettingsView.vue). A bridge belongs to one
 * household, so this lists every token on it, not only the viewer's.
 */
import { computed, onMounted, ref } from 'vue'
import { useConfirm } from '@nubisco/ui'
import { api, type AccessConnection, type AccessToken } from '@/api'
import { useNotifications } from '@/composables/useNotifications'
import NewTokenModal from '@/components/NewTokenModal.vue'

const confirm = useConfirm()
const notify = useNotifications()

/** Null until the daemon has answered, so neither state flashes first. */
const enabled = ref<boolean | null>(null)
const endpoint = ref(`${location.origin}/mcp`)
const tokens = ref<AccessToken[]>([])
const connections = ref<AccessConnection[]>([])
const loading = ref(false)
const error = ref('')
const creating = ref(false)
const freshToken = ref('')

const cliCommand = (token: string) =>
  `claude mcp add --transport http openbridge ${endpoint.value} --header "Authorization: Bearer ${token}"`

const accessLabel = (a: 'read' | 'control') => (a === 'control' ? 'Read and control' : 'Read only')
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Never')

const tokenColumns = [
  { key: 'name', header: 'Name', primary: true },
  { key: 'access', header: 'Access' },
  { key: 'created', header: 'Created', phoneMeta: true },
  // Never used is what makes a forgotten token safe to revoke.
  { key: 'lastUsed', header: 'Last used' },
  { key: 'actions', header: '', align: 'right' as const },
]
const tokenRows = computed(() =>
  tokens.value.map((t) => ({
    id: t.id,
    name: t.owner ? `${t.name} (${t.owner})` : t.name,
    access: accessLabel(t.access),
    created: date(t.createdAt),
    lastUsed: date(t.lastUsedAt),
  })),
)

const connectionColumns = [
  { key: 'name', header: 'Application', primary: true },
  { key: 'access', header: 'Access' },
  { key: 'connected', header: 'Connected', phoneMeta: true },
  { key: 'lastUsed', header: 'Last used' },
  { key: 'actions', header: '', align: 'right' as const },
]
const connectionRows = computed(() =>
  connections.value.map((c) => ({
    clientId: c.clientId,
    name: c.owners.length ? `${c.name} (${c.owners.join(', ')})` : c.name,
    access: accessLabel(c.access),
    connected: date(c.connectedAt),
    lastUsed: date(c.lastUsedAt),
  })),
)

async function load() {
  loading.value = true
  try {
    const data = await api.access.get()
    enabled.value = data.enabled
    if (data.enabled) {
      endpoint.value = data.endpoint
      tokens.value = data.tokens
      connections.value = data.connections
    }
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

function onCreated(token: string) {
  creating.value = false
  freshToken.value = token
  void load()
}

async function revokeToken(id: string, name: string) {
  const ok = await confirm({
    title: 'Revoke token',
    subjectLabel: 'Token',
    subject: name,
    message: 'Anything using this token loses access immediately.',
    confirmLabel: 'Revoke',
  })
  if (!ok) return
  try {
    await api.access.revokeToken(id)
    notify.success('Token revoked')
    await load()
  } catch (e) {
    notify.error((e as Error).message, { title: 'Could not revoke' })
  }
}

async function disconnect(clientId: string, name: string) {
  const ok = await confirm({
    title: 'Disconnect application',
    subjectLabel: 'Application',
    subject: name,
    message: 'Every sign-in this application holds stops working, including its refresh tokens.',
    confirmLabel: 'Disconnect',
  })
  if (!ok) return
  try {
    await api.access.revokeConnection(clientId)
    notify.success(`${name} disconnected`)
    await load()
  } catch (e) {
    notify.error((e as Error).message, { title: 'Could not disconnect' })
  }
}
</script>

<style lang="scss" scoped>
// Matches the other Settings cards (SettingsView.vue), and spans the whole
// row because its tables need the width.
.agents {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 1rem;

  &__header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  &__icon {
    width: 36px;
    height: 36px;
    border-radius: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--nb-c-primary) 12%, var(--nb-c-surface));
    color: var(--nb-c-primary);
    flex-shrink: 0;
  }

  &__title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--nb-c-text);
  }

  &__subtitle {
    margin: 0;
    font-size: 0.78rem;
    color: var(--nb-c-text-muted);
  }

  &__section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  &__section-title {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--nb-c-text);
  }

  &__reveal {
    display: flex;
    align-items: center;
    gap: 0.4rem;

    > :first-child {
      flex: 1;
      min-width: 0;
    }
  }

  &__mono :deep(input) {
    font-family: monospace;
  }
}
</style>
