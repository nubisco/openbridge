import { readdirSync, readFileSync } from 'fs'

/**
 * Readings Linux keeps in files, read directly. systeminformation gets the
 * same numbers by starting a shell command, which forks the daemon on every
 * call. Measured on the Raspberry Pi this bridge runs on: 25 ms of CPU and one
 * new process per metrics tick, against 0.6 ms for reading the files.
 * Each function returns undefined where the file is not there, so the caller
 * can fall back to systeminformation on other systems.
 */

/** The interface the default route goes through, from /proc/net/route. */
export function defaultInterface(route: string): string | undefined {
  for (const line of route.split('\n').slice(1)) {
    const [iface, destination, , , , , , mask] = line.trim().split(/\s+/)
    if (iface && destination === '00000000' && (mask === undefined || mask === '00000000')) return iface
  }
  return undefined
}

/** Bytes received and sent so far on one interface, from /proc/net/dev. */
export function interfaceBytes(dev: string, iface: string): { rx: number; tx: number } | undefined {
  for (const line of dev.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0 || line.slice(0, colon).trim() !== iface) continue
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number)
    // receive: bytes packets errs drop fifo frame compressed multicast, then transmit: bytes ...
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) return undefined
    return { rx: fields[0], tx: fields[8] }
  }
  return undefined
}

/** Picks the CPU's zone among /sys/class/thermal zones, in degrees. */
export function cpuZoneTemperature(zones: Array<{ type: string; milli: number }>): number | undefined {
  const usable = zones.filter((z) => Number.isFinite(z.milli) && z.milli > 0)
  const cpu = usable.find((z) => /cpu|x86_pkg|soc/i.test(z.type)) ?? usable[0]
  return cpu ? cpu.milli / 1000 : undefined
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function readCpuTemperature(): number | undefined {
  let names: string[]
  try {
    names = readdirSync('/sys/class/thermal').filter((n) => n.startsWith('thermal_zone'))
  } catch {
    return undefined
  }
  const zones = names.map((n) => ({
    type: read(`/sys/class/thermal/${n}/type`)?.trim() ?? '',
    milli: Number(read(`/sys/class/thermal/${n}/temp`)),
  }))
  return cpuZoneTemperature(zones)
}

export function readDefaultInterfaceBytes(): { rx: number; tx: number } | undefined {
  const route = read('/proc/net/route')
  const dev = read('/proc/net/dev')
  if (route === undefined || dev === undefined) return undefined
  const iface = defaultInterface(route)
  return iface ? interfaceBytes(dev, iface) : undefined
}

/**
 * Busy and total CPU time so far, from the aggregate line of /proc/stat.
 * Busy counts the same fields systeminformation's currentLoad does: user,
 * nice, system, irq, steal and guest. Total adds idle.
 */
export function cpuTimes(stat: string): { busy: number; total: number } | undefined {
  const line = stat.split('\n').find((l) => l.startsWith('cpu '))
  if (!line) return undefined
  const [user, nice, system, idle, , irq, , steal = 0, guest = 0] = line.trim().split(/\s+/).slice(1).map(Number)
  if (![user, nice, system, idle, irq].every(Number.isFinite)) return undefined
  const busy = user + nice + system + irq + (steal || 0) + (guest || 0)
  return { busy, total: busy + idle }
}

export function readCpuTimes(): { busy: number; total: number } | undefined {
  const stat = read('/proc/stat')
  return stat === undefined ? undefined : cpuTimes(stat)
}
