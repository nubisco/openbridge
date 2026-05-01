<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { api, type BridgeConfig, type UpdateStatus } from '@/api'
import { useLayoutStore } from '@/stores/layout'

const layout = useLayoutStore()
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
        // Daemon will restart — poll health
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
    // The async update runs in the background — WS will report progress
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

<template>
  <div class="settings-view">
    <!-- Bridge Settings -->
    <section class="settings-card">
      <div class="card-header">
        <div class="card-icon">
          <NbIcon name="bridge" :size="18" />
        </div>
        <div>
          <h2 class="card-title">Bridge</h2>
          <p class="card-subtitle">HomeKit bridge identity and network settings</p>
        </div>
      </div>

      <div class="field-grid">
        <label class="field-label">Bridge name</label>
        <div class="field-control">
          <input v-model="bridge.name" class="field-input" placeholder="OpenBridge" />
          <span class="field-hint">Displayed in the Home app</span>
        </div>

        <label class="field-label">HTTP port</label>
        <div class="field-control">
          <input
            v-model.number="bridge.port"
            class="field-input field-input--short"
            type="number"
            min="1024"
            max="65535"
          />
          <span class="field-hint">OpenBridge web UI &amp; API</span>
        </div>

        <label class="field-label">HAP port</label>
        <div class="field-control">
          <input
            v-model.number="bridge.hapPort"
            class="field-input field-input--short"
            type="number"
            min="1024"
            max="65535"
          />
          <span class="field-hint">HomeKit accessory protocol port</span>
        </div>

        <label class="field-label">PIN code</label>
        <div class="field-control">
          <div class="pin-row">
            <input v-model="bridge.pincode" class="field-input field-input--pin" placeholder="031-45-154" />
            <button class="btn-generate" title="Generate random PIN" @click="generatePin">
              <NbIcon name="arrows-clockwise" :size="13" />
            </button>
          </div>
          <span class="field-hint">Format: XXX-XX-XXX — used to pair with HomeKit</span>
        </div>

        <label class="field-label">Bridge MAC</label>
        <div class="field-control">
          <input
            v-model="bridge.username"
            class="field-input"
            placeholder="AA:BB:CC:DD:EE:FF"
            style="font-family: monospace"
          />
          <span class="field-hint">Leave empty to auto-generate. Change this only if pairing with HomeKit fails.</span>
        </div>

        <label class="field-label">Log level</label>
        <div class="field-control">
          <select v-model="bridge.logLevel" class="field-select">
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>
      </div>

      <div v-if="error" class="save-error">
        <NbIcon name="warning" :size="13" />
        {{ error }}
      </div>

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
    </section>

    <!-- Updates -->
    <section class="settings-card">
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
          <span class="version-chip">
            <NbIcon name="tag" :size="11" />
            Current:
            <strong>v{{ updateStatus?.current ?? '…' }}</strong>
          </span>
          <template v-if="updateStatus && !checkingUpdate">
            <span v-if="updateStatus.updateAvailable" class="version-chip version-chip--available">
              <NbIcon name="arrow-circle-up" :size="11" />
              Available:
              <strong>v{{ updateStatus.latest }}</strong>
            </span>
            <span v-else-if="updateStatus.latest === null" class="version-chip version-chip--muted">
              <NbIcon name="warning" :size="11" />
              Unable to check
            </span>
            <span v-else class="version-chip version-chip--ok">
              <NbIcon name="check-circle" :size="11" />
              Up to date
            </span>
          </template>
          <span v-if="checkingUpdate" class="version-chip version-chip--muted">Checking…</span>
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

      <!-- Progress bar during self-update -->
      <div v-if="applying && updateStage" class="update-progress">
        <div class="update-progress-info">
          <span class="update-progress-stage">{{ updateMessage }}</span>
          <span v-if="updateStage === 'downloading' && updateProgressPct > 0" class="update-progress-pct">
            {{ updateProgressPct }}%
          </span>
        </div>
        <div class="update-progress-bar">
          <div
            class="update-progress-fill"
            :style="{
              width:
                updateStage === 'downloading'
                  ? updateProgressPct + '%'
                  : updateStage === 'extracting'
                    ? '80%'
                    : updateStage === 'swapping'
                      ? '90%'
                      : '100%',
              transition: 'width 0.3s ease',
            }"
          />
        </div>
      </div>

      <p v-if="applying && !updateStage" class="update-notice">
        <NbIcon name="info" :size="12" />
        Starting update... This page will reconnect automatically.
      </p>

      <p v-if="updateStatus?.updateMethod === 'manual' && updateStatus.updateAvailable" class="update-notice">
        <NbIcon name="info" :size="12" />
        Self-update is not available. Pull the latest Docker image to update:
        <code>docker pull ghcr.io/nubisco/openbridge:latest</code>
      </p>

      <p v-if="updateError" class="update-notice update-notice--error">
        <NbIcon name="warning" :size="12" />
        {{ updateError }}
        <NbButton v-if="updateError" variant="ghost" size="sm" style="margin-left: 0.5rem" @click="rollbackUpdate">
          Rollback
        </NbButton>
      </p>
    </section>

    <!-- HAP pairing info -->
    <section class="settings-card info-card">
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
    </section>
  </div>
