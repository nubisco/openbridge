<template>
  <div class="consent">
    <NbPanel class="consent__panel">
      <img class="consent__mark" src="/logo.svg" alt="OpenBridge" width="44" height="44" />

      <p v-if="state === 'loading'" class="consent__note">
        <NbSpinner size="sm" />
        Checking the request…
      </p>

      <template v-else-if="state === 'invalid'">
        <h1 class="consent__title">This request cannot continue</h1>
        <NbBanner status="error" variant="inline" :title="reason || 'The connection request is not valid.'" />
        <p class="consent__note">Nothing was shared. Start the connection again from your application.</p>
      </template>

      <template v-else-if="state === 'signed-out'">
        <h1 class="consent__title">Sign in to continue</h1>
        <p class="consent__note">Sign in to this bridge to decide whether {{ clientName }} may connect.</p>
        <NbButton variant="primary" @click="signIn">Sign in</NbButton>
      </template>

      <template v-else>
        <h1 class="consent__title">Connect {{ clientName }} to OpenBridge?</h1>
        <p class="consent__note">
          {{ clientName }} will be able to read your devices, their current readings and recorded history, their events
          and the bridge logs
          <template v-if="email">, as {{ email }}</template>
          . It will return to
          <strong>{{ redirectHost }}</strong>
          .
        </p>
        <NbCheckbox v-model="allowControl" label="Also allow it to operate devices" />
        <NbMessage v-if="allowControl" variant="warning">
          It will be able to switch, open and adjust anything the plugins on this bridge control, including gates and
          locks. You can disconnect it from Settings at any time.
        </NbMessage>
        <div class="consent__row">
          <NbButton variant="ghost" @click="decide('deny')">Cancel</NbButton>
          <NbButton variant="primary" @click="decide('approve')">Connect</NbButton>
        </div>
      </template>
    </NbPanel>
  </div>
</template>

<script setup lang="ts">
/**
 * The OAuth consent screen, reached by redirect from GET /oauth/authorize,
 * after Tally's (tally/apps/web/src/views/OAuthConsentView.vue).
 *
 * The daemon owns the truth: /oauth/context validates the request, and the
 * decision is a real form post to POST /oauth/authorize, because approval
 * answers with a redirect back to the connecting application that the browser
 * itself has to follow. Read only is the default, and control is a separate,
 * explicit choice.
 */
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

const PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const

const state = ref<'loading' | 'invalid' | 'signed-out' | 'consent'>('loading')
const clientName = ref('')
const email = ref('')
const redirectHost = ref('')
const reason = ref('')
const allowControl = ref(false)

function params(): URLSearchParams {
  const qs = new URLSearchParams()
  for (const k of PARAMS) {
    const v = route.query[k]
    if (typeof v === 'string' && v) qs.set(k, v)
  }
  return qs
}

async function load() {
  try {
    const res = await fetch(`/oauth/context?${params().toString()}`)
    const ctx = (await res.json()) as {
      ok: boolean
      reason?: string
      clientName?: string
      redirectHost?: string
      email?: string | null
      signedIn?: boolean
    }
    if (!ctx.ok) {
      reason.value = ctx.reason ?? ''
      state.value = 'invalid'
      return
    }
    clientName.value = ctx.clientName || 'This application'
    redirectHost.value = ctx.redirectHost ?? ''
    email.value = ctx.email ?? ''
    state.value = ctx.signedIn ? 'consent' : 'signed-out'
  } catch {
    state.value = 'invalid'
  }
}
void load()

/** Back here afterwards, parameters intact. AuthCallbackView honours this one path only. */
function signIn() {
  try {
    sessionStorage.setItem('openbridge_return_to', `/oauth/consent?${params().toString()}`)
  } catch {
    /* storage unavailable: the person lands on the dashboard and starts again */
  }
  void router.push('/login')
}

/** Only a real form post lets the browser follow the redirect to the application. */
function decide(decision: 'approve' | 'deny') {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = '/oauth/authorize'
  const add = (name: string, value: string) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  for (const [k, v] of params()) add(k, v)
  add('decision', decision)
  add('access', allowControl.value ? 'control' : 'read')
  document.body.appendChild(form)
  form.submit()
}
</script>

<style scoped lang="scss">
/* The sign-in card's shape, on purpose: this is the bridge's other front door. */
.consent {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: var(--nb-c-bg-soft);

  &__panel {
    width: min(100%, 28rem);
    display: grid;
    gap: 1rem;
    text-align: center;
  }

  &__title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--nb-c-text);
  }

  &__mark {
    display: block;
    width: 44px;
    height: 44px;
    margin-inline: auto;
  }

  &__note {
    margin: 0;
    color: var(--nb-c-text-subtle);
    font-size: 0.85rem;
    line-height: 1.55;

    strong {
      color: var(--nb-c-text);
    }
  }

  &__row {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
  }
}
</style>
