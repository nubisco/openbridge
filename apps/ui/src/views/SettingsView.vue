<template>
  <div class="settings-view">
    <!-- Bridge Settings -->
    <NbPanel class="settings-card">
      <div class="card-header">
        <div class="card-icon">
          <NbIcon name="bridge" :size="18" />
        </div>
        <div>
          <h2 class="card-title">Bridge</h2>
          <p class="card-subtitle">HomeKit bridge identity and network settings</p>
        </div>
      </div>

      <!-- NbField supplies the label column every row lines up on, so the
           fields need no width or alignment CSS of their own. -->
      <NbGrid dir="col" gap="sm" class="field-grid">
        <NbField label="Bridge name" hint="Displayed in the Home app">
          <NbTextInput v-model="bridge.name" size="sm" placeholder="OpenBridge" />
        </NbField>

        <NbField label="HTTP port" hint="OpenBridge web UI &amp; API" control="fit">
          <NbNumberInput v-model="bridge.port" size="sm" :min="1024" :max="65535" />
        </NbField>

        <NbField label="HAP port" hint="HomeKit accessory protocol port" control="fit">
          <NbNumberInput v-model="bridge.hapPort" size="sm" :min="1024" :max="65535" />
        </NbField>

        <NbField label="PIN code" hint="Format: XXX-XX-XXX, used to pair with HomeKit">
          <div class="pin-row">
            <NbTextInput v-model="bridge.pincode" size="sm" placeholder="031-45-154" />
            <NbButton
              variant="ghost"
              size="sm"
              icon="arrows-clockwise"
              title="Generate random PIN"
              @click="generatePin"
            />
          </div>
        </NbField>

        <NbField
          label="Bridge MAC"
          hint="Leave empty to auto-generate. Change this only if pairing with HomeKit fails."
        >
          <NbTextInput v-model="bridge.username" size="sm" class="mono" placeholder="AA:BB:CC:DD:EE:FF" />
        </NbField>

        <NbField label="Log level" control="fit">
          <NbSelect v-model="bridge.logLevel" size="sm" :options="logLevelOptions" />
        </NbField>
      </NbGrid>

      <NbMessage v-if="error" variant="error">{{ error }}</NbMessage>

      <div class="card-actions">
        <NbButton variant="primary" size="sm" :loading="saving" :icon="saved ? 'check' : 'floppy-disk'" @click="save">
          {{ saved ? 'Saved!' : 'Save' }}
        </NbButton>
        <NbButton
          variant="secondary"
          size="sm"
          outlined
          :loading="restarting"
          :icon="restarting ? 'spinner' : 'arrows-clockwise'"
          @click="restart"
        >
          {{ restarting ? 'Restarting…' : 'Save & Restart OpenBridge' }}
        </NbButton>
        <span v-if="saved && !restarting" class="action-hint">
          <NbIcon name="info" :size="12" />
          Restart the daemon for changes to take effect
        </span>
      </div>
    </NbPanel>

    <!-- Updates -->
    <NbPanel class="settings-card">
      <div class="card-header">
        <div class="card-icon">
          <NbIcon name="arrow-circle-up" :size="18" />
        </div>
        <div>
          <h2 class="card-title">Updates</h2>
          <p class="card-subtitle">OpenBridge daemon and UI</p>
        </div>
      </div>

      <div class="update-row">
        <div class="update-versions">
          <NbBadge variant="grey">Current: v{{ updateStatus?.current ?? '…' }}</NbBadge>
          <template v-if="updateStatus && !checkingUpdate">
            <NbBadge v-if="updateStatus.updateAvailable" variant="blue">Available: v{{ updateStatus.latest }}</NbBadge>
            <NbBadge v-else-if="updateStatus.latest === null" variant="orange">Unable to check</NbBadge>
            <NbBadge v-else variant="green">Up to date</NbBadge>
          </template>
          <NbBadge v-if="checkingUpdate" variant="grey">Checking…</NbBadge>
        </div>

        <div class="update-actions">
          <NbButton
            variant="secondary"
            size="sm"
            outlined
            :loading="checkingUpdate"
            icon="arrows-clockwise"
            @click="checkUpdate"
          >
            Check
          </NbButton>
          <NbButton
            v-if="updateStatus?.updateAvailable"
            variant="primary"
            size="sm"
            :loading="applying"
            :icon="applying ? 'spinner' : 'arrow-circle-up'"
            @click="applyUpdate"
          >
            {{ applying ? 'Updating…' : 'Install update' }}
          </NbButton>
        </div>
      </div>

      <!-- Only the download stage reports real progress; the later stages are
           indeterminate, which NbProgressBar shows by omitting `value`. -->
      <NbProgressBar
        v-if="applying && updateStage"
        :label="updateMessage"
        :value="updateStage === 'downloading' && updateProgressPct > 0 ? updateProgressPct : undefined"
        :max="100"
        status="active"
        size="sm"
      />

      <NbMessage v-if="applying && !updateStage" variant="helper">
        Starting update... This page will reconnect automatically.
      </NbMessage>

      <NbMessage v-if="updateStatus?.updateMethod === 'manual' && updateStatus.updateAvailable" variant="helper">
        Self-update is not available. Pull the latest Docker image to update:
        <code>docker pull ghcr.io/nubisco/openbridge:latest</code>
      </NbMessage>

      <div v-if="updateError" class="update-error-row">
        <NbMessage variant="error">{{ updateError }}</NbMessage>
        <NbButton variant="ghost" size="sm" @click="rollbackUpdate">Rollback</NbButton>
      </div>
    </NbPanel>

    <!-- HAP pairing info -->
    <NbPanel class="settings-card info-card">
      <h3 class="info-title">
        <NbIcon name="info" :size="14" />
        How to pair with HomeKit
      </h3>
      <ol class="info-list">
        <li>
          Open the
          <strong>Home</strong>
          app on your iPhone or iPad
        </li>
        <li>
          Tap
          <strong>+</strong>
          →
          <strong>Add Accessory</strong>
        </li>
        <li>
          Scan the QR code from the Dashboard, or tap
          <strong>More options</strong>
          and enter the PIN code manually
        </li>
        <li>If you change the PIN or username, unpair first from the Home app, then re-pair</li>
      </ol>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api, type BridgeConfig, type UpdateStatus } from '@/api'
