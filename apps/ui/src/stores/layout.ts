import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Page identity and chrome for the shell topbar.
 *
 * Topbar *controls* are not stored: views teleport them into
 * `#ob-topbar-left` / `#ob-topbar-right` so the buttons keep their own view's
 * reactive scope and handlers. (The previous `setActions(markRaw(Component))`
 * approach mounted a detached component that could reach neither.)
 */
export const useLayoutStore = defineStore('layout', () => {
  const title = ref('')
  const count = ref<number | null>(null)
  /**
   * Drop NbShell's main padding so a view can run edge to edge. For editor and
   * terminal surfaces, which should fill the space rather than float in it.
   */
  const fullBleed = ref(false)

  /** Opt-in per page: setPage resets it, so a view must ask on every mount. */
  function setPage(pageTitle: string, pageCount?: number, options?: { fullBleed?: boolean }) {
    title.value = pageTitle
    count.value = pageCount ?? null
    fullBleed.value = options?.fullBleed ?? false
  }

  return { title, count, fullBleed, setPage }
})
