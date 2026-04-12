# ask-pdf Development Plan

## What this project is

ask-pdf is a VS Code extension that opens PDF files in a rendered webview using pdf.js. Users can select text in the rendered PDF, and a floating action bar appears with a button to send the selected text and page reference to Claude Code. The extension runs a local MCP WebSocket server that Claude Code CLI connects to, and it **proactively broadcasts the current selection** to Claude Code whenever it changes — so when the user Tab-switches to their `claude` terminal and asks "explain this", Claude already knows exactly which passage they're looking at. It's the PDF counterpart to ask-markdown, following the same architecture and UX patterns.

## Repository layout

Current layout:

```text
ask-pdf/
  .gitignore
  .nvmrc
  .vscodeignore
  LICENSE
  README.md
  ask-pdf-development-plan.md
  claudecode-nvim-analysis.md
  package.json
  package-lock.json
  tsconfig.json
  eslint.config.mjs
  esbuild.js
  src/
    extension.ts            -- activation, commands, server lifecycle
    pdfProvider.ts          -- CustomReadonlyEditorProvider, webview HTML, selection mirror
    claudeServer.ts         -- MCP WebSocket server + JSON-RPC router + MCP tools
                               (holds module-level currentSelection / latestSelection state)
    pageMapper.ts           -- formats page reference strings
  media/
    preview.css             -- webview styles (theme-aware, action bar, zoom bar)
    preview.js              -- webview script (PDF rendering, selection, action bar, zoom controls)
    icon.png                -- extension icon
  dist/                     -- esbuild output (gitignored)
    extension.js
    extension.js.map
    pdfjs/                  -- copied pdf.js build files
      pdf.min.mjs
      pdf.worker.min.mjs
  releases/                 -- packaged .vsix files
```

All commands run from the repo root `/Users/ip33/Documents/GitHub/ask-pdf`.

---

## Phase 1 -- Project setup [DONE]

**Goal:** The project runs inside a pinned Node environment, compiles, lints, and produces a bundled extension that activates on PDF files.

**Status:** Complete. All scaffolding files exist. Build pipeline works (`npm run compile` exits 0).

**What was built:**

- [.nvmrc](.nvmrc) -- Pins Node.js to 20.11.1.
- [package.json](package.json) -- Extension metadata (v0.0.4), activation on `askPdf.preview`, custom editor for `*.pdf`, `ask-pdf.openPreview` command, `ask-pdf.showFloatingButton` setting. Dependencies: `pdfjs-dist`, `ws`. Priority set to `option` (not `default`).
- [tsconfig.json](tsconfig.json) -- TypeScript config (module Node16, target ES2022, strict).
- [eslint.config.mjs](eslint.config.mjs) -- Linting rules via `typescript-eslint`.
- [esbuild.js](esbuild.js) -- Bundles `src/extension.ts` to `dist/extension.js` (cjs, node, external vscode). Supports `--production` and `--watch`.
- [src/extension.ts](src/extension.ts) -- Activate/deactivate with server lifecycle and editor provider registration.
- [.gitignore](.gitignore) -- Ignores node_modules, dist, *.vsix, etc.
- [.vscodeignore](.vscodeignore) -- Excludes src, config files, docs, PDFs, VSIXes from the packaged extension.

**Commits:** `98fc70a`, `c7a9fa6`.

---

## Phase 2 -- PDF rendering in webview [DONE]

**Goal:** Opening a PDF file in VS Code shows all pages rendered in a webview with selectable text.

**Status:** Complete. PDFs open in a custom readonly editor, render all pages via pdf.js with HiDPI canvas support, and overlay selectable text layers.

**What was built:**

- [src/pdfProvider.ts](src/pdfProvider.ts) -- `AskPdfEditorProvider` implementing `CustomReadonlyEditorProvider`. Reads PDF binary, builds webview HTML with CSP (nonce-based script-src, blob worker-src), posts base64 PDF data on `ready` message. pdf.js library files served from `dist/pdfjs/`.
- [media/preview.js](media/preview.js) -- Webview script. Loads pdf.js dynamically via `import()`. Renders each page to a HiDPI-aware canvas (`devicePixelRatio` scaling) and overlays a `pdfjsLib.TextLayer` for selectable text. Uses a `renderToken` to abort stale renders during zoom changes. Preserves scroll position ratio across re-renders.
- [media/preview.css](media/preview.css) -- Theme-aware styles via `--vscode-*` CSS variables. Page containers with shadow, text layer overlay with `mix-blend-mode: multiply` selection highlight, loading/error states.