import { useLayoutStore } from '@/stores/layout'

const layout = useLayoutStore()

const logLevelOptions = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
]
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const restarting = ref(false)

// ─── Updates ─────────────────────────────────────────────────────────────────
const updateStatus = ref<UpdateStatus | null>(null)
const checkingUpdate = ref(false)
const applying = ref(false)
const updateError = ref<string | null>(null)
const updateStage = ref('')
const updateProgressPct = ref(0)
const updateMessage = ref('')
let updateWs: WebSocket | null = null

async function checkUpdate() {
  checkingUpdate.value = true
  updateError.value = null
  try {
    updateStatus.value = await api.updates.check()
  } catch (e) {
    updateError.value = String(e)
  } finally {
    checkingUpdate.value = false
  }
}

function connectUpdateWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  updateWs = new WebSocket(`${proto}://${location.host}/ws/updates`)
  updateWs.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      updateStage.value = msg.stage ?? ''
      updateProgressPct.value = Math.round((msg.progress ?? 0) * 100)
      updateMessage.value = msg.message ?? ''

      if (msg.stage === 'restarting') {
        // Daemon will restart: poll health
        pollAfterRestart()
      }
      if (msg.stage === 'error') {
        updateError.value = msg.message
        applying.value = false
      }
    } catch {
      /* ignore */
    }
  }
  updateWs.onclose = () => {
    // If we were applying and WS closed, daemon likely restarted
    if (applying.value) pollAfterRestart()
  }
}

function pollAfterRestart() {
  let attempts = 0
  const poll = setInterval(async () => {
    attempts++
    try {
      await api.health()
      clearInterval(poll)
      applying.value = false
      updateStage.value = ''
      updateMessage.value = ''
      updateStatus.value = null
      await checkUpdate()
    } catch {
      /* still restarting */
    }
    if (attempts > 60) {
      clearInterval(poll)
      applying.value = false
      updateError.value = 'Timed out waiting for restart'
    }
  }, 2000)
}

