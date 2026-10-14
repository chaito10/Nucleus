# Agent Instructions: Single-File Browser OS

## Mission
Build a polished desktop-style OS simulation as one portable HTML file. It should feel like a lightweight OS running in a browser: wallpaper, movable windows, bottom taskbar, launcher, and built-in Browser, Notepad, Terminal, Files, Settings, Wallpaper, Task Manager, and Power menu.

Deliver `index.html` plus this `AGENTS.md`. The app's HTML, CSS, and JavaScript must all live in `index.html`. Do not create a framework project, package manifest, build pipeline, backend, or required local server.

## Non-negotiable constraints
1. **Single file:** all app HTML/CSS/JS live in `index.html`, organized into clearly labelled sections.
2. **Double-click runnable:** opening `index.html` directly in a modern browser (`file://`) must start the app. No installation, compilation, Node.js, npm, dev server, or backend.
3. **Browser-only/local-first:** core features work offline and save data locally where browser APIs permit.
4. If tooling is needed, prefer **Bun**. Do not introduce npm or Node-based setup steps. Tooling should not be needed for normal use.
5. Every visible control must work or be clearly labelled as a prototype/unsupported.
6. Use WebAssembly only when it provides a concrete benefit (e.g., a sandboxed scripting runtime). Core desktop/windows/apps should use browser-native HTML/CSS/JS. Do not add WASM just for branding.
7. Never run arbitrary terminal input with `eval`, `new Function`, or unrestricted JavaScript execution. Terminal commands must be allowlisted and operate on a virtual filesystem.
8. A browser page cannot power off/reboot the real computer, manage host processes, or execute arbitrary host shell commands. Implement in-app simulations and explain this limitation.
9. No hidden network dependency. Optional remote content must have local fallbacks.
10. No telemetry or secret collection. Never transmit notes, commands, or wallpaper images.

## Visual direction
Build a coherent, modern, lightweight desktop—not a website made of cards.
- Full-viewport desktop with a **taskbar fixed to the bottom**, always above app windows.
- Taskbar: launcher, pinned apps, running-app indicators, clock/date, system tray/settings.
- Default wallpaper must be CSS/inline SVG or gradient; no remote image required.
- Window chrome: app icon/title, minimize, maximize/restore, close.
- Movable windows, sensible minimum dimensions, active-window styling, scrollable app content, and resize handles where practical.
- Light/dark themes, accessible contrast, visible focus, reduced-motion support, and responsive behavior.
- Prefer inline SVG/CSS icons; avoid remote icon fonts.
- On small screens, use a usable mobile app-switcher/window layout rather than unusable overlapping windows.

## Desktop and window manager
- Open apps from launcher, shortcuts, and taskbar.
- Clicking a window brings it to front.
- Drag by title bar, excluding title-bar buttons; resize where supported.
- Minimize to taskbar; restore/focus from taskbar; maximize/restore; close.
- Keep windows inside the usable desktop area above the taskbar.
- Clean up app listeners/timers on close.
- Avoid text selection during dragging but preserve selection in app content.
- Keep keyboard focus and z-order predictable.
- Launcher lists apps and filters by typed text.
- Show running-vs-pinned state; clock/date updates while open.
- System tray contains theme and clearly simulated status controls.
- Desktop shortcuts: Browser, Notepad, Terminal, Files, Settings, Wallpaper, Task Manager. Double-click opens; keyboard activation must work.

## Built-in apps

### Browser
- Address/search field plus back, forward, reload, home.
- Accept URLs and search terms.
- Use a sandboxed iframe only when the target permits embedding. Many sites block framing; provide a clear explanation and an **Open externally** action in a normal browser tab.
- Never claim all websites work inside the app. Do not bypass site protections, proxy pages, or collect credentials.
- Make clear this is an in-app browser view, not a replacement for the host browser.

### Notepad
- Plain-text editor, New/Open/Save/Save As where supported, document title, unsaved-change indicator.
- Autosave drafts locally; support Ctrl/Cmd+S and Ctrl/Cmd+N when focused.
- Store multiple notes; rename/delete with confirmation.
- Never render note contents as HTML.
- Provide text/JSON export and import; validate imported data.

### Terminal
Implement a terminal-like UI with prompt, scrollback, command history, ArrowUp/ArrowDown navigation, and helpful errors. Commands operate only on a virtual filesystem:
- `help`, `clear`, `date`, `echo <text>`, `whoami`
- `pwd`, `ls [path]`, `cd <path>`, `cat <path>`
- `mkdir <path>`, `touch <path>`, `write <path> <text>`, `rm <path>`, `tree`
- `history`, `apps`, `open <app>`, `theme light|dark|system`
- `wallpaper`, `tasks`, `about`

Rules:
- Parse commands safely; do not evaluate arbitrary code.
- Do not expose host paths or host filesystem access. Clearly label files as virtual.
- Quote/escape behavior must be predictable.
- `Ctrl+C` cancels the current simulated operation or clears the input; never claim it kills host processes.
- If adding a WASM scripting runtime, expose only a narrow explicit API to the virtual filesystem and app launcher. Do not expose DOM, `window`, arbitrary JS, network, or host filesystem access to scripts.
- Never imply `ls`, `rm`, `ps`, `kill`, `shutdown`, or similar commands affect the host OS.

### Files
- Virtual file explorer for app-created files/folders.
- Create folders, rename/delete, open text files in Notepad, import/export where practical.
- Distinguish virtual files from files on the real computer.
- Do not request broad filesystem permissions. Optional File System Access API use must be explicit and user initiated, with graceful fallback.

