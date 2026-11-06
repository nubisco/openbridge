# UI harness

Checks the web UI in a headless browser against recorded data: desktop screenshots that can be compared pixel for pixel between two builds, and a phone pass that measures whether anything sits past the screen edge.

The bridge it records from switches real devices. So every request that is not a GET is aborted, in every mode, and a replay never talks to a daemon at all.

## Setup

```sh
cd scripts/ui-harness
npm install
npx playwright install chromium-headless-shell
```

It is a standalone package, outside the pnpm workspace, so the app does not carry Playwright.

## Record once

Point it at a running daemon (for example an SSH tunnel to the bridge: `ssh -N -L 8582:localhost:8582 <host>`) through a built UI served by `vite preview`, which proxies `/api` to port 8582:

```sh
cd apps/ui && npx vite build --outDir /tmp/ob-before && npx vite preview --outDir /tmp/ob-before --port 4173 &
OB_SESSION='<openbridge_session cookie value>' DEVICE_ID='<a device id>' \
  node scripts/ui-harness/shoot.mjs record http://localhost:4173
```

This writes `api.har`. It contains the bridge's real configuration, camera credentials included, so it is git-ignored. Do not commit it or share it. Close the tunnel once the recording is done.

## Compare two builds

Build the baseline and the change into separate folders, serve each on any port, then:

```sh
node shoot.mjs desktop http://localhost:4173 out/before
node shoot.mjs desktop http://localhost:4174 out/after
node compare.mjs out/before out/after out/diff
```

Prove the harness is steady first: two runs of the same build should be identical apart from the avatar initials in the rail (about 13 px).

## Phone pass

```sh
node shoot.mjs phone http://localhost:4174 out/phone
```

It writes screenshots at 390x844, 360x740 and 844x390 with touch, plus `overflow.json`. A state is clean when `pageScrollWidth` equals `vw` and `offenders` is empty. Look at the screenshots as well: the numbers do not catch a cramped layout.

## Adding a page

Add an entry to `STATES` in `shoot.mjs`. `open` runs after the page loads, which is how the inspectors are reached. Record again if the new page asks for data the recording does not hold.
