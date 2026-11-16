import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, type HousePlan } from '@/api'

/**
 * The house plan as the server has it, shared by the House view and the
 * router, which opens the app on the House view once there is a plan.
 */
export const useHouseStore = defineStore('house', () => {
  const plan = ref<HousePlan | null>(null)
  const rev = ref(0)
  const loaded = ref(false)

  /** A plan with at least one room drawn. An empty plan is not a house yet. */
  const hasPlan = computed(() => !!plan.value?.floors.some((f) => f.rooms.length > 0))

  async function load(): Promise<void> {
    const res = await api.house.get()
    plan.value = res.plan
    rev.value = res.rev
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
    const res = await api.house.save(next, rev.value)
    const state = res.ok ? res.house : res.conflict
    plan.value = state.plan
    rev.value = state.rev
    return res.ok ? 'saved' : 'conflict'
  }

  return { plan, rev, loaded, hasPlan, load, ensure, save }
})
