<template>
  <!-- The settings pattern: one column, sections on the page ground under a
       heading and a lede, 32px apart. No page title, the trail already says
       Settings. The two tables in AI agents paint their own surface, so
       nothing here is boxed. -->
  <div class="settings">
    <!-- Bridge: a form with an explicit Save at its foot. -->
    <section class="settings__section" aria-labelledby="settings-bridge-title">
      <header>
        <h2 id="settings-bridge-title" class="type-heading-02 settings__title">Bridge</h2>
        <p class="type-body-sm settings__lede">
          HomeKit bridge identity and network settings. They take effect when OpenBridge restarts.
        </p>
      </header>

      <!-- NbField supplies the label column every row lines up on, so the
           fields need no width or alignment CSS of their own. -->
      <NbGrid dir="col" gap="md" class="settings__form settings__fields">
        <NbField label="Bridge name" hint="Displayed in the Home app">
          <NbTextInput v-model="bridge.name" placeholder="OpenBridge" />
        </NbField>

        <NbField label="HTTP port" hint="OpenBridge web UI &amp; API" control="fit">
          <NbNumberInput v-model="bridge.port" :min="1024" :max="65535" />
        </NbField>

        <NbField label="HAP port" hint="HomeKit accessory protocol port" control="fit">
          <NbNumberInput v-model="bridge.hapPort" :min="1024" :max="65535" />
        </NbField>

        <NbField label="PIN code" hint="Format: XXX-XX-XXX, used to pair with HomeKit">
          <div class="settings__pin">
            <NbTextInput v-model="bridge.pincode" class="tabular" placeholder="031-45-154" />
            <NbButton
              v-nb-tooltip="{ body: 'Generate random PIN' }"
              variant="ghost"
              icon="arrows-clockwise"
              aria-label="Generate random PIN"
              @click="generatePin"
            />
          </div>
        </NbField>

        <NbField
          label="Bridge MAC"
          hint="Leave empty to auto-generate. Change this only if pairing with HomeKit fails."
        >
          <NbTextInput v-model="bridge.username" class="settings__mono" placeholder="AA:BB:CC:DD:EE:FF" />
        </NbField>

        <NbField label="Log level" control="fit">
          <NbSelect v-model="bridge.logLevel" :options="logLevelOptions" />
        </NbField>
      </NbGrid>

      <NbMessage v-if="error" variant="error" class="settings__form">{{ error }}</NbMessage>

      <!-- Save is the section's one filled button. Restarting is a separate
           step, so it stays quiet beside it. -->
      <div class="settings__actions">
        <NbButton variant="primary" :loading="saving" :icon="saved ? 'check' : undefined" @click="save">
          {{ saved ? 'Saved' : 'Save' }}
        </NbButton>
        <NbButton variant="tertiary" :loading="restarting" icon="arrows-clockwise" @click="restart">
          {{ restarting ? 'Restarting…' : 'Save & Restart OpenBridge' }}
        </NbButton>
        <span v-if="saved && !restarting" class="type-body-sm settings__hint">
          <NbIcon name="info" size="sm" />
          Restart the daemon for changes to take effect
        </span>
      </div>
    </section>

    <!-- Updates: a status and the one action it allows. -->
    <section class="settings__section" aria-labelledby="settings-updates-title">
      <header>
        <h2 id="settings-updates-title" class="type-heading-02 settings__title">Updates</h2>
        <p class="type-body-sm settings__lede">OpenBridge daemon and UI.</p>
      </header>

      <div class="settings__update">
        <div class="settings__versions">
          <NbBadge variant="neutral">Current: v{{ updateStatus?.current ?? '…' }}</NbBadge>
          <template v-if="updateStatus && !checkingUpdate">
            <NbBadge v-if="updateStatus.updateAvailable" variant="info">Available: v{{ updateStatus.latest }}</NbBadge>
            <NbBadge v-else-if="updateStatus.latest === null" variant="warning">Unable to check</NbBadge>
            <NbBadge v-else variant="success">Up to date</NbBadge>
          </template>
          <NbBadge v-if="checkingUpdate" variant="neutral">Checking…</NbBadge>
        </div>

        <div class="settings__actions">
          <NbButton variant="tertiary" :loading="checkingUpdate" icon="arrows-clockwise" @click="checkUpdate">
            Check
          </NbButton>
          <!-- An npm, source or pinned install cannot update itself, and the
               daemon refuses with 503. Offering the button anyway turned a
               documented limitation into what looked like a broken update. -->
          <NbButton
            v-if="updateStatus?.updateAvailable && updateStatus.updateMethod === 'self'"
            variant="primary"
            :loading="applying"
            icon="arrow-circle-up"
            @click="applyUpdate"
          >
            {{ applying ? 'Updating…' : 'Install update' }}
          </NbButton>
        </div>
      </div>

      <!-- Only the download stage reports real progress. The later stages are
           indeterminate, which NbProgressBar shows by omitting `value`. -->
      <NbProgressBar
        v-if="applying && updateStage"
        class="settings__form"
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
        <template v-if="updateStatus.pinnedTo">
          This deployment is pinned to {{ updateStatus.pinnedTo }}. To move version:
        </template>
        <template v-else-if="updateStatus.updateBlockedBy">
          Self-update is not available here ({{ updateStatus.updateBlockedBy }}). To update:
        </template>
        <template v-else>Self-update is not available for this install. To update:</template>
        <code class="settings__command">{{ updateStatus.updateCommand }}</code>
      </NbMessage>

      <div v-if="updateError" class="settings__actions">
        <NbMessage variant="error">{{ updateError }}</NbMessage>
        <!-- Only once an update actually started. A request the daemon refused
             outright swapped no directories, so there is nothing to roll back
             to and offering it invites an unnecessary restart. -->
        <NbButton v-if="updateStarted" variant="tertiary" @click="rollbackUpdate">Roll back</NbButton>
      </div>
    </section>

    <AgentAccessPanel />

    <!-- Appearance. Theme is a personal setting and lives in the user menu,
         but with sign-in off (the self-hosted default) there is no user menu,
         so this is the only place left to set it. It applies at once, so the
         section has no Save. -->
    <section v-if="!hasUserMenu" class="settings__section" aria-labelledby="settings-appearance-title">
      <header>
        <h2 id="settings-appearance-title" class="type-heading-02 settings__title">Appearance</h2>
        <p class="type-body-sm settings__lede">Theme for this browser. A change applies as soon as you make it.</p>
      </header>

      <NbGrid dir="col" gap="md" class="settings__form settings__fields">
        <NbField label="Theme">
          <NbRadio
            name="settings-theme"
            :options="themeOptions"
            :model-value="themeController.theme.value"
            @update:model-value="themeController.setTheme($event as TTheme)"
          />
        </NbField>
      </NbGrid>
    </section>

    <!-- HAP pairing: guidance, not a setting, so it reads as prose. -->
    <section class="settings__section" aria-labelledby="settings-pairing-title">
      <header>
        <h2 id="settings-pairing-title" class="type-heading-02 settings__title">Pair with HomeKit</h2>
      </header>
      <ol class="type-body-md settings__form settings__steps">
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

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useTheme, type TTheme } from '@nubisco/ui'
import { api, type BridgeConfig, type UpdateStatus } from '@/api'
import { useAuth } from '@/composables/useAuth'
import { useLayoutStore } from '@/stores/layout'
import AgentAccessPanel from '@/components/AgentAccessPanel.vue'

