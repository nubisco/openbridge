// Headless check of the OpenBridge UI against recorded data.
//
//   node shoot.mjs record  <baseUrl>          record the API into api.har (GET only)
//   node shoot.mjs desktop <baseUrl> <outDir> screenshots at 1440, 1024 and 700
//   node shoot.mjs phone   <baseUrl> <outDir> 390x844, 360x740, 844x390 with touch,
//                                             plus overflow.json
//
// The bridge switches real lights, pumps and heaters, so every request that is
// not a GET is aborted, in every mode. Replays never reach a daemon at all:
// the API comes from api.har, the clock is frozen and websockets are closed, so
// two runs of the same build give the same pixels.
//
// Recording needs a signed-in session: set OB_SESSION to the value of the
// openbridge_session cookie. api.har holds the bridge's real config, so it is
// git-ignored. Never commit it.
import { chromium } from 'playwright'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [mode, base, outDir = join(here, 'out', mode ?? '')] = process.argv.slice(2)
if (!['record', 'desktop', 'phone'].includes(mode) || !base) {
  console.error('usage: node shoot.mjs record|desktop|phone <baseUrl> [outDir]')
  process.exit(2)
}
const har = join(here, 'api.har')
const API = /\/(api|auth)\//
const FROZEN = new Date('2026-11-05T10:00:00Z')

// The pages to capture. `open` runs after the page loads, to reach an inspector.
// DEVICE_ID picks the device whose detail page is shot.
const STATES = [
  { name: 'dashboard', path: '/dashboard' },
  { name: 'devices', path: '/devices' },
  { name: 'devices-inspector', path: '/devices', open: (p) => clickFirst(p, ['.device-card', '.nb-card', 'tbody tr']) },
  { name: 'device-detail', path: '/devices/' + (process.env.DEVICE_ID ?? '') },
  { name: 'plugins', path: '/plugins' },
  { name: 'plugins-inspector', path: '/plugins', open: (p) => clickFirst(p, ['tbody tr', '.plugin-card', '.nb-card']) },
  { name: 'config', path: '/config' },
  { name: 'settings', path: '/settings' },
  { name: 'terminal', path: '/terminal' },
]

// Clicks near the top-left corner of the first match, which is its name, never
// a switch or a button inside the card.
async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const box = await page
      .locator(selector)
      .first()
      .boundingBox()
      .catch(() => null)
    if (box) {
      await page.mouse.click(box.x + 12, box.y + 12)
      return
    }
  }
}

// A HAR stores absolute URLs, so a recording made on one port would match
// nothing on another. Rewrite its origin to the server under test.
function harFor(baseUrl) {
  const data = JSON.parse(readFileSync(har, 'utf8'))
  const recorded = new URL(data.log.entries[0].request.url).origin
  const target = new URL(baseUrl).origin
  if (recorded === target) return har
  const copy = join(here, 'out', 'api.replay.har')
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(copy, JSON.stringify(data).split(recorded).join(target))
  return copy
}

async function prepare(context, record) {
  if (process.env.OB_SESSION) {
    await context.addCookies([{ name: 'openbridge_session', value: process.env.OB_SESSION, url: base }])
  }
  await context.route('**/*', (route) => (route.request().method() === 'GET' ? route.fallback() : route.abort()))
  if (record) {
    await context.routeFromHAR(har, { url: API, update: true, updateContent: 'embed' })
  } else {
    await context.routeFromHAR(harFor(base), { url: API, notFound: 'abort' })
    await context.routeWebSocket(/.*/, (ws) => ws.close())
  }
}

async function visit(page, state, record) {
  await page.goto(base + state.path, { waitUntil: 'networkidle' }).catch(() => {})
  await page.waitForTimeout(record ? 2500 : 1200)
  if (state.open) {
    await state.open(page)
    await page.waitForTimeout(record ? 2500 : 1200)
  }
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })
  await page.waitForTimeout(300)
}

// What a phone user would have to swipe to see: visible elements past either
// edge that no sideways-scrolling ancestor contains, and areas that scroll
// sideways themselves.
function overflowReport(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const clipped = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(n).overflowX)) return true
      }
      return false
    }
    const name = (el) =>
      el.tagName.toLowerCase() +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '')
    const offenders = new Set()
    const swipe = new Set()
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (!r.width || !r.height || cs.visibility === 'hidden') continue
      if ((r.right > vw + 1 || r.left < -1) && !clipped(el)) offenders.add(name(el))
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2) {
        swipe.add(`${name(el)} ${el.clientWidth}<${el.scrollWidth}`)
      }
    }
    return {
      vw,
      pageScrollWidth: document.documentElement.scrollWidth,
      offenders: [...offenders].slice(0, 15),
      swipe: [...swipe].slice(0, 8),
    }
  })
}

const SIZES = {
  desktop: [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 700, height: 900 },
  ],
  phone: [
    { width: 390, height: 844, touch: true },
    { width: 360, height: 740, touch: true },
    { width: 844, height: 390, touch: true },
  ],
}

const browser = await chromium.launch()
try {
  if (mode === 'record') {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await prepare(context, true)
    const page = await context.newPage()
    for (const s of STATES) await visit(page, s, true)
    // Phone layouts can ask for different data, so walk them too.
    await page.setViewportSize({ width: 390, height: 844 })
    for (const s of STATES) await visit(page, s, true)
    await context.close()
    console.log('recorded', har)
  } else {
    if (!existsSync(har)) throw new Error(`no ${har}: run "node shoot.mjs record <baseUrl>" first`)
    mkdirSync(outDir, { recursive: true })
    const report = {}
    for (const size of SIZES[mode]) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 1,
        hasTouch: !!size.touch,
        isMobile: !!size.touch,
        reducedMotion: 'reduce',
        colorScheme: 'light',
      })
      await prepare(context, false)
      const page = await context.newPage()
      await page.clock.install({ time: FROZEN })
      await page.clock.pauseAt(FROZEN)
      for (const s of STATES) {
        await visit(page, s, false)
        const label = `${s.name}@${size.width}x${size.height}`
        await page.screenshot({ path: join(outDir, `${label}.png`), fullPage: mode === 'desktop' })
        if (mode === 'phone') report[label] = await overflowReport(page)
      }
      await context.close()
    }
    if (mode === 'phone') writeFileSync(join(outDir, 'overflow.json'), JSON.stringify(report, null, 2))
    console.log('wrote', outDir)
  }
} finally {
  await browser.close()
}
