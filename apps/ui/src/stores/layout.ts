import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { IBreadcrumbItem } from '@nubisco/ui'

/**
 * Page identity for the shell topbar: the one breadcrumb trail.
 *
 * Topbar *controls* are not stored: views contribute them with
 * `useShellSlot('topbar-left' | 'topbar-right')`, so the buttons keep their own
 * view's reactive scope and handlers.
 */
export const useLayoutStore = defineStore('layout', () => {
  const title = ref('')
  /**
   * The trail of a page that has a parent (a device under Devices). Empty on
   * the top-level pages, whose trail is their title alone.
   */
  const crumbs = ref<IBreadcrumbItem[]>([])
  /**
   * Drop NbShell's main padding so a view can run edge to edge. For editor and
   * terminal surfaces, which should fill the space rather than float in it.
   */
  const fullBleed = ref(false)

  /** Opt-in per page: setPage resets it, so a view must ask on every mount. */
  function setPage(pageTitle: string, options?: { fullBleed?: boolean; crumbs?: IBreadcrumbItem[] }) {
    title.value = pageTitle
    fullBleed.value = options?.fullBleed ?? false
    crumbs.value = options?.crumbs ?? []
  }

  return { title, crumbs, fullBleed, setPage }
})