### Settings
- Light/dark/system theme; accessible accent-color choices.
- Clock format (12/24-hour), date display, and optional density/scale controls.
- Optional toggles for desktop shortcuts/taskbar labels.
- Reset settings only after confirmation.
- Persist preferences locally.

### Wallpaper
Build a dedicated Wallpaper app with:
- Built-in gradients and CSS/inline-SVG wallpapers.
- Upload and preview a user-selected image before applying.
- Fit modes: cover, contain, stretch.
- Position controls (center/directional presets or X/Y sliders).
- Overlay/dimming control to keep icons readable.
- Solid-color/gradient fallback and reset-to-default.
- Persist settings locally when possible; never upload images.

Prefer IndexedDB for image blobs because localStorage quotas are small. Handle quota/storage errors. If the image cannot be persisted, explain that it lasts only for the current session and offer re-selection.

### Task Manager
- List app windows with app name, active/minimized state, and best-effort session duration.
- Focus, minimize, or close an app window.
- Show memory/performance only when supported by browser APIs and label estimates clearly.
- If showing a process list, label it as simulated. Never claim to inspect or terminate real OS processes.
- Closing a task must clean up its timers/listeners.

### Power menu
- **Lock/Sleep**, **Restart desktop**, and **Shut down desktop** apply to the web app only.
- Lock shows a dismissible lock screen; do not create a fake password prompt implying real security.
- Restart resets desktop session state without deleting saved notes/settings.
- Shut down shows an in-app shutdown screen; a visible button or click/tap returns to desktop.
- Explicitly state these controls do not power off/restart the computer.

### Optional Calculator
Add only after the core features work. Use button-based arithmetic or a safe expression parser; never `eval`.

## Storage and offline
- Use IndexedDB for notes, virtual files, and image blobs; guarded localStorage fallback for small settings.
- Handle private browsing, quota limits, unavailable storage, and browser resets without crashing.
- Offer export/import for notes and virtual filesystem data.
- Treat imported JSON as untrusted; validate schema, size, and types.
- The HTML itself must start without a network connection.
- Any optional remote library/WASM binary must have a clear offline fallback.
- Do not use OPFS as the sole storage layer because it may be unavailable under `file://`.
- A double-clicked single HTML file cannot register a conventional service worker; service workers normally need a separate script on a secure origin. Do not promise PWA installation/service-worker caching while preserving the single-file, server-free constraint.

## Accessibility and security
- Use semantic HTML and ARIA labels for icon-only controls, windows, dialogs, and launcher.
- Keyboard access for all functions; visible focus; sensible focus restoration.
- Do not rely on color alone. Respect `prefers-reduced-motion` and browser zoom up to 200%.
- Do not hijack common browser shortcuts globally or disable zoom.
- Treat terminal input, notes, imported files, and URLs as untrusted.
- Use `textContent`/safe DOM APIs; never inject untrusted content with `innerHTML`.
- Never use `eval`, `new Function`, dynamic script injection, or unrestricted execution.
- Validate URLs; permit only `http:`, `https:`, and safe internal app routes. Reject `javascript:` and other executable schemes.
- Apply an appropriate iframe `sandbox`; grant no unnecessary capabilities.
- No insecure fake login, password storage, analytics, tracking, remote fonts, or remote icon scripts.

## Implementation plan
Work incrementally; test each milestone before continuing.

1. **Desktop shell:** desktop, default wallpaper, bottom taskbar, launcher, clock, app registry, window open/focus/minimize/maximize/restore/close and dragging.
2. **Settings and Wallpaper:** themes, persistence, built-in wallpapers, upload, fit/position/dimming, fallback behavior.
3. **Notepad and Files:** local notes, virtual filesystem, import/export, validation.
4. **Terminal:** allowlisted commands and history connected to the virtual filesystem/app registry through explicit functions.
5. **Browser and Task Manager:** navigation/search, iframe limitations, external navigation, window management.
6. **Power menu and polish:** lock/restart/shutdown simulation, accessibility, responsive behavior, errors, consistency.
7. **Validation:** remove or label unfinished controls; test direct file opening, offline startup, persistence, and all core interactions.

## Definition of done
- [ ] One self-contained `index.html`; no build or server required.
- [ ] Direct opening in a modern browser starts the desktop.
- [ ] Fixed bottom taskbar, launcher, shortcuts, clock, wallpaper work.
- [ ] Windows open, focus, move, resize where supported, minimize, maximize, restore, and close.
- [ ] Browser, Notepad, Terminal, Files, Settings, Wallpaper, and Task Manager have working core features.
- [ ] Wallpaper can be selected/uploaded, previewed, fitted, positioned, dimmed, reset, and persisted where supported.
- [ ] Terminal commands are allowlisted and only affect the virtual environment.
- [ ] Notes/settings persist where supported and can be exported.
- [ ] Power controls affect only the simulated desktop and say so clearly.
- [ ] No knowingly dead/misleading controls or unsafe code execution/HTML injection.
- [ ] Core app starts and works offline.
- [ ] Mouse, keyboard, zoom, and smaller screens are usable.
- [ ] Help/About documents browser sandbox and persistence limitations.

## Coding agent's final report
When done, report what was implemented, what is simulated and why, browser/storage limitations, tests actually run and their results, and known gaps. Never claim unperformed tests or unfinished features as complete.
