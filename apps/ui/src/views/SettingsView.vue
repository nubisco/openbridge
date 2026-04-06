<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api, type BridgeConfig } from '@/api'
import { useLayoutStore } from '@/stores/layout'

const layout = useLayoutStore()
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const restarting = ref(false)

const bridge = ref<BridgeConfig>({
  name: 'OpenBridge',
  port: 8581,
  hapPort: 51826,
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
        port: res.port ?? 8581,
        hapPort: res.hapPort ?? 51826,
        pincode: res.pincode ?? '031-45-154',
        username: res.username ?? '',
        logLevel: res.logLevel ?? 'info',
      }
    }
  } catch {
    /* use defaults */
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
        restarting.value = false
      } catch {
        /* still restarting */
      }
      if (attempts > 30) {
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
