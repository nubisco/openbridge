import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { toV1 } from '@house-model/convert'
import { api, type HouseModel, type HousePlan, type StoredHouse } from '@/api'
import { liveDevices, type LiveDevice, type NativeDevice } from '@/house/live'
import { useDaemonStore } from './daemon'

/**
 * The house plan as the server has it, shared by the House view and the
 * router, which opens the app on the House view once there is a plan. It
 * also holds the live devices the plan draws, so the shell's inspector shows
 * the same reading as the plan beside it.
 */
export const useHouseStore = defineStore('house', () => {
  /** The plan as stored, version 2. */
  const model = ref<HouseModel | null>(null)
  /** The same plan in cells, which the editor and views still draw. */
  const plan = ref<HousePlan | null>(null)
  const rev = ref(0)

  function take(state: StoredHouse): void {
    model.value = state.plan
    plan.value = state.plan ? (toV1(state.plan) as HousePlan) : null
    rev.value = state.rev
  }
  const loaded = ref(false)

  /** A plan with at least one room drawn. An empty plan is not a house yet. */
  const hasPlan = computed(() => !!plan.value?.floors.some((f) => f.rooms.length > 0))

  async function load(): Promise<void> {
    take(await api.house.get())
    loaded.value = true
  }

  /** Load once. Failure counts as no plan, so the app still opens. */
  async function ensure(): Promise<void> {
    if (loaded.value) return
    try {
      await load()
    } catch {
      loaded.value = true
    }
  }

  /**
   * Save a plan. Answers `conflict` when somebody saved since this tab read,
   * having already taken the newer plan, so the caller can tell the person
   * and let them redo the change on top of it.
   */
  async function save(next: HousePlan | null): Promise<'saved' | 'conflict'> {
    // Sent in cells. The server converts it and keeps from the stored plan
    // what cells cannot say (wall thickness, a door's frame, curtains).
    const res = await api.house.save(next, rev.value)
    take(res.ok ? res.house : res.conflict)
    return res.ok ? 'saved' : 'conflict'
  }

  const daemon = useDaemonStore()
  const native = ref<NativeDevice[]>([])
  const devices = computed<LiveDevice[]>(() => liveDevices(native.value, daemon.accessories))
  const byRef = computed(() => new Map(devices.value.map((d) => [d.ref, d])))

  /**
   * Fetch every device's current state. Both lists are served from memory in
   * the daemon, so polling this costs no device traffic. A failed poll keeps
   * the last state, and the next poll tries again.
   */
  async function poll(): Promise<void> {
    try {
      const [res] = await Promise.all([api.devices(), daemon.fetchAccessories()])
      native.value = res.devices as NativeDevice[]
    } catch {
      /* retried on the next tick */
    }
  }

  return { model, plan, rev, loaded, hasPlan, load, ensure, save, devices, byRef, poll }
})
