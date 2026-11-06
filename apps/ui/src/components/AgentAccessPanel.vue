<template>
  <!-- Three sections of the settings page (SettingsView.vue): the endpoint,
       then each table as its own object with its title and its one action on
       the table. A data table paints its own surface, so nothing is boxed. -->
  <div class="agents">
    <section class="agents__section" aria-labelledby="agents-title">
      <header>
        <h2 id="agents-title" class="type-heading-02 agents__title">AI agents</h2>
        <p class="type-body-sm agents__lede">
          Let Claude and other MCP clients read your devices and their history, and with control access, operate them.
        </p>
      </header>

      <!-- Off by default: nothing here works until the owner turns it on. -->
      <NbMessage v-if="enabled === false" variant="helper" class="agents__form">
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
              <NbTextInput :id="id" :model-value="freshToken" readonly class="agents__mono" />
              <NbCopyButton :text="freshToken" label="Copy" copied-label="Copied" />
            </div>
          </NbField>
          <NbField v-slot="{ id }" label="Connect Claude Code" orientation="stack">
            <div class="agents__reveal">
              <NbTextInput :id="id" :model-value="cliCommand(freshToken)" readonly class="agents__mono" />
              <NbCopyButton :text="cliCommand(freshToken)" label="Copy" copied-label="Copied" />
            </div>
          </NbField>
        </NbBanner>

        <NbField v-slot="{ id }" label="MCP endpoint" orientation="stack" class="agents__form">
          <div class="agents__reveal">
            <NbTextInput :id="id" :model-value="endpoint" readonly class="agents__mono" />
            <NbCopyButton :text="endpoint" label="Copy" copied-label="Copied" />
          </div>
        </NbField>
        <NbMessage variant="helper" class="agents__form">
          Every request needs a token, even when sign-in is off. Create one below and paste it into your client, or add
          the endpoint as a connector and approve it in your browser. claude.ai and the Claude app connect from the
          cloud, so their connectors need this bridge on an https address reachable from the internet.
          <a href="https://docs.nubisco.io/openbridge/guide/mcp" target="_blank" rel="noopener">How to connect</a>
        </NbMessage>
      </template>

      <NbMessage v-if="error" variant="error" class="agents__form">{{ error }}</NbMessage>
    </section>

    <template v-if="enabled">
      <!-- Revoke and Disconnect stay worded: no icon is agreed for either yet
           (a library gap), and each names its row for a screen reader. -->
      <NbDataTable
        stack-on-phone
        :columns="tokenColumns"
        :rows="tokenRows"
        row-key="id"
        size="sm"
        title="Tokens"
        description="Each one lets a client such as Claude Code use this bridge, read only or with control."
        :loading="loading"
      >
        <template #toolbar-actions>
          <NbButton variant="primary" icon="plus" @click="creating = true">New token</NbButton>
        </template>
        <template #row-actions="{ row }">
          <NbButton
            size="sm"
            variant="ghost"
            :aria-label="`Revoke token ${row.name}`"
            @click="revokeToken(String(row.id), String(row.name))"
          >
            Revoke
          </NbButton>
        </template>
        <template #empty>
          <NbEmptyState
            size="sm"
            title="No tokens yet"
            description="Create one to connect Claude Code or another MCP client."
          />
        </template>
      </NbDataTable>

      <NbDataTable
        stack-on-phone
        :columns="connectionColumns"
        :rows="connectionRows"
        row-key="clientId"
        size="sm"
        title="Connected applications"
        description="Applications approved through a connector sign-in. Disconnecting one ends every sign-in it holds."
        :loading="loading"
      >
        <template #row-actions="{ row }">
          <NbButton
            size="sm"
            variant="ghost"
            :aria-label="`Disconnect ${row.name}`"
            @click="disconnect(String(row.clientId), String(row.name))"
          >
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

    <NewTokenModal :open="creating" @close="creating = false" @created="onCreated" />
  </div>
</template>

<script setup lang="ts">
/**
 * Tokens and connections for the MCP endpoint, after Tally's Your settings
 * (tally/apps/web/src/views/PersonalSettingsView.vue). A bridge belongs to one
 * household, so this lists every token on it, not only the viewer's.
 */
import { computed, onMounted, ref } from 'vue'
import { useConfirm, useToast } from '@nubisco/ui'
import { api, type AccessConnection, type AccessToken } from '@/api'
import NewTokenModal from '@/components/NewTokenModal.vue'

const confirm = useConfirm()
const toast = useToast()

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
    toast.success('Token revoked')
    await load()
  } catch (e) {
    toast.error((e as Error).message, { title: 'Could not revoke' })
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
    toast.success(`${name} disconnected`)
    await load()
  } catch (e) {
    toast.error((e as Error).message, { title: 'Could not disconnect' })
  }
}
</script>

<style lang="scss" scoped>
// Part of the settings column (SettingsView.vue): the same 32px between
// sections, and the same 40rem measure on the form parts. The tables take the
// column's full width because they need it.
.agents {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-32);

  &__section {
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-16);
  }

  &__title {
    margin: 0;
  }

  &__lede {
    max-inline-size: var(--nb-measure);
    margin: var(--nb-spacing-4) 0 0;
    color: var(--nb-c-text-muted);
  }

  &__form {
    max-inline-size: 40rem;
  }

  &__reveal {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);

    > :first-child {
      flex: 1;
      min-width: 0;
    }
  }

  &__mono :deep(input) {
    font-family: var(--nb-font-family-mono);
  }
}
</style>
