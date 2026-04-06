<template>
  <div :class="props.class" v-html="svg" />
</template>

<script setup>
import { onMounted, onUnmounted, ref, toRaw } from 'vue'
import { render, init } from './mermaid'
import { useData } from 'vitepress'

const pluginSettings = ref({
  securityLevel: 'loose',
  startOnLoad: false,
  externalDiagrams: [],
})

const { page } = useData()
const { frontmatter } = toRaw(page.value)
const mermaidPageTheme = frontmatter.mermaidTheme || ''

const props = defineProps({
  graph: {
    type: String,
    required: true,
  },
  id: {
    type: String,
    required: true,
  },
  class: {
    type: String,
    required: false,
    default: 'mermaid',
  },
})

const svg = ref(null)
let mut = null

onMounted(async () => {
  await init(pluginSettings.value.externalDiagrams)
  const settings = await import('virtual:mermaid-config')
  if (settings?.default) {
    pluginSettings.value = settings.default
  }

  mut = new MutationObserver(async () => await renderChart())
  mut.observe(document.documentElement, { attributes: true })
  await renderChart()

  const hasImages = /<img([\w\W]+?)>/.exec(decodeURIComponent(props.graph))?.length > 0

  if (hasImages) {
    setTimeout(() => {
      const imgElements = document.getElementsByTagName('img')
      const imgs = Array.from(imgElements)
      if (imgs.length) {
        Promise.all(
          imgs
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise((resolve) => {
                  img.onload = img.onerror = resolve
                }),
            ),
        ).then(async () => {
          await renderChart()
        })
      }
    }, 100)
  }
})

onUnmounted(() => {
  if (mut) {
    mut.disconnect()
  }
})

const renderChart = async () => {
  const hasDarkClass = document.documentElement.classList.contains('dark')
  const mermaidConfig = {
    ...pluginSettings.value,
  }

  if (mermaidPageTheme) {
    mermaidConfig.theme = mermaidPageTheme
  }

  if (hasDarkClass) {
    mermaidConfig.theme = 'dark'
  }

  const svgCode = await render(props.id, decodeURIComponent(props.graph), mermaidConfig)

  const salt = Math.random().toString(36).substring(7)
  svg.value = `${svgCode} <span style="display: none">${salt}</span>`
}
</script>