**Commit:** `4101bb8`.

---

## Phase 3 -- Floating action bar, zoom controls, and page mapping [DONE]

**Goal:** When text is selected in the PDF preview, a floating bar appears with a "Claude" button. The extension knows which page(s) the selection spans. Zoom controls let the user scale the PDF.

**Status:** Complete. Action bar appears above text selection, Claude button logs selection details. Zoom bar with +/-/Reset and keyboard/trackpad zoom. Page mapper utility exists.

**What was built:**

- [src/pageMapper.ts](src/pageMapper.ts) -- `formatPageRef(filePath, startPage, endPage)` returns `@file.pdf:page3` or `@file.pdf:page3-5` using workspace-relative path.
- [media/preview.js](media/preview.js) -- Updated with:
  - `findPageElement(node)` -- walks up DOM to nearest `.pdf-page` ancestor.
  - `selectionPageRange()` -- reads `data-page` from anchor/focus nodes, returns `{ text, startPage, endPage }`.
  - `#ask-bar` with "Claude" button. Positioned above selection bounding rect on `selectionchange` (100ms debounce) and `mouseup`. Hidden on deselection. Respects `data-enabled` attribute from `showFloatingButton` setting.
  - `#zoom-bar` with zoom out (−), zoom label (%), zoom in (+), and Reset buttons. Fixed position top-right.
  - Ctrl/Cmd+wheel zoom, Ctrl/Cmd+=/−/0 keyboard zoom.
  - Scale range 0.5x–4.0x, step 0.25, base 1.5x.
  - `mousedown` `preventDefault` on both bars to preserve text selection.
- [media/preview.css](media/preview.css) -- Updated with `#ask-bar` and `#zoom-bar` widget styles matching VS Code native appearance.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated to handle `askClaude` message (logging only at this phase), post `updateShowFloatingButton` on load and on config change.

**Commit:** `826c502`.

---

## Phase 4 -- MCP server foundation [DONE]

**Goal:** A Claude Code CLI that runs `/ide` in a terminal can find and connect to ask-pdf, complete the MCP handshake without errors, and receive an `at_mentioned` notification when the user clicks the "Claude" button.

**Status:** Complete. Server starts on activation, writes lock file, handles WebSocket upgrade with auth token, responds to `initialize` / `notifications/initialized` / `prompts/list` / `tools/list`.

**What was built:**

- [src/claudeServer.ts](src/claudeServer.ts) -- New file with:
  - Lock file at `~/.claude/ide/{port}.lock` (respects `$CLAUDE_CONFIG_DIR`). JSON shape: `{ pid, workspaceFolders, ideName: 'Ask PDF', transport: 'ws', authToken }`.
  - HTTP server bound to `127.0.0.1:0` (random ephemeral port).
  - WebSocket upgrade with `x-claude-code-ide-authorization` header, `crypto.timingSafeEqual` validation.
  - JSON-RPC dispatcher: `initialize` (protocol `2024-11-05`, full capabilities), `notifications/initialized` (no-op), `prompts/list` (`{ prompts: [] }`), `tools/list` (stub in this phase), `tools/call` (stub in this phase).
  - `broadcast(method, params)`, `isConnected()`, `startServer()`, `stopServer()`.
- [src/extension.ts](src/extension.ts) -- Updated to call `startServer()` on activate, `stopServer()` on deactivate.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated `askClaude` handler to call `broadcast('at_mentioned', ...)` if connected, or show warning if not. Focuses terminal after broadcast.

**Commit:** `0fafd61`.

---

## Phase 5 -- MCP tools and proactive selection broadcasting [DONE]

**Goal:** Claude Code gets live selection context without polling. The user selects text in the PDF, `selection_changed` fires over WebSocket, and Claude Code can call five MCP tools to query state on demand.

**Status:** Complete. All five tools implemented. Proactive `selection_changed` broadcasting works. Selection state tracked via `currentSelection` (cleared on deselection) and `latestSelection` (persists across deselections).

**What was built:**

