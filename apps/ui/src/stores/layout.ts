import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Page identity for the shell topbar.
 *
 * Only the breadcrumb lives here. Topbar *controls* are not stored: views
 * teleport them into `#ob-topbar-left` / `#ob-topbar-right` so the buttons keep
 * their own view's reactive scope and handlers. (The previous
 * `setActions(markRaw(Component))` approach mounted a detached component that
 * could reach neither.)
 */
export const useLayoutStore = defineStore('layout', () => {
  const title = ref('')
  const count = ref<number | null>(null)

  function setPage(pageTitle: string, pageCount?: number) {
    title.value = pageTitle
    count.value = pageCount ?? null
  }

  return { title, count, setPage }
})
