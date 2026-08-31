import { ref, watch, readonly } from 'vue'

/**
 * Light/dark theming.
 *
 * Nubisco UI ships both palettes and switches between them on a `.dark` class,
 * so all this has to do is decide when that class is present. It goes on
 * `<html>` rather than the app root because modals, popovers and teleported
 * content mount outside `#app` and would otherwise keep the light ramp.
 *
 * Three states, not two: 'system' follows the OS and is the default, so a user
 * who has never touched the setting gets the theme they already asked their
 * machine for. An explicit 'light' or 'dark' pins it and stops following.
 */
export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'openbridge.theme'

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function stored(): Theme {
  const value = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

const theme = ref<Theme>(stored())
const resolved = ref<'light' | 'dark'>('light')

function apply() {
  const isDark = theme.value === 'dark' || (theme.value === 'system' && !!media?.matches)
  resolved.value = isDark ? 'dark' : 'light'
  document.documentElement.classList.toggle('dark', isDark)
  // Lets the browser paint form controls, scrollbars and the canvas behind the
  // page to match, which is what stops the white flash on load.
  document.documentElement.style.colorScheme = resolved.value
}

apply()
watch(theme, (value) => {
  localStorage.setItem(STORAGE_KEY, value)
  apply()
})

// Only meaningful while following the system, but harmless to leave attached:
// apply() re-reads `theme` each time.
media?.addEventListener('change', apply)

export function useTheme() {
  function setTheme(value: Theme) {
    theme.value = value
  }

  /** Flip to the opposite of what is currently showing, leaving 'system'. */
  function toggle() {
    theme.value = resolved.value === 'dark' ? 'light' : 'dark'
  }

  return { theme: readonly(theme), resolved: readonly(resolved), setTheme, toggle }
}
