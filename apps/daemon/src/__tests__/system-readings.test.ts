import { describe, it, expect } from 'vitest'
import { cpuTimes, cpuZoneTemperature, defaultInterface, interfaceBytes } from '../system-readings.js'

// Copied from the Raspberry Pi the bridge runs on.
const ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
wlan0	0001A8C0	00000000	0001	0	0	3003	00FFFFFF	0	0	0
wlan0	00000000	0101A8C0	0003	0	0	3003	00000000	0	0	0
`
const DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567    8901    0    0    0     0          0         0  1234567    8901    0    0    0     0       0          0
 wlan0: 987654321 123456    0   12    0     0          0      3456 45678901   65432    0    0    0     0       0          0
`
const STAT = `cpu  4463030 141935 5488473 429876522 94832 0 145213 0 0 0
cpu0 1037059 32622 1493642 107396825 15346 0 33340 0 0 0
`

describe('system readings', () => {
  it('finds the interface the default route uses', () => {
    expect(defaultInterface(ROUTE)).toBe('wlan0')
    expect(defaultInterface(ROUTE.split('\n').slice(0, 2).join('\n'))).toBeUndefined()
  })

  it('reads received and sent bytes for one interface', () => {
    expect(interfaceBytes(DEV, 'wlan0')).toEqual({ rx: 987654321, tx: 45678901 })
    expect(interfaceBytes(DEV, 'eth0')).toBeUndefined()
  })

  it('reads the CPU zone, in degrees', () => {
    expect(
      cpuZoneTemperature([
        { type: 'battery', milli: 30000 },
        { type: 'cpu-thermal', milli: 45084 },
      ]),
    ).toBeCloseTo(45.084)
    expect(cpuZoneTemperature([{ type: 'acpitz', milli: 51000 }])).toBe(51)
    expect(cpuZoneTemperature([])).toBeUndefined()
  })

  it('counts busy CPU time the way currentLoad does', () => {
    // user + nice + system + irq + steal + guest; iowait and softirq are left out.
    expect(cpuTimes(STAT)).toEqual({
      busy: 4463030 + 141935 + 5488473 + 0,
      total: 4463030 + 141935 + 5488473 + 429876522,
    })
    expect(cpuTimes('nothing here')).toBeUndefined()
  })
})
