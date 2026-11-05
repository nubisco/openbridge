import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import NubiscoUI, { configureNamedTheme, configureTheme } from '@nubisco/ui'
import App from './App.vue'
import { router } from './router'
import { registerRuntimeIcons } from './icons'
import './styles/main.scss'
// useConfirm() mounts NbConfirm itself, so no template names it and the
// library's Vite plugin never links its stylesheet. Without this every confirm
// dialog renders unstyled. Remove once the plugin links it for the composable.
import '@nubisco/ui/dist/styles/Confirm.css'
import PluginConfigField from './components/PluginConfigField.vue'

// Keep the key the local composable used, so nobody's stored preference is
// lost to the upgrade. Namespacing it also stops two Nubisco products served
// from one origin fighting over the library's default `nubisco.theme`.
configureTheme({ storageKey: 'openbridge.theme' })
// OpenBridge ships one named theme, its own. This selects it. The accent
// behind it comes from the home category in @nubisco/ui, not from anything here.
configureNamedTheme({ themes: ['openbridge'], defaultTheme: 'openbridge' })

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
