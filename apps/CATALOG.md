# Nucleus catalogue apps — plugin contract

A catalogue app is a **self-contained single HTML file**. The Nucleus shell (`index.html`) never
loads tool code at startup: when an app opens, the shell creates one window containing one
sandboxed `<iframe>` pointing at the app's `entry` file. Closing the window destroys the iframe;
nothing stays resident.

The catalogue is designed to grow to hundreds of tools, so **an app file is the single source of
truth for its own metadata** and adding a tool never requires editing a shared file.

## Self-describing metadata (required)

Every app puts one block in `<head>`, right after `<title>`. `tools/nucleus-catalogue.mjs` scans
`apps/*.html`, reads these blocks, and generates the discovery indexes the shell fetches lazily.

```html
<script type="application/nucleus+json">
{"id":"yaml-toolkit","name":"YAML Toolkit","cat":"Developer Tools",
 "desc":"Convert YAML to JSON and back, with line-accurate errors.","icon":"terminal","w":760,"h":520}
</script>
```

| Field | Meaning |
| --- | --- |
| `id` | unique, lowercase, kebab-case, and **identical to the filename** (`<id>.html`). Used as the window key (`cat:<id>`). |
| `name` | shown in launcher, taskbar, title bar. Must equal `<title>`. |
| `cat` | one of the categories below — exact string, so indexes group correctly. |
| `desc` | one line, used in search and lists. Say what it does, not how. |
| `icon` | optional built-in shell icon name: browser, notepad, terminal, files, settings, wallpaper, tasks, calc, store, power. Omit/unknown → auto letter tile. |
| `w`,`h` | preferred window size (shell clamps to the desktop). |

Categories: `Developer Tools`, `Security & Forensics`, `Media & Files`, `Data & Calculations`,
`Productivity`, `Knowledge & Writing`, `Everyday Utilities`, `Education`, `Network & System`.

`entry` is **not** in the block — it is always `apps/<id>.html`, derived from the filename.

## How discovery works (why you must not edit shared files)

- `apps/index/categories.json` — tiny list of `{cat, file, count}`. Fetched when the Store opens,
  never at boot.
- `apps/index/<category-slug>.json` — that category's entries. Fetched when the Store is opened or
  searched. Metadata only; no tool code.
- `index.html` keeps a small `CAT_BUILTIN` core set inline so a double-clicked `file://` page still
  has a working catalogue. Over http(s) the generated indexes take over and the Store says so.
- Installing a tool stores its full metadata in the shell's own storage, so an installed tool keeps
  opening even when its category index is not loaded (and under `file://`).

So: **create your app files, do not touch `index.html`, `apps/manifest.json`, or `apps/index/`.**
The maintainer regenerates indexes with `node tools/nucleus-catalogue.mjs --write`.

## Hard rules for every app file

1. **Single file.** All HTML/CSS/JS inline in the one `.html`. No `fetch`, XHR, CDN, remote fonts,
   remote icons, or external libraries of any kind. The app must work with the network unplugged.
2. **No build step, no npm.** Vanilla JS only. Never `eval`/`new Function` on user input unless the
   task itself is a code runner, and then only inside an additional nested sandbox.
3. **XSS-safe DOM.** Use `textContent` and safe DOM APIs. Never assign user input to `innerHTML`.
   (Exception: a Markdown preview may build HTML from *escaped* content — see markdown-notes.)
4. **Theme sync.** Read `n-theme` and `n-accent` from the query string, listen for
   `postMessage({source:"nucleus-host",type:"theme",theme,accent})`, and reply once at load with
   `parent.postMessage({source:"nucleus-catalog",type:"ready"},"*")`. Copy the integration block from
   `_template.html` verbatim; it already does all of this.
5. **Storage.** The iframe is sandboxed without `allow-same-origin`, so `localStorage` throws
   `SecurityError`. Always go through the template's `store` helper: it uses `localStorage` when
   available (opened standalone) and silently falls back to in-memory when embedded, showing
   "session only, not persisted" in the footer when `store.persistent === false` inside Nucleus.
   Do not persist anything larger than ~100 KB total.
6. **Download/export** via `Blob` + `URL.createObjectURL` + an `<a download>` click. Works in the sandbox.
7. **Accessibility.** Semantic HTML, `aria-label` on icon-only buttons, visible focus
   (`:focus-visible` styling is in the template), keyboard-operable primary flows, respects
   `prefers-reduced-motion`, usable at 320 px width (apps open at clamped sizes too).
8. **Self-title.** `<title>` equals the metadata `name` — the shell can read it when importing.
9. Keep the file under ~60 KB so first-open stays instant.
10. **Never fake a result.** If a format, browser API or permission is unavailable, say so in the
    status line ("Clipboard image copy is not supported in this browser/context") and leave the
    previous output untouched. A control that appears to work but returns made-up data is a defect.
11. **Limits are labelled.** State the supported range in the UI (e.g. "byte mode, versions 1-10"),
    and reject input beyond it with a reason instead of silently truncating.

## Verifying an app

- Open it standalone: `open apps/<id>.html` directly (or via a static server) — everything must work.
- Open it inside Nucleus: theme toggle in Settings must repaint the app window live.
- No console errors on load; no network requests in DevTools' Network tab beyond the file itself.
- **Anything that computes must be checked against an outside truth**, not just against itself.
  The QR encoder passed every self-test and still produced unscannable version 7+ symbols; it was
  caught only by decoding the output with an independent scanner. For parsers, converters,
  encoders, hashers and calculators:
  1. keep the logic in one `<script>` section that ends with
     `if(typeof module!=="undefined")module.exports={...}` (see qr-generator),
  2. extract and run it under node against fixtures whose expected values come from a real
     implementation or a published test vector (RFC/ISO/known-good file),
  3. put the throwaway harness in your OS temp dir, never in the repo.
- Duplicate the app's own claim in the UI only when the test proves it.

## Adding a new app

1. Copy `_template.html` → `apps/<id>.html`, implement the tool, embed the metadata block.
2. Verify per the checklist above, including an independent-oracle test where the tool computes.
3. Hand the id list to the maintainer, who runs `node tools/nucleus-catalogue.mjs --write` to
   regenerate `apps/index/*` and `apps/manifest.json`, and `--check` to gate the whole catalogue.
