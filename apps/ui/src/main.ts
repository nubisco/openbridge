import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import NubiscoUI, { configureTheme } from '@nubisco/ui'
import App from './App.vue'
import { router } from './router'
import { registerRuntimeIcons } from './icons'
import './styles/main.scss'
import PluginConfigField from './components/PluginConfigField.vue'

// Keep the key the local composable used, so nobody's stored preference is
// lost to the upgrade. Namespacing it also stops two Nubisco products served
// from one origin fighting over the library's default `nubisco.theme`.
configureTheme({ storageKey: 'openbridge.theme' })

const app = createApp(App)
app.use(createPinia())
app.use(router)
// Global i18n catalog: NbUserMenu (and future NbUI components) resolve their
// strings through it, falling back to their built-in en/pt defaults.
app.use(createI18n({ legacy: false, locale: navigator.language, fallbackLocale: 'en' }))
app.use(NubiscoUI)
// Icons named by a runtime value rather than a literal; see src/icons.ts.
registerRuntimeIcons()
// Register globally so recursive PluginConfigField works
app.component('PluginConfigField', PluginConfigField)
app.mount('#app')
