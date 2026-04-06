<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useLayoutStore } from '@/stores/layout'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

const layout = useLayoutStore()
const containerEl = ref<HTMLElement | null>(null)
const terminal = shallowRef<Terminal | null>(null)
const fitAddon = shallowRef<FitAddon | null>(null)
let ws: WebSocket | null = null
let resizeObserver: ResizeObserver | null = null
const connected = ref(false)

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws/shell`)

  ws.onopen = () => {
    connected.value = true
    // Send initial terminal size
    sendResize()
  }

  ws.onmessage = (e) => {
    terminal.value?.write(e.data as string)
  }

  ws.onclose = () => {
    connected.value = false
    terminal.value?.write('\r\n\x1b[90m— disconnected —\x1b[0m\r\n')
  }

  ws.onerror = () => ws?.close()
}

function sendResize() {
  if (!ws || ws.readyState !== ws.OPEN || !terminal.value) return
  ws.send(JSON.stringify({ type: 'resize', cols: terminal.value.cols, rows: terminal.value.rows }))
}

onMounted(async () => {
  layout.setPage('Terminal')

  // Ensure fonts are loaded before xterm measures glyph widths
  await document.fonts.ready

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
    fontSize: 13,
    lineHeight: 1.45,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000,
    convertEol: true,
    disableStdin: false,
    allowTransparency: false,
  })

  const fit = new FitAddon()
  term.loadAddon(fit)
  terminal.value = term
  fitAddon.value = fit

  if (containerEl.value) {
    term.open(containerEl.value)
    fit.fit()
  }

  // Send keystrokes to shell
  term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  })

  resizeObserver = new ResizeObserver(() => {
    fit.fit()
    sendResize()
  })
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
  <div class="terminal-view">
    <div class="terminal-topbar">
      <div class="conn-dot" :class="connected ? 'live' : 'dead'" />
      <span class="conn-label">{{ connected ? 'Connected' : 'Disconnected' }}</span>
    </div>
    <div ref="containerEl" class="terminal-container" />
  </div>
</template>

<style lang="scss" scoped>
@use '@xterm/xterm/css/xterm.css';

.terminal-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 0.5rem;
}

.terminal-topbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
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

.terminal-container {
  flex: 1;
  min-height: 0;
  border-radius: 10px;
  overflow: hidden;
  background: #0d1117;

  :deep(.xterm) {
    height: 100%;
  }
  :deep(.xterm-viewport) {
    border-radius: 10px;
  }
  :deep(.xterm-screen) {
    padding: 0.5rem;
  }
  :deep(.xterm-helper-textarea) {
    opacity: 0 !important;
    pointer-events: none !important;
  }
}
</style>
