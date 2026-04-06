<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useLayoutStore } from '@/stores/layout'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'

const layout = useLayoutStore()
const containerEl = ref<HTMLElement | null>(null)
const terminal = shallowRef<Terminal | null>(null)
const fitAddon = shallowRef<FitAddon | null>(null)
const searchAddon = shallowRef<SearchAddon | null>(null)
let ws: WebSocket | null = null
let resizeObserver: ResizeObserver | null = null

const searchQuery = ref('')
const connected = ref(false)

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws/terminal`)

  ws.onopen = () => {
    connected.value = true
  }

  ws.onmessage = (e) => {
    terminal.value?.write(e.data as string)
  }

  ws.onclose = () => {
    connected.value = false
    terminal.value?.write('\r\n\x1b[90m— disconnected, reconnecting in 3s…\x1b[0m\r\n')
    setTimeout(connect, 3000)
  }

  ws.onerror = () => {
    ws?.close()
  }
}

function doSearch() {
  if (searchQuery.value) {
    searchAddon.value?.findNext(searchQuery.value, { caseSensitive: false, regex: false })
  }
}

function clearTerminal() {
  terminal.value?.clear()
}

onMounted(() => {
  layout.setPage('Logs')

  const term = new Terminal({
    theme: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      selectionBackground: 'rgba(88,166,255,0.3)',
      black: '#0d1117',
      brightBlack: '#6e7681',
      red: '#ff7b72',
      brightRed: '#ffa198',
      green: '#3fb950',
      brightGreen: '#56d364',
      yellow: '#d29922',
      brightYellow: '#e3b341',
      blue: '#58a6ff',
      brightBlue: '#79c0ff',
      magenta: '#bc8cff',
      brightMagenta: '#d2a8ff',
      cyan: '#39c5cf',
      brightCyan: '#56d4dd',
      white: '#b1bac4',
      brightWhite: '#f0f6fc',
    },
    fontFamily: '"MesloLGS NF", monospace',
    fontSize: 12.5,
    lineHeight: 1.5,
    cursorStyle: 'block',
    cursorBlink: false,
    scrollback: 5000,
    convertEol: true,
    disableStdin: true,
    allowTransparency: false,
  })

  const fit = new FitAddon()
  const search = new SearchAddon()

  term.loadAddon(fit)
  term.loadAddon(search)

  terminal.value = term
  fitAddon.value = fit
  searchAddon.value = search

  if (containerEl.value) {
    term.open(containerEl.value)
    fit.fit()
  }

  // Re-fit when the container resizes
  resizeObserver = new ResizeObserver(() => fit.fit())
  if (containerEl.value) resizeObserver.observe(containerEl.value)

  connect()
})

onBeforeUnmount(() => {
  ws?.close()
  ws = null
  resizeObserver?.disconnect()
  terminal.value?.dispose()
})
</script>

<template>
  <div class="logs-view">
    <div class="logs-toolbar">
      <div class="conn-dot" :class="connected ? 'live' : 'dead'" :title="connected ? 'Connected' : 'Disconnected'" />
      <span class="conn-label">{{ connected ? 'Live' : 'Reconnecting…' }}</span>
      <div class="toolbar-sep" />
      <div class="search-wrap">
        <NbIcon name="magnifying-glass" :size="13" class="search-icon" />
        <input
          v-model="searchQuery"
          class="search-input"
          placeholder="Search logs…"
          @input="doSearch"
          @keydown.enter="doSearch"
        />
      </div>
      <button class="btn-clear" title="Clear terminal" @click="clearTerminal">
        <NbIcon name="trash" :size="13" />
        Clear
      </button>
    </div>

    <div ref="containerEl" class="terminal-container" />
  </div>
</template>

<style lang="scss" scoped>
@use '@xterm/xterm/css/xterm.css';

.logs-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  min-height: 0;
}

.logs-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
}

.conn-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  &.live {
    background: #34d399;
    box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.25);
  }
  &.dead {
    background: #6b7280;
  }
}
.conn-label {
  font-size: 0.75rem;
  color: #6b7280;
}

.toolbar-sep {
  width: 1px;
  height: 18px;
  background: #e8e8f0;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 8px;
  color: #9ca3af;
  pointer-events: none;
}
.search-input {
  padding: 0.3rem 0.5rem 0.3rem 1.85rem;
  border: 1px solid #e8e8f0;
  border-radius: 6px;
  font-size: 0.8rem;
  outline: none;
  background: #fff;
  width: 200px;
  &:focus {
    border-color: #a78bfa;
  }
}

.btn-clear {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid #e8e8f0;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 500;
  background: #fff;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.12s;
  &:hover {
    border-color: #fca5a5;
    background: #fef2f2;
    color: #dc2626;
  }
}

.terminal-container {
  flex: 1;
  min-height: 0;
  border-radius: 10px;
  overflow: hidden;
  background: #0d1117;

  // xterm.js internals — needs non-scoped piercing in Vue
  :deep(.xterm) {
    height: 100%;
  }
  :deep(.xterm-viewport) {
    border-radius: 10px;
  }
  :deep(.xterm-screen) {
    padding: 0.5rem;
  }
}
</style>