</template>

<style lang="scss" scoped>
.settings-view {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  max-width: 640px;
}

.settings-card {
  background: #fff;
  border: 1px solid #e8e8f0;
  border-radius: 12px;
  padding: 1.4rem 1.5rem;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  margin-bottom: 1.25rem;
}
.card-icon {
  width: 40px;
  height: 40px;
  background: #f0eeff;
  color: #7c3aed;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.card-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
  color: #111827;
}
.card-subtitle {
  margin: 0.15rem 0 0;
  font-size: 0.78rem;
  color: #9ca3af;
}

.field-grid {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 0.9rem 1rem;
  align-items: start;
}

.field-label {
  font-size: 0.82rem;
  font-weight: 500;
  color: #374151;
  padding-top: 0.45rem;
}

.field-control {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field-input {
  padding: 0.42rem 0.65rem;
  border: 1px solid #e8e8f0;
  border-radius: 7px;
  font-size: 0.82rem;
  outline: none;
  width: 100%;
  box-sizing: border-box;
  transition: border-color 0.15s;
  &:focus {
    border-color: #a78bfa;
  }
  &--short {
    max-width: 110px;
  }
  &--pin {
    max-width: 160px;
    font-family: monospace;
    letter-spacing: 0.05em;
  }
}

.field-select {
  padding: 0.42rem 0.65rem;
  border: 1px solid #e8e8f0;
  border-radius: 7px;
  font-size: 0.82rem;
  outline: none;
  width: fit-content;
  background: #fff;
  cursor: pointer;
  &:focus {
    border-color: #a78bfa;
  }
}

.field-hint {
  font-size: 0.72rem;
  color: #9ca3af;
}

.pin-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.btn-generate {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #e8e8f0;
  border-radius: 7px;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  flex-shrink: 0;
  &:hover {
    border-color: #a78bfa;
    color: #7c3aed;
  }
}

.save-error {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: #dc2626;
  margin-top: 0.75rem;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-top: 1.25rem;
  padding-top: 1rem;
  border-top: 1px solid #f0f0f8;
}

.action-hint {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  color: #9ca3af;
}

// ─── Updates card ────────────────────────────────────────────────────────────
.update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.update-versions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.version-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.78rem;
  padding: 0.25rem 0.6rem;
  border-radius: 20px;
  background: #f3f4f6;
  color: #374151;

  &--available {
    background: #fef3c7;
    color: #92400e;
  }
  &--ok {
    background: #d1fae5;
    color: #065f46;
  }
  &--muted {
    color: #9ca3af;
  }
}

.update-actions {
  display: flex;
  gap: 0.5rem;
}

.update-progress {
  margin-top: 0.75rem;
}
.update-progress-info {
  display: flex;
  justify-content: space-between;
  font-size: 0.78rem;
  color: #6b7280;
  margin-bottom: 0.35rem;
}
.update-progress-stage {
  color: #374151;
  font-weight: 500;
}
.update-progress-pct {
  color: #7c3aed;
  font-weight: 600;
}
.update-progress-bar {
  height: 6px;
  background: #f3f4f6;
  border-radius: 3px;
  overflow: hidden;
}
.update-progress-fill {
  height: 100%;
  background: #7c3aed;
  border-radius: 3px;
}

.update-notice {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  color: #6b7280;
  margin: 0.75rem 0 0;

  code {
    background: #f3f4f6;
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.72rem;
  }

  &--error {
    color: #dc2626;
  }
}

// ─── Info card ───────────────────────────────────────────────────────────────
.info-card {
  background: #fafaf8;
  border-color: #e8e8e0;
}
.info-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.78rem;
  font-weight: 700;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 0 0 0.75rem;
}
.info-list {
  margin: 0;
  padding-left: 1.25rem;
  font-size: 0.82rem;
  color: #374151;
  line-height: 1.7;
  li {
    margin-bottom: 0.25rem;
  }
}
</style>
