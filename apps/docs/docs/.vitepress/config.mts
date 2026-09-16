import { defineConfig } from 'vitepress'
import { withMermaid } from './plugins/mermaid'

/** Running a bridge: installing it, pairing devices, living with it. */
const users = [
  {
    text: 'Introduction',
    items: [
      { text: 'What is OpenBridge?', link: '/guide/what-is-openbridge' },
      { text: 'Installation', link: '/guide/installation' },
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
    text: 'Going further',
    items: [{ text: 'Writing a plugin', link: '/guide/creating-a-plugin' }],
  },
]

/** Building on OpenBridge: plugins, the HTTP API, how it works inside. */
const developers = [
  {
    text: 'Plugin Development',
    items: [
      { text: 'Creating a Plugin', link: '/guide/creating-a-plugin' },
      { text: 'Plugin API Reference', link: '/guide/plugin-api' },
      { text: 'HomeKit Exposure', link: '/guide/homekit-exposure' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'HTTP API', link: '/guide/api-reference' },
      { text: 'Architecture', link: '/guide/architecture' },
    ],
  },
  {
    text: 'Back to the guide',
    items: [{ text: 'Using OpenBridge', link: '/guide/what-is-openbridge' }],
  },
]

// Project page, so the site is served from a subpath. VitePress rewrites links
// it owns (theme logo, router hrefs, bundled assets) but passes `head` through
// verbatim, so anything below has to carry the prefix itself.
const base = '/openbridge/'

export default withMermaid(
  defineConfig({
    title: 'OpenBridge',
    description: 'A modern, local-first home automation bridge built for developers.',
    base,
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: true,

    head: [
      ['link', { rel: 'icon', href: `${base}favicon.ico`, sizes: 'any' }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}favicon-32x32.png` }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: `${base}favicon-16x16.png` }],
      ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: `${base}apple-touch-icon.png` }],
      ['link', { rel: 'manifest', href: `${base}site.webmanifest` }],
      ['meta', { name: 'theme-color', content: '#22335e' }],
      ['script', { defer: '', src: 'https://analytics.nubisco.io/script.js' }],
    ],

    sitemap: { hostname: 'https://docs.nubisco.io/openbridge/' },

    themeConfig: {
      logo: { src: '/logo.svg', alt: 'OpenBridge' },

      // TWO DOORS, BY PERSON. Someone running a bridge at home and someone
      // writing a plugin for it want different halves of this site, and one flat
      // sidebar made the person trying to pair a light bulb scroll past the
      // plugin lifecycle and the HTTP API. Every page sits under /guide/, so the
      // halves are keyed page by page: no file moves and no published URL
      // changes. See "Documentation sites" in the workspace AGENTS.md.
      nav: [
        { text: 'Users', link: '/guide/what-is-openbridge' },
        { text: 'Developers', link: '/guide/creating-a-plugin' },
        {
          text: 'Project',
          items: [
            { text: 'Repository', link: 'https://github.com/nubisco/openbridge' },
            {
              text: 'Contributing',
              link: 'https://github.com/nubisco/openbridge/blob/master/CONTRIBUTING.md',
            },
            { text: 'Plugin Marketplace', link: 'https://marketplace.openbridge.nubisco.io' },
            { text: 'Sponsor', link: 'https://github.com/sponsors/joseporto' },
          ],
        },
        {
          text: 'Nubisco',
          items: [
            { text: 'nubisco.io', link: 'https://nubisco.io' },
            { text: 'Nubisco UI', link: 'https://docs.nubisco.io/ui/' },
            { text: 'Acta', link: 'https://docs.nubisco.io/acta/' },
            { text: 'Verba', link: 'https://docs.nubisco.io/verba/' },
          ],
        },
      ],

      sidebar: {
        '/guide/creating-a-plugin': developers,
        '/guide/plugin-api': developers,
        '/guide/homekit-exposure': developers,
        '/guide/api-reference': developers,
        '/guide/architecture': developers,
        '/': users,
      },

      search: { provider: 'local' },

      footer: {
        message:
          'Released under the <a href="https://github.com/nubisco/openbridge/blob/master/LICENSE">MIT License</a>. · <a href="https://github.com/sponsors/joseporto">♥ Sponsor this project</a>',
        copyright: 'Copyright © 2026 <a href="https://nubisco.io">Nubisco</a>',
      },

      socialLinks: [{ icon: 'github', link: 'https://github.com/nubisco/openbridge' }],

      editLink: {
        pattern: 'https://github.com/nubisco/openbridge/edit/master/apps/docs/docs/:path',
        text: 'Suggest changes to this page',
      },
    },
  }),
)
