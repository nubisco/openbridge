import { defineConfig } from 'vitepress'
import { withMermaid } from './plugins/mermaid'

export default withMermaid(
  defineConfig({
    title: 'OpenBridge',
    description: 'A modern, local-first home automation bridge built for developers.',
    base: '/',
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: true,

    head: [
      ['link', { rel: 'icon', href: '/favicon.ico', sizes: 'any' }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32x32.png' }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16x16.png' }],
      ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
      ['link', { rel: 'manifest', href: '/site.webmanifest' }],
      ['meta', { name: 'theme-color', content: '#0d0d0f' }],
    ],

    themeConfig: {
      logo: { src: '/logo.svg', alt: 'OpenBridge' },

      nav: [
        { text: 'Guide', link: '/guide/what-is-openbridge' },
        { text: 'Plugin Dev', link: '/guide/creating-a-plugin' },
        { text: 'API Reference', link: '/guide/api-reference' },
      ],

      sidebar: [
        {
          text: 'Introduction',
          items: [
            { text: 'What is OpenBridge?', link: '/guide/what-is-openbridge' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Core Concepts', link: '/guide/concepts' },
          ],
        },
        {
          text: 'User Guide',
          items: [
            { text: 'Configuration', link: '/guide/config-reference' },
            { text: 'Dashboard UI', link: '/guide/ui' },
            { text: 'Homebridge Compatibility', link: '/guide/homebridge-compatibility' },
          ],
        },
        {
          text: 'Plugin Development',
          items: [
            { text: 'Creating a Plugin', link: '/guide/creating-a-plugin' },
            { text: 'Plugin API Reference', link: '/guide/plugin-api' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'HTTP API', link: '/guide/api-reference' },
            { text: 'Architecture', link: '/guide/architecture' },
          ],
        },
      ],

      search: { provider: 'local' },

      footer: {
        message: 'Part of the Nubisco ecosystem · MIT License',
        copyright: '© 2026 Nubisco',
      },

      socialLinks: [{ icon: 'github', link: 'https://github.com/nubisco/openbridge' }],

      editLink: {
        pattern: 'https://github.com/nubisco/openbridge/edit/main/apps/docs/docs/:path',
        text: 'Suggest changes to this page',
      },
    },
  }),
)
