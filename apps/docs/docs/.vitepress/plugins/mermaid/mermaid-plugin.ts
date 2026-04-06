import { Plugin } from 'vite'
import { ExternalDiagramDefinition, MermaidConfig } from 'mermaid'

interface MermaidPluginOptions extends MermaidConfig {
  externalDiagrams: ExternalDiagramDefinition[]
}

export interface MermaidPluginConfig {
  class?: string
}

const DEFAULT_OPTIONS: MermaidConfig = {
  securityLevel: 'loose',
  startOnLoad: false,
}

export function MermaidPlugin(inlineOptions?: Partial<MermaidPluginOptions>): Plugin {
  const options = {
    ...DEFAULT_OPTIONS,
    ...inlineOptions,
  }

  const virtualModuleId = 'virtual:mermaid-config'
  const resolvedVirtualModuleId = '\0' + virtualModuleId

  return {
    name: 'vite-plugin-mermaid',
    enforce: 'post',

    transform(src, id) {
      if (id.includes('vitepress/dist/client/app/index.js')) {
        src = "\nimport Mermaid from '/.vitepress/plugins/mermaid/Mermaid.vue';\n" + src

        const lines = src.split('\n')

        const targetLineIndex = lines.findIndex((line) => line.includes('app.component'))

        lines.splice(targetLineIndex, 0, '  app.component("Mermaid", Mermaid);')

        src = lines.join('\n')

        return {
          code: src,
          map: null,
        }
      }
    },

    async resolveId(id) {
      if (id === virtualModuleId) {
        return resolvedVirtualModuleId
      }
    },

    async load(this, id) {
      if (id === resolvedVirtualModuleId) {
        return `export default ${JSON.stringify(options)};`
      }
    },
  }
}
