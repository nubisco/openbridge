import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Unfonts from 'unplugin-fonts/vite'

export default defineConfig({
  plugins: [
    vue(),
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
      '/ws': { target: 'ws://localhost:8582', ws: true },
    },
  },
})
