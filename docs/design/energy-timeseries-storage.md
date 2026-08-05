# Design: multi-metric time-series storage for energy devices

**Status:** implemented (items 1-7); see "Decisions taken" below
**Date:** 2026-08-05
**Motivates:** per-phase voltage / current / power charting in the OpenBridge UI

## Problem

The current energy history stores exactly one number per device. `sampleEnergyHistory()` in
`apps/daemon/src/daemon.ts` reads `telemetry.totalForwardEnergy`, appends `{ t, e }` to a JSON
array, and rewrites the whole file. `GET /api/devices/:id/history` reads that array back and
buckets it into day / month / year kWh totals.

That is sufficient for a single cumulative counter and nothing else. Three limits block
per-phase electrical charting:

1. **One series per device.** Voltage, current, power and power factor have nowhere to go.
2. **Five-minute resolution.** Fine for energy, which accumulates on the device and is exact
   regardless of sampling rate. Useless for power, which is instantaneous: a heat pump that
   cycles on and off between samples is invisible.
3. **Full-file rewrite per sample.** The file is parsed, filtered and re-serialised on every
   tick, for every device.

## Measured baseline

Reproducing the current format at its documented retention (2 years of 5-minute samples,
210,240 entries):

| Measurement                                                 | Value                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| File size                                                   | 9.8 MB per device (48.7 bytes per sample, for one metric)          |
| One sample tick (read + parse + filter + serialise + write) | 40 ms                                                              |
| One day-view query                                          | 39 ms (the route filters the full array once per bucket, 24 times) |

The 40 ms tick is per device. A single Shelly 3EM registers four devices, so one sampling cycle
already costs ~160 ms of blocking CPU, growing linearly with both device count and retention.

Projecting the current format to the target (6 metrics, 10-second resolution) gives roughly
307 MB per series per year and a tick cost 30x higher on a file 30x larger. It does not scale;
this is a format change, not a tuning exercise.

## Proposal

### 1. Fixed-width binary records

One record per timestamp holding every metric for that device:

```text
offset 0   uint32   unix seconds
offset 4   float32  metric 0
offset 8   float32  metric 1
...
```

For six metrics that is **28 bytes for all six**, against 48.7 bytes for one metric today.
Records are fixed-width and time-ordered, so a time range is an offset calculation and a single
`readSync`, with no parsing and no full scan.

`float32` gives ~7 significant digits. That is ample for volts, amps, watts and power factor.
Cumulative energy needs care: a meter reading 2,376,037 Wh exceeds float32's exact integer
range, which is why energy is stored in kWh (2376.037) where the precision is comfortable.

### 2. Retention tiers with rollups

Each tier is its own file. A tick appends to the raw tier; a periodic job rolls older records
into coarser tiers and truncates the finer one.

| Tier        | Resolution | Retention   | Records | Size                   |
| ----------- | ---------- | ----------- | ------- | ---------------------- |
| raw         | 10 s       | 48 hours    | 17,280  | 0.97 MB                |
| minute      | 1 min      | 30 days     | 43,200  | 1.21 MB                |
| five-minute | 5 min      | 1 year      | 105,120 | 2.94 MB                |
| hour        | 1 h        | 5 years     | 43,800  | 1.23 MB                |
| **total**   |            | **5 years** |         | **6.35 MB per device** |

Compare with today: **9.8 MB per device for one metric at 5-minute resolution over 2 years.**
The proposal stores six metrics, at 10-second resolution recently, over five years, in 35% less
space.

Rollup rules differ by metric kind, which is why the descriptor must declare the kind:

- **Instantaneous** (power, voltage, current, power factor): store mean, min and max when rolling
  up, so a chart of an hour-tier range still shows that power peaked at 3 kW rather than
  averaging the spike away. This triples the width of rolled tiers and is why the table above is
  a floor, not a ceiling.
- **Cumulative** (forward and returned energy): keep the last value in the window. Bucket totals
  are then a subtraction between window edges, exactly as the current route computes kWh.

### 3. Measured against the proposal

Same machine, same method as the baseline:

| Measurement              | Current         | Proposed          | Change                      |
| ------------------------ | --------------- | ----------------- | --------------------------- |
| One sample tick          | 40 ms           | 0.021 ms          | ~1900x faster (append only) |
| One day-view query       | 39 ms           | 0.224 ms          | ~174x faster                |
| Bytes read per day query | whole file      | 0.27% of the file | seek, not scan              |
| Bytes per timestamp      | 48.7 (1 metric) | 28 (6 metrics)    | ~10x per metric             |

The tick improvement comes from removing the read-modify-write entirely: appending a 28-byte
record never touches existing data.

### 4. Metric declaration in the device descriptor

Storage cannot infer that `power` is instantaneous and `totalForwardEnergy` is cumulative, and
the UI cannot infer that one is watts and the other kilowatt-hours. Plugins already declare
`widgetType`; they should also declare their series:

```typescript
interface MetricDescriptor {
  key: string // matches the telemetry key
  label: string // "Power", "Voltage"
  unit: string // "W", "V", "A", "kWh"
  kind: 'instant' | 'cumulative'
  precision?: number // display decimals
}

interface DeviceDescriptor {
  // ...existing fields
  metrics?: MetricDescriptor[]
}
```

This keeps plugins data-only. No plugin ships UI code; core renders any device that declares
metrics, including devices from plugins that do not exist yet. It also makes the storage layer
generic: nothing in it is specific to energy.

### 5. API

Replace the energy-specific route with a metric-aware one:

```text
GET /api/devices/:id/history?metric=power&from=...&to=...&resolution=auto
```

`resolution=auto` picks the finest tier that covers the range in a sensible number of points.
Keep the existing route working, mapped onto `metric=totalForwardEnergy` with the current
bucketing, so the shipped UI is not broken by the change.

## Migration

Existing files are `~/.openbridge/energy-history/<deviceId>.json`. On first start after upgrade,
convert each into the new tier files, mapping `e` to the `totalForwardEnergy` column and leaving
other columns empty for historical records. The data is 5-minute cumulative energy, so it lands
in the five-minute tier cleanly. Keep the JSON file as `.json.bak` for one release.

## Work breakdown

| #   | Item                                               | Notes                                                            |
| --- | -------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `MetricDescriptor` in `packages/core/src/types.ts` | Additive, no breaking change                                     |
| 2   | Store: append, tier rollup, truncate, range read   | The bulk of the work; unit-testable in isolation                 |
| 3   | Replace `sampleEnergyHistory()`                    | Sample interval driven by the finest tier, not a fixed 5 minutes |
| 4   | Metric-aware history route, old route preserved    |                                                                  |
| 5   | Migration from the JSON format                     | One-shot, on start                                               |
| 6   | Multi-series chart component                       | Needs the dataviz treatment; several series, two axes            |
| 7   | Device detail page with breadcrumbs                | NubiscoUI breadcrumbs already integrated                         |
| 8   | Declare metrics in the Shelly and Tuya plugins     | Small, per plugin                                                |

Items 1 to 5 are backend and independently shippable: the existing chart keeps working
throughout. Items 6 and 7 are the visible payoff.

## Decisions taken

The three questions this document originally left open were resolved as follows.

**Sampling cadence.** The store samples on its own timer at the finest tier's
cadence rather than having plugins push every reading. Storage stays independent
of how fast any plugin polls, and a one-second poller cannot flood the disk. The
cost is that a spike landing between ticks is not recorded.

**Where min/max belongs.** Kept for instant metrics by default, and controllable
per metric through `trackExtremes`. Voltage and power factor barely move, so the
Shelly plugin disables it for voltage and keeps it for power and current.

**Retention configurability.** Fixed tiers for now. At roughly 6 MB per device
there is little pressure to tune them, and fixed sizes keep rollup simple.

## Open questions

- **Sampling cadence vs poll cadence.** The Shelly plugin polls every 5 s by default and the raw
  tier is 10 s. Either the store samples the latest telemetry on its own timer, or plugins push
  every reading. The former is simpler and decouples storage from plugin behaviour; it discards
  readings between ticks, which for `min`/`max` fidelity may matter.
- **Where min/max belongs.** Storing mean+min+max on rolled tiers triples their width. Worth it
  for power, wasteful for voltage. Possibly a per-metric flag in `MetricDescriptor`.
- **Retention configurability.** Fixed tiers keep the implementation simple; users with large
  installations may want to trade space for depth.
