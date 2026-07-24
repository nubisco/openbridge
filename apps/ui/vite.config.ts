import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import Unfonts from 'unplugin-fonts/vite'

/**
 * Appends a content-hash query param (?v=<hash>) to favicon links in index.html
 * so browsers (Safari in particular) refetch the icon whenever the file changes.
 */
function faviconCacheBust(): Plugin {
  const hashFor = (publicPath: string) => {
    const file = fileURLToPath(new URL(`./public${publicPath}`, import.meta.url))
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8)
  }
  return {
    name: 'favicon-cache-bust',
    transformIndexHtml(html) {
      return html.replace(
        /(<link[^>]*rel="(?:icon|apple-touch-icon)"[^>]*href=")([^"?]+)(")/g,
        (_match, before, href, after) => `${before}${href}?v=${hashFor(href)}${after}`,
      )
    },
  }
}

export default defineConfig({
  plugins: [
    vue(),
    faviconCacheBust(),
    Unfonts({
      custom: {
        families: [
          {
            name: 'MesloLGS NF',
            local: 'MesloLGS NF',
            src: './public/fonts/MesloLGLDZNerdFontMono-Regular.woff2',
            weight: '400',
            style: 'normal',
          },
          {
            name: 'MesloLGS NF',
            local: 'MesloLGS NF',
            src: './public/fonts/MesloLGLDZNerdFontMono-Italic.woff2',
            weight: '400',
            style: 'italic',
          },
          {
            name: 'MesloLGS NF',
            local: 'MesloLGS NF',
            src: './public/fonts/MesloLGLDZNerdFontMono-Bold.woff2',
            weight: '700',
            style: 'normal',
          },
          {
            name: 'MesloLGS NF',
            local: 'MesloLGS NF',
            src: './public/fonts/MesloLGLDZNerdFontMono-BoldItalic.woff2',
            weight: '700',
            style: 'italic',
          },
        ],
      },
    }),
  ],
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        charset: false,
        additionalData: `@use '@nubisco/ui/variables';`,
      },
    },
  },
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8582',
      '/auth': 'http://localhost:8582',
      '/ws': { target: 'ws://localhost:8582', ws: true },
    },
  },
})
