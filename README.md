# Horizon Browser

A fast, private, Chromium-based browser for Windows, built on Electron.
Starts with a splash screen that **looks for updates on GitHub**, downloads and installs them
automatically, then opens the browser.

## Run it

```bat
dev.bat          :: development mode
build.bat        :: builds dist\Horizon-Setup-x.y.z.exe and dist\Horizon-Portable-x.y.z.exe
```

Requires Windows 10/11 and Node.js 20+.

## Turn on auto-update (one-time setup)

1. Create a GitHub repository and push this project to it.
2. Edit `package.json`:
   ```json
   "horizon": { "githubOwner": "your-username", "githubRepo": "your-repo" }
   ```
3. Ship a version:
   * **Automatic:** `git tag v1.0.1 && git push --tags` — the included workflow
     (`.github/workflows/release.yml`) builds the installer and creates the release.
   * **Manual:** run `build.bat`, create a GitHub release tagged `v1.0.1`, upload
     `dist\Horizon-Setup-1.0.1.exe` to it.

On the next launch, installed copies show **Looking for updates… → Downloading update → Installing
update…**, restart on the new version, and continue. If GitHub can't be reached, Horizon just starts.
Downloads are only accepted from your repo's `releases/download` URL and are verified by size and
SHA-256 (when GitHub provides the digest). Settings → About also has **Check now**.
The portable build can't replace itself; it shows a "Download" notice instead.

## Features

* Tabs (drag to reorder, middle-click close, context menu, audio indicator, restore previous tabs)
* Address bar with bookmark / history / search suggestions
* Bookmarks (+ optional bookmarks bar), history grouped by day, downloads with pause / cancel
* Find in page, zoom, print, developer tools, page context menu, fullscreen video
* Tracker blocking, optional ad blocking, optional third-party cookie blocking, DNT + Global Privacy Control
* Camera / microphone / notification permission prompts
* Friendly error pages (offline, DNS, certificate problems, crashes)
* Dark / light / system theme, accent colours, interface size
* **Private window** (`Ctrl+Shift+N`): pure-black theme, memory-only session isolated from regular windows,
  no history, wiped when the last private window closes, JavaScript off by default
  (toggle it on the Private new-tab page; applies to new tabs)

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | New / close / reopen tab |
| Ctrl+N / Ctrl+Shift+N | New window / private window |
| Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1…9 | Switch tabs |
| Ctrl+L, Alt+D, F6 | Focus address bar |
| Ctrl+R, F5, Ctrl+Shift+R | Reload / hard reload |
| Alt+← / Alt+→ / Alt+Home | Back / forward / home |
| Ctrl+D, Ctrl+Shift+B | Bookmark page / bookmarks |
| Ctrl+H, Ctrl+J, Ctrl+, | History / downloads / settings |
| Ctrl+F, Ctrl+P, F12 | Find / print / developer tools |
| Ctrl+Plus, Ctrl+Minus, Ctrl+0 | Zoom |
| F11, Esc | Fullscreen / stop or close |

## Project layout

```
src/main/      index.js (windows, sessions, IPC, startup+update flow), updater.js, splash.js,
               blocker.js, store.js, preload.js, splash-preload.js
src/renderer/  browser.html/.css/.js (the browser UI), splash.html/.css/.js
src/shared/    shortcuts.js
assets/        icon.ico, icon.png
```

Data lives in `%APPDATA%\Horizon` (`horizon-data.json`, `horizon.log`).

## Known limits

* Windows installer is unsigned, so SmartScreen may warn on first run.
* No extensions, password manager or built-in sync.
* Screen sharing (`getDisplayMedia`) and geolocation aren't supported by Electron out of the box.
* Some sites (notably Google sign-in) may restrict embedded Chromium browsers.