- [src/claudeServer.ts](src/claudeServer.ts) -- Expanded with:
  - `PdfSelection` interface and module-level `currentSelection` / `latestSelection` state.
  - `setCurrentSelection` / `clearCurrentSelection` exports.
  - `selectionToPayload` helper (fakes LSP positions: `line` = 0-indexed page number, `character` = 0; includes extra `page` field for readability).
  - `broadcastSelectionChanged` fires `selection_changed` notification to all connected clients.
  - `mcpText(inner)` helper wrapping responses in double-encoded MCP JSON convention.
  - Five tool handlers: `getCurrentSelection`, `getLatestSelection`, `getOpenEditors` (enumerates `TabInputCustom` tabs ending in `.pdf`), `getWorkspaceFolders`, `getDiagnostics` (returns `[]`).
  - `handleToolCall` dispatcher routing by `params.name`.
  - `TOOL_DEFINITIONS` array with JSON Schema (`draft-07`) for `tools/list`.
- [media/preview.js](media/preview.js) -- Updated to post `selectionUpdate` messages on every `selectionchange` (reusing the 100ms debounced callback). Sends empty text when selection collapses. Stores `window.__pdfTotalPages` during PDF load.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated to forward `selectionUpdate` messages to `setCurrentSelection` / `clearCurrentSelection`.

**Commit:** `1d53ce9`.

---

## Phase 6 -- Page navigation

**Goal:** The user can navigate between pages using keyboard shortcuts, a page indicator, and a go-to-page input.

**What gets built in this phase:**

- [media/preview.js](media/preview.js) -- Updated with page navigation controls.
  - `#page-indicator` at the top of the viewport showing "Page N of M".
  - `IntersectionObserver` on each `.pdf-page` to detect which page is most visible and update the indicator.
  - Clicking the indicator opens a go-to-page text input. Enter scrolls to that page. Escape or blur reverts to the indicator.
  - Keyboard shortcuts: PageDown scrolls to the next page, PageUp to the previous page, Home to page 1, End to the last page.
  - `scrollToPage` message handler that scrolls a target page into view (used by the `openFile` tool in Phase 7).
- [media/preview.css](media/preview.css) -- Updated with styles for the page indicator and go-to-page input.

### 6.1 Add page indicator

Update [media/preview.js](media/preview.js):

1. Create a fixed-position `<div id="page-indicator">` showing "Page N of M". Position it at top-center, to the left of the existing zoom bar.
2. After all pages render in `renderAllPages`, set up an `IntersectionObserver` with `threshold: 0.5` on each `.pdf-page`. When a page crosses the threshold, update the indicator text.
3. Store the current page number in a module-level variable (e.g. `currentPageNum`) so other features can read it.

**Result:** Page indicator updates as the user scrolls.

**Verify:** Open a PDF, scroll through pages, confirm the indicator updates.

### 6.2 Add go-to-page input

Update [media/preview.js](media/preview.js):

When the user clicks the page indicator:
1. Replace the indicator text with an `<input type="number">` field, min 1, max totalPages.
2. On Enter, scroll the target page into view using `scrollIntoView({ behavior: 'smooth', block: 'start' })`.
3. On Escape or blur, revert to the indicator text.

**Result:** Clicking the indicator lets the user jump to a page.

**Verify:** Click the indicator, type "5", press Enter. Confirm page 5 scrolls into view.

### 6.3 Add keyboard navigation

Update [media/preview.js](media/preview.js):

Listen for `keydown` events (only when the go-to-page input is NOT focused):
- `PageDown` -- scroll to the next page.
- `PageUp` -- scroll to the previous page.
- `Home` -- scroll to page 1.
- `End` -- scroll to the last page.

Use the `currentPageNum` variable from 6.1 to determine the current page. Scroll with `scrollIntoView({ behavior: 'smooth', block: 'start' })`.

**Result:** Keyboard page navigation works.

**Verify:** Open a PDF, press PageDown several times, confirm pages advance. Press Home, confirm it returns to page 1.

### 6.4 Add scrollToPage message handler

Update [media/preview.js](media/preview.js):

In the `window.addEventListener('message', ...)` handler, add a case for `scrollToPage`:

```js
if (msg.type === 'scrollToPage') {
  const page = Number(msg.page);
  const target = document.querySelector(`.pdf-page[data-page="${page}"]`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return;
}
```

This will be triggered by the `openFile` MCP tool added in Phase 7.

**Result:** The extension host can request page navigation from the webview.

**Verify:** Test manually by posting a message from the extension host (or defer verification to Phase 7 when `openFile` is wired up).

### 6.5 Add page indicator and input styles to preview.css

Update [media/preview.css](media/preview.css):