async function applyUpdate() {
  if (applying.value) return
  applying.value = true
  updateError.value = null
  updateStage.value = 'downloading'
  updateMessage.value = 'Starting update...'
  updateProgressPct.value = 0

  // Connect WebSocket for live progress
  connectUpdateWs()

  try {
    await api.updates.apply()
    // The async update runs in the background: WS will report progress
  } catch (e) {
    updateError.value = String(e)
    applying.value = false
  }
}

async function rollbackUpdate() {
  if (applying.value) return
  applying.value = true
  updateError.value = null
  updateMessage.value = 'Rolling back...'
  try {
    await api.updates.rollback()
    pollAfterRestart()
  } catch (e) {
    updateError.value = String(e)
    applying.value = false
  }
}

const bridge = ref<BridgeConfig>({
  name: 'OpenBridge',
  port: 8582,
  hapPort: 51829,
  pincode: '031-45-154',
  username: '',
  logLevel: 'info',
})

onMounted(async () => {
  layout.setPage('Settings')
  try {
    const res = await api.bridge()
    if (res && typeof res === 'object') {
      bridge.value = {
        name: res.name ?? 'OpenBridge',
        port: res.port ?? 8582,
        hapPort: res.hapPort ?? 51829,
        pincode: res.pincode ?? '031-45-154',
        username: res.username ?? '',
        logLevel: res.logLevel ?? 'info',
      }
    }
  } catch {
    /* use defaults */
  }
  checkUpdate()
})

onUnmounted(() => {
  if (updateWs) {
    updateWs.close()
    updateWs = null
  }
})

async function save() {
  if (saving.value) return
  saving.value = true
  error.value = null
  saved.value = false
  try {
    const payload: Partial<BridgeConfig> = {
      name: bridge.value.name,
      port: Number(bridge.value.port),
      hapPort: Number(bridge.value.hapPort),
      pincode: bridge.value.pincode,
      logLevel: bridge.value.logLevel,
    }
    if (bridge.value.username) payload.username = bridge.value.username
    await api.saveBridge(payload)
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 3000)
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

async function restart() {
  if (restarting.value) return
  restarting.value = true
  try {
    await api.daemon.restart()
    let attempts = 0
    const poll = setInterval(async () => {
      attempts++
      try {
        await api.health()
        clearInterval(poll)
        location.reload()
      } catch {
        /* still restarting */
      }
      if (attempts > 60) {
        clearInterval(poll)
        restarting.value = false
      }
    }, 1000)
  } catch {
    restarting.value = false
  }
}

function generatePin() {
  const n = () => Math.floor(Math.random() * 9) + 1
  const pad3 = () => `${n()}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}`
  const pad2 = () => `${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}`
  bridge.value.pincode = `${pad3()}-${pad2()}-${pad3()}`
}
</script>

<style lang="scss" scoped>
// A responsive grid rather than a capped single column: the cap made this the
// only page that ignored the available width, but simply removing it would
// stretch the form fields across the whole viewport. Columns keep the fields
// at a readable measure while the page fills the space like every other view.
.settings-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr));
  align-items: start;
  gap: 1.25rem;
}

// NbPanel supplies the surface, border and radius; only the inner rhythm and
// the header treatment live here.
.settings-card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.card-icon {
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

.card-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--nb-c-text);
}

.card-subtitle {
  margin: 0;
  font-size: 0.78rem;
  color: var(--nb-c-text-muted);
}

// The label column NbField aligns every row on.
.field-grid {
  --nb-field-label-width: 8rem;
}

.mono :deep(input) {
  font-family: monospace;
}

.pin-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.action-hint {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.74rem;
  color: var(--nb-c-text-subtle);
}

.update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.update-versions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.update-actions {
  display: flex;
  gap: 0.5rem;
}

.update-error-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.info-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--nb-c-text-subtle);
}

.info-list {
  margin: 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--nb-c-text-muted);

  strong {
    color: var(--nb-c-text);
  }
}
</style>
