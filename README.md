# YouTube Music — macOS Desktop

A small, self-owned Electron wrapper around [music.youtube.com](https://music.youtube.com)
that feels native on macOS: hardware media keys, Now Playing / Control Center
integration, a menu-bar tray, and track-change notifications. No ad blocking (use
YouTube Premium), no forks — just a simple wrapper.

## Run it

```bash
npm install          # first time only
npm start            # generates icons, then launches the app
```

Sign in to Google in the window and play something.

## What you get

- **Hardware media keys + Now Playing** — the keyboard's play/pause/next keys
  control playback, and macOS Control Center shows the current track with
  artwork and a scrub bar. Enabled via one Chromium feature flag in `src/main.js`.
- **Menu-bar tray** — play/pause, next, previous, show/hide, quit, and a toggle
  for track notifications.
- **Track notifications** — a native macOS notification when the song changes
  (only while the window isn't focused).
- **Native feel** — persistent login, remembered window size/position, standard
  Cmd-C/V/Q menu, and external (non-music) links open in your default browser.

## Build a distributable app

```bash
npm run pack         # unpacked .app in dist/ (fastest)
npm run dist         # .dmg + .zip in dist/
```

The build is **unsigned** (no Apple Developer account needed). The first launch
of the produced app: right-click the `.app` ▸ **Open** to get past Gatekeeper.
Signing + notarization for sharing is a config-only change later (`mac.identity`
in `package.json`).

## Layout

```
src/main.js          app lifecycle, window, tray, media features
src/menu.js          native application menu
scripts/gen-assets.js  generates build/icon.png + tray icons (pure Node, no deps)
```

Icons are generated, not committed by hand — tweak the vectors in
`scripts/gen-assets.js` and re-run `npm run assets`.