- `#page-indicator` -- fixed position top-center, `z-index: 101`, widget background, rounded, small padding, semi-transparent, hover brightens. Positioned to the left of the zoom bar.
- `#page-indicator input` -- small number input styled to match the indicator, no spin buttons.
- `#page-indicator.editing` -- slightly wider to accommodate the input field.

**Result:** Indicator and input are styled consistently with the existing zoom bar.

**Verify:** Visual inspection.

### Test method

**What to test:** Page indicator shows the correct current page. Go-to-page works. Keyboard shortcuts navigate correctly. `scrollToPage` message scrolls correctly.

**How to test:** Open a 10+ page PDF. Scroll to page 5 -- confirm indicator says "Page 5 of N". Click indicator, type "8", press Enter -- confirm page 8 is in view and indicator says "Page 8 of N". Press PageDown -- confirm page 9. Press Home -- confirm page 1.

**Expected result:** All navigation methods work and the indicator stays in sync.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 7 -- Polish (keepalive, openFile tool)

**Goal:** The extension survives laptop sleep without dropping the Claude Code connection, and lets Claude Code drive page navigation via a new `openFile` tool.

**What gets built in this phase:**

- [src/claudeServer.ts](src/claudeServer.ts) -- Updated with:
  - Ping/pong keepalive with wake-from-sleep detection so the WebSocket connection survives closing the laptop lid.
  - A sixth MCP tool, `openFile`, that lets Claude Code tell the extension to scroll to a specific page.
  - An `onOpenFile` callback that `pdfProvider.ts` registers so the tool can forward the page navigation request into the active webview.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated to register the `onOpenFile` callback, forwarding `scrollToPage` messages to the webview.

### 7.1 Add ping/pong keepalive with wake-from-sleep detection

Update [src/claudeServer.ts](src/claudeServer.ts):

Track `lastPong` on each connected client. On `ws.on('pong')`, update `lastPong` to `Date.now()`. Start a 30-second interval timer that pings each client and disconnects any whose `lastPong` is older than 60 seconds.

**Wake-from-sleep detection:** record `lastTick` at the top of each interval. If the elapsed time since the previous tick is greater than `INTERVAL * 1.5` (45 seconds), assume the system was suspended and forgive everyone's `lastPong` (set it to `Date.now()`) before doing the liveness check. Without this, closing a laptop lid for 5 minutes would kill every Claude Code connection even though nothing is actually wrong.

```ts
const INTERVAL_MS = 30_000;
let lastTick = Date.now();
const pingTimer = setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTick;
  const wake = elapsed > INTERVAL_MS * 1.5;
  lastTick = now;
  for (const client of clients) {
    if (wake) {
      (client as any).lastPong = now;  // forgive everyone
    } else if (now - ((client as any).lastPong ?? now) > INTERVAL_MS * 2) {
      client.terminate();
      continue;
    }
    client.ping();
  }
}, INTERVAL_MS);
```

Clear the timer in `stopServer`.

**Result:** Connection survives laptop sleep without a false disconnect.

**Verify:** Connect Claude Code, close and reopen your laptop, confirm the connection is still live (ask Claude a question that requires `getCurrentSelection`).

### 7.2 Implement openFile tool (Claude drives page navigation)

Update [src/claudeServer.ts](src/claudeServer.ts):

Add a new tool `openFile` to `TOOL_DEFINITIONS`:

```ts
{
  name: 'openFile',
  description: 'Open a PDF and optionally scroll to a specific page',
  inputSchema: {
    type: 'object',
    properties: {
      filePath:      { type: 'string' },
      startLine:     { type: 'integer', description: 'Page number (1-based) to scroll to' },
      endLine:       { type: 'integer' },
      makeFrontmost: { type: 'boolean', default: true },
    },
    required: ['filePath'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
}
```

For PDFs, `startLine` is the **1-indexed page number**. The handler calls a registered `onOpenFile` callback (which `pdfProvider.ts` sets during `resolveCustomEditor`) to forward the request into the active webview.

Add an exported `setOnOpenFile(cb)` in `claudeServer.ts`:

```ts
let onOpenFile: ((filePath: string, startPage: number, endPage: number) => void) | null = null;
export function setOnOpenFile(cb: typeof onOpenFile): void { onOpenFile = cb; }
```

Add `'openFile'` case to `handleToolCall`:

```ts
case 'openFile': {
  const p = params as { filePath?: string; startLine?: number; endLine?: number };
  if (onOpenFile && p.filePath) {
    onOpenFile(p.filePath, p.startLine ?? 1, p.endLine ?? p.startLine ?? 1);
  }
  return { value: mcpText({ success: true }) };
}
```

**Result:** Claude Code can call `openFile` and the callback fires.

### 7.3 Wire openFile into pdfProvider.ts

Update [src/pdfProvider.ts](src/pdfProvider.ts):

Import `setOnOpenFile` from `./claudeServer`. In `resolveCustomEditor`, register the callback:

```ts
setOnOpenFile((filePath, startPage) => {
  if (filePath !== document.uri.fsPath) { return; }
  webviewPanel.webview.postMessage({ type: 'scrollToPage', page: startPage });
});
```

The `scrollToPage` message handler in `preview.js` was already added in Phase 6.4.

**Result:** Claude Code can call `openFile` and the user sees the PDF scroll to the requested page.

**Verify:** From the Claude Code terminal, ask: "use the openFile tool to jump to page 5". Confirm the PDF scrolls to page 5.

### 7.4 Final lint and type check

```bash
npm run check-types
npm run lint
```

Fix any issues.

**Result:** Clean compile and lint.

**Verify:** Both commands exit with code 0.

### Test method

**What to test:** Keepalive survives sleep. `openFile` drives navigation. Clean compile.

**How to test:**
1. Connect Claude Code, close the laptop lid for 2+ minutes, reopen, confirm the connection is still alive.
2. Ask Claude to use `openFile` to jump to a page, confirm the webview scrolls.
3. Run `npm run check-types && npm run lint`.

**Expected result:** Connection survives sleep. `openFile` works. Clean compile.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 8 -- Ship

**Goal:** The extension is packaged as a `.vsix` file with a complete README and installable in VS Code.

**Status:** Partially done. Extension icon exists. VSIX files have been built through v0.0.4. README is still a stub.

**What gets built in this phase:**

- [README.md](README.md) -- Full feature description, usage instructions, and requirements.
- Version bump in [package.json](package.json) to reflect the release.
- Final `.vsix` package.

### 8.1 Update README.md

Write [README.md](README.md) with:
- One-line description.
- Features list (PDF rendering, text selection, floating action bar, zoom controls, Claude Code integration with live selection broadcasting, page navigation, Claude-driven page jumps via `openFile`).
- Claude Code integration instructions (run `claude`, use `/ide`, select Ask PDF).
- Requirements (VS Code 1.85+, Claude Code CLI).
- Extension settings reference (`ask-pdf.showFloatingButton`).
- Keyboard shortcuts reference (zoom: Ctrl/Cmd+=/−/0, Ctrl/Cmd+wheel; navigation: PageDown/Up, Home/End).

**Result:** README is complete.

**Verify:**
```bash
head -20 README.md
```

### 8.2 Package the extension

Bump the version in [package.json](package.json) as appropriate, then package:

```bash
npx @vscode/vsce package
```

**Result:** New `.vsix` file is created in `releases/` (or repo root).

**Verify:**
```bash
ls *.vsix
```

### 8.3 Install and smoke test

```bash
code --install-extension ask-pdf-*.vsix
```

1. Open VS Code (not in dev mode).
2. Open a PDF file.
3. Confirm it renders.
4. Select text, confirm action bar appears.
5. Test zoom controls (Ctrl+wheel, zoom bar buttons).
6. Test page navigation (page indicator, go-to-page, keyboard).
7. Run `claude`, connect via `/ide`, select text, ask a question without clicking the button -- confirm Claude knows the selection.
8. Click "Claude" -- confirm the reference appears in the terminal.
9. Ask Claude to use `openFile` to jump to a specific page.

**Result:** Extension works when installed from the `.vsix`.

**Verify:** All checks above pass.

### Test method

**What to test:** The packaged extension installs and works end-to-end, including proactive selection broadcasting.

**How to test:** Install the `.vsix` in a clean VS Code window. Open a PDF. Select text. Ask Claude about it without clicking. Click Claude. Test zoom. Test page navigation. Test openFile.

**Expected result:** PDF renders, action bar works, zoom works, page navigation works, Claude Code connects, live selection broadcasting works (Claude answers without needing a button click), `at_mentioned` on click also works, keepalive survives sleep.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- The final version number and VSIX file name.
- How to install: `code --install-extension <file>.vsix`.
