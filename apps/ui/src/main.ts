import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import NubiscoUI from '@nubisco/ui'
import '@nubisco/ui/dist/ui.css'
import App from './App.vue'
import { router } from './router'
import './styles/main.scss'
import PluginConfigField from './components/PluginConfigField.vue'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// Global i18n catalog — NbUserMenu (and future NbUI components) resolve their
// strings through it, falling back to their built-in en/pt defaults.
app.use(createI18n({ legacy: false, locale: navigator.language, fallbackLocale: 'en' }))
app.use(NubiscoUI)
// Register globally so recursive PluginConfigField works
app.component('PluginConfigField', PluginConfigField)
app.mount('#app')