const layout = useLayoutStore()
const auth = useAuth()

// The same condition AppLayout renders NbUserMenu on, so the theme always has
// exactly one home: the menu when there is one, this panel when there is not.
const hasUserMenu = computed(() => Boolean(auth.config.value?.enabled && auth.user.value))
const themeController = useTheme()
// Worded as NbUserMenu's built-in Appearance section, so both read the same.
const themeOptions = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'Match my system', value: 'system' },
]

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
/** True once the daemon has accepted an update, which is what rollback undoes. */
const updateStarted = ref(false)
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
  updateStarted.value = false
  updateError.value = null
  updateStage.value = 'downloading'
  updateMessage.value = 'Starting update...'
  updateProgressPct.value = 0

  // Connect WebSocket for live progress
  connectUpdateWs()

  try {
    await api.updates.apply()
    // The async update runs in the background: WS will report progress
    updateStarted.value = true
  } catch (e) {
    updateError.value = e instanceof Error ? e.message : String(e)
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
    updateError.value = e instanceof Error ? e.message : String(e)
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
// The settings pattern: one column capped near 56rem so the AI agents tables
// keep their columns, forms at 40rem so a field never stretches across a
// desktop, sections 32px apart on the page ground.
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--nb-spacing-32);
  max-inline-size: 56rem;
  padding-block-end: var(--nb-spacing-32);

  &__section {
    display: flex;
    flex-direction: column;
    align-items: stretch;
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

  // The label column NbField aligns every row on.
  &__fields {
    --nb-field-label-width: 8rem;
  }

  &__mono :deep(input) {
    font-family: var(--nb-font-family-mono);
  }

  &__pin {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    flex-wrap: wrap;
  }

  &__hint {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-4);
    color: var(--nb-c-text-muted);
  }

  // The status and its action read as one line, so Check sits beside the
  // badges rather than at the far edge of the measure.
  &__update {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-16);
    flex-wrap: wrap;
  }

  &__versions {
    display: flex;
    align-items: center;
    gap: var(--nb-spacing-8);
    flex-wrap: wrap;
  }

  /* Spaced with a margin rather than a space in the markup. Vue drops
     whitespace-only text between elements when it spans a newline, so the
     command ran straight into the colon ("To update:npm install"), and writing
     the space into the template does not survive Prettier reformatting the tag. */
  &__command {
    margin-inline-start: var(--nb-spacing-4);
  }

  &__steps {
    margin: 0;
    padding-inline-start: var(--nb-spacing-24);
    display: flex;
    flex-direction: column;
    gap: var(--nb-spacing-8);
    color: var(--nb-c-text-muted);

    // Semibold, the ladder's emphasis at 14px, not the browser's bold.
    strong {
      color: var(--nb-c-text);
      font-weight: var(--nb-type-heading-compact-weight);
    }
  }
}
</style>
