import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettierRecommended from 'eslint-plugin-prettier/recommended'
import globals from 'globals'

export default defineConfig(
  // Ignored paths
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/docs/.vitepress/cache/**',
      'apps/docs/.vitepress/dist/**',
      'apps/docs/docs/.vitepress/cache/**',
      'apps/docs/docs/.vitepress/dist/**',
    ],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended
  ...tseslint.configs.recommended,

  // Vue 3 recommended
  ...pluginVue.configs['flat/recommended'],

  // Vue files: use typescript-eslint parser for <script> blocks
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
  },

  // Daemon + CLI: Node.js globals
  {
    files: ['apps/daemon/**/*.{ts,js,mjs,cjs}', 'apps/cli/**/*.{ts,js,mjs,cjs}', 'packages/**/*.{ts,js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // UI: browser globals
  {
    files: ['apps/ui/**/*.{ts,js,vue}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Prettier must come last
  prettierRecommended,

  // Project-wide rule overrides
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'prettier/prettier': [
        'error',
        {
          singleQuote: true,
          trailingComma: 'all',
          printWidth: 120,
          tabWidth: 2,
          semi: false,
        },
      ],
      semi: 'off',
      '@typescript-eslint/semi': 'off',
    },
  },
)
