import { defineNubiscoDocs } from '@nubisco/docs-sdk'

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
      { text: 'MCP endpoint', link: '/guide/mcp' },
      { text: 'Architecture', link: '/guide/architecture' },
    ],
  },
  {
    text: 'Back to the guide',
    items: [{ text: 'Using OpenBridge', link: '/guide/what-is-openbridge' }],
  },
]

// Project page, so the site is served from a subpath.
export default defineNubiscoDocs({
  title: 'OpenBridge',
  description: 'A modern, local-first home automation bridge built for developers.',
  base: '/openbridge/',
  hostname: 'https://docs.nubisco.io/openbridge/',
  repo: 'nubisco/openbridge',
  docsDir: 'apps/docs/docs/',

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
    '/guide/mcp': developers,
    '/guide/architecture': developers,
    '/': users,
  },

  footer: {
    message:
      'Released under the <a href="https://github.com/nubisco/openbridge/blob/master/LICENSE">MIT License</a>. · <a href="https://github.com/sponsors/joseporto">♥ Sponsor this project</a>',
    copyright: 'Copyright © 2026 <a href="https://nubisco.io">Nubisco</a>',
  },

  vitepress: {
    cleanUrls: true,
    ignoreDeadLinks: true,
  },
})
