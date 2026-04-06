import { createApp } from 'vue'
import { createPinia } from 'pinia'
import NubiscoUI from '@nubisco/ui'
import '@nubisco/ui/dist/ui.css'
import App from './App.vue'
import { router } from './router'
import './styles/main.scss'
import PluginConfigField from './components/PluginConfigField.vue'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(NubiscoUI)
// Register globally so recursive PluginConfigField works
app.component('PluginConfigField', PluginConfigField)
app.mount('#app')
