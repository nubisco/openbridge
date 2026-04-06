import { defineStore } from 'pinia'
import { ref, markRaw, type Component } from 'vue'

export const useLayoutStore = defineStore('layout', () => {
  const title = ref('')
  const count = ref<number | null>(null)
  // For right-side topbar actions — a component rendered inline
  const actionsComponent = ref<Component | null>(null)

  function setPage(pageTitle: string, pageCount?: number) {
    title.value = pageTitle
    count.value = pageCount ?? null
    actionsComponent.value = null
  }

  function setActions(component: Component) {
    actionsComponent.value = markRaw(component)
  }

  function clearActions() {
    actionsComponent.value = null
  }

  return { title, count, actionsComponent, setPage, setActions, clearActions }
})
