# ask-pdf Development Plan

## What this project is

ask-pdf is a VS Code extension that opens PDF files in a rendered webview using pdf.js. Users can select text in the rendered PDF, and a floating action bar appears with a button to send the selected text and page reference to Claude Code. The extension runs a local MCP WebSocket server that Claude Code CLI connects to, and it **proactively broadcasts the current selection** to Claude Code whenever it changes — so when the user Tab-switches to their `claude` terminal and asks "explain this", Claude already knows exactly which passage they're looking at. It's the PDF counterpart to ask-markdown, following the same architecture and UX patterns.

## Repository layout

Current layout:

```text
ask-pdf/
  .gitignore
  LICENSE
  README.md
  ask-pdf-development-plan.md
  claudecode-nvim-analysis.md
```

Post-scaffold layout:

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
    preview.css             -- webview styles (theme-aware)
    preview.js              -- webview script (PDF rendering, selection, action bar, navigation)
    icon.png                -- extension icon
  dist/                     -- esbuild output (gitignored)
```

All commands run from the repo root `/Users/ip33/Documents/GitHub/ask-pdf`.

---

## Phase 1 -- Project setup

**Goal:** The project runs inside a pinned Node environment, compiles, lints, and produces a bundled extension that activates on PDF files.

**What gets built in this phase:**

- [.nvmrc](.nvmrc) -- Pins the Node.js version so every developer and CI run uses the same toolchain.
- [package.json](package.json) -- Defines the extension metadata, activation events, dependencies, and build scripts.
  - Registers a custom readonly editor for `*.pdf` files so VS Code opens PDFs in our webview.
  - Declares `pdfjs-dist` and `ws` as runtime dependencies.
  - Declares `ask-pdf.openPreview` command for the editor title bar.
- [tsconfig.json](tsconfig.json) -- TypeScript compiler configuration matching ask-markdown.
- [eslint.config.mjs](eslint.config.mjs) -- Linting rules matching ask-markdown.
- [esbuild.js](esbuild.js) -- Bundles the extension TypeScript into a single JS file for VS Code to load.
- [src/extension.ts](src/extension.ts) -- Empty activate/deactivate stubs so the extension loads without error.
- [.gitignore](.gitignore) -- Replaces the default Node gitignore with one tailored for a VS Code extension.
- [.vscodeignore](.vscodeignore) -- Controls what goes into the packaged extension, keeping the VSIX small.

### 1.1 Pin Node version and activate the managed environment

Create [.nvmrc](.nvmrc) with a single line specifying the Node version (use the current Node 20 LTS, e.g. `20.11.1`). Every subsequent command in this plan assumes the shell has this version active — run `nvm use` before anything else. The committed `package-lock.json` from [1.6](#16-install-dependencies-and-verify-build) and the `.nvmrc` together lock the toolchain so the build is reproducible.

```bash
echo "20.11.1" > .nvmrc
nvm install
nvm use
```

If `nvm` is not installed, install it first via [nvm.sh](https://github.com/nvm-sh/nvm) — do not fall back to a system Node. Never install `pdfjs-dist`, `ws`, `esbuild`, or any other dependency globally; every package must go into the project's `node_modules/`.

**Result:** `.nvmrc` exists. The active shell is using the pinned Node version.

**Verify:**
```bash
cat .nvmrc
node -v
which node
```

`node -v` must match `.nvmrc`. `which node` must point inside the `nvm` directory, not `/usr/bin` or `/opt/homebrew/bin`.

### 1.2 Create package.json

Create [package.json](package.json) with the extension metadata.

Key fields:

| Field                         | Value                                             |
| ----------------------------- | ------------------------------------------------- |
| `name`                        | `ask-pdf`                                         |
| `displayName`                 | `ask-pdf`                                         |
| `version`                     | `0.1.0`                                           |
| `publisher`                   | `vibe-dog`                                        |
| `license`                     | `MIT`                                             |
| `engines.vscode`              | `^1.85.0`                                         |
| `main`                        | `./dist/extension.js`                             |
| `activationEvents`            | `["onCustomEditor:askPdf.preview"]`               |
| `contributes.customEditors`   | viewType `askPdf.preview`, selector `*.pdf`, priority `default` |
| `contributes.commands`        | `ask-pdf.openPreview` with icon `$(open-preview)` |

Dependencies: `pdfjs-dist`, `ws`.

DevDependencies: `@types/vscode`, `@types/node`, `@types/ws`, `esbuild`, `typescript`, `typescript-eslint`, `eslint`, `@vscode/vsce`, `npm-run-all`.

Scripts (same pattern as ask-markdown):

| Script             | Command                                                   |
| ------------------ | --------------------------------------------------------- |
| `vscode:prepublish`| `npm run package`                                         |
| `compile`          | `npm run check-types && npm run lint && node esbuild.js`  |
| `watch`            | `npm-run-all -p watch:*`                                  |
| `watch:esbuild`    | `node esbuild.js --watch`                                 |
| `watch:tsc`        | `tsc --noEmit --watch --project tsconfig.json`            |
| `package`          | `npm run check-types && npm run lint && node esbuild.js --production` |
| `check-types`      | `tsc --noEmit`                                            |
| `lint`             | `eslint src`                                              |

Configuration settings:

| Setting                        | Type    | Default | Description                                                         |
| ------------------------------ | ------- | ------- | ------------------------------------------------------------------- |
| `ask-pdf.showFloatingButton`   | boolean | `true`  | Show the floating action bar (Claude) when text is selected.        |

Menu contribution: show the `ask-pdf.openPreview` command in the editor title bar when a `.pdf` file is active and not already in our custom editor.

**Result:** `package.json` exists with all metadata, dependencies, and contribution points.

**Verify:**
```bash
cat package.json | head -5
```

### 1.3 Create tsconfig.json, eslint.config.mjs, esbuild.js

Create [tsconfig.json](tsconfig.json) matching ask-markdown:
- `module`: `Node16`, `target`: `ES2022`, `lib`: `["ES2022"]`, `sourceMap`: `true`, `rootDir`: `src`, `strict`: `true`.

Create [eslint.config.mjs](eslint.config.mjs) matching ask-markdown:
- Uses `typescript-eslint` parser and plugin.
- Rules: `@typescript-eslint/naming-convention` (warn, import format), `curly`, `eqeqeq`, `no-throw-literal`, `semi`.

Create [esbuild.js](esbuild.js) matching ask-markdown:
- Entry point: `src/extension.ts`.
- Output: `dist/extension.js`.
- Format: `cjs`, platform: `node`, external: `['vscode']`.
- Supports `--production` (minify, no sourcemap) and `--watch` flags.
- Includes the `esbuild-problem-matcher` plugin.

**Result:** Three config files created.

**Verify:**
```bash
ls tsconfig.json eslint.config.mjs esbuild.js
```

### 1.4 Replace .gitignore and create .vscodeignore

Replace [.gitignore](.gitignore) with the ask-markdown version (VS Code extension–focused):
- Ignores `node_modules/`, `dist/`, `out/`, `*.vsix`, `.vscode-test/`, `*.tsbuildinfo`, `coverage/`, `.eslintcache`, `.DS_Store`.

Create [.vscodeignore](.vscodeignore):
- Excludes `src/`, `.gitignore`, `.vscode-test/**`, `esbuild.js`, `tsconfig.json`, `eslint.config.mjs`, `**/*.map`, `**/*.ts`, `out/**`.
- Excludes `node_modules/**` except `node_modules/pdfjs-dist/build/**` and `node_modules/pdfjs-dist/legacy/**` (pdf.js worker and library files needed at runtime in the webview).

**Result:** Both files created.

**Verify:**
```bash
ls .gitignore .vscodeignore
```

### 1.5 Create stub extension.ts

```bash
mkdir -p src
```

Create [src/extension.ts](src/extension.ts) with:
- `activate(context)` -- logs `[ask-pdf] activated` to the console.
- `deactivate()` -- empty.

**Result:** `src/extension.ts` exists with working stubs.

**Verify:**
```bash
cat src/extension.ts
```

### 1.6 Install dependencies and verify build

Run everything through the `nvm`-activated Node from [1.1](#11-pin-node-version-and-activate-the-managed-environment). `npm install` generates `package-lock.json` — commit it so the exact dependency tree is reproducible.

```bash
nvm use
npm install
npm run compile
```

**Result:** `node_modules/` populated, `package-lock.json` created, `dist/extension.js` produced. No TypeScript or lint errors.

**Verify:**
```bash
node -v
ls package-lock.json dist/extension.js && echo "Build OK"
npm run check-types
npm run lint
```

`node -v` must still match `.nvmrc` — if it drifted, re-run `nvm use` before continuing.

### Test method

**What to test:** The project compiles and produces a valid extension bundle.

**How to test:**
```bash
npm run compile
```

**Expected result:** Exit code 0. `dist/extension.js` exists. No errors from `check-types` or `lint`.

---

## Phase 2 -- PDF rendering in webview

**Goal:** Opening a PDF file in VS Code shows all pages rendered in a webview with selectable text.

**What gets built in this phase:**

- [src/pdfProvider.ts](src/pdfProvider.ts) -- Opens PDF files in a webview and sends the binary data to the webview for rendering.
  - `AskPdfEditorProvider` -- Implements `CustomReadonlyEditorProvider`. Reads the PDF binary, builds the webview HTML, and posts the PDF data as a base64 message.
  - `register` -- Registers the provider with VS Code so it handles `*.pdf` files.
  - `buildHtml` -- Generates the HTML shell that loads pdf.js worker, library, the preview script, and the preview stylesheet.
- [src/extension.ts](src/extension.ts) -- Updated to register the PDF editor provider on activation.
- [media/preview.js](media/preview.js) -- Runs inside the webview. Receives the PDF binary from the extension host, renders each page to a canvas using pdf.js, and overlays an invisible text layer so users can select text.
  - Listens for a `pdfData` message containing base64-encoded PDF bytes.
  - Uses `pdfjsLib.getDocument` to load the PDF.
  - For each page: creates a `.pdf-page` container, renders to a `<canvas>`, then calls `pdfjsLib.renderTextLayer` to overlay selectable text.
  - Tags each `.pdf-page` div with `data-page="N"` (1-based) for page mapping.
- [media/preview.css](media/preview.css) -- Styles the page canvases, text layer overlays, page number labels, and loading/error states. Uses VS Code CSS variables for theme awareness.

### 2.1 Create media/preview.css

Create [media/preview.css](media/preview.css) with styles for:
- Dark/light theme support via `--vscode-*` CSS variables (same approach as ask-markdown).
- `html, body` -- zero margin, editor background/foreground.
- `#pdf-container` -- centered column layout with padding.
- `.pdf-page` -- container for each page canvas, centered, with margin between pages.
- `.pdf-page canvas` -- block display.
- `.textLayer` -- positioned absolutely over each canvas so text is selectable but invisible. Uses `mix-blend-mode: multiply` for selection highlight.
- `.textLayer span` -- transparent text that becomes visible only on selection.
- `.page-label` -- small page number label between pages.
- `.loading` and `.error` -- states for when the PDF is loading or fails to load.
- `::selection` -- uses `--vscode-editor-selectionBackground`.

```bash
mkdir -p media
```

**Result:** CSS file created.

**Verify:**
```bash
cat media/preview.css
```

### 2.2 Create media/preview.js

Create [media/preview.js](media/preview.js). This script runs inside the webview:

1. Calls `acquireVsCodeApi()` to get the VS Code messaging API.
2. Listens for a `pdfData` message from the extension host containing the PDF as a base64 string.
3. Decodes the base64 to a `Uint8Array`, calls `pdfjsLib.getDocument({ data })`.
4. For each page (1 to `numPages`):
   - Creates a `<div class="pdf-page" data-page="N">`.
   - Gets the page via `pdf.getPage(i)`.
   - Determines the viewport at a scale that fits the container width (default scale 1.5).
   - Creates a `<canvas>`, sets its dimensions, renders the page via `page.render({ canvasContext, viewport })`.
   - Creates a `<div class="textLayer">` overlay, gets the text content via `page.getTextContent()`, and renders it via `pdfjsLib.renderTextLayer({ textContentSource, container, viewport })`.
   - Appends a `<div class="page-label">Page N</div>`.
5. Shows a loading message while rendering, replaced by the pages when done.
6. On error, shows the error message in the webview.

**Result:** Webview script created.

**Verify:**
```bash
cat media/preview.js
```

### 2.3 Create src/pdfProvider.ts

Create [src/pdfProvider.ts](src/pdfProvider.ts) implementing `vscode.CustomReadonlyEditorProvider`.

- Define a minimal `PdfDocument` class implementing `vscode.CustomDocument` that holds the PDF `Uint8Array` data and the file URI.
- `openCustomDocument(uri)` -- reads the PDF file as a `Uint8Array` using `vscode.workspace.fs.readFile` and returns a `PdfDocument`.
- `resolveCustomEditor(document, webviewPanel)` -- sets up the webview:
  - Enables scripts.
  - Sets `localResourceRoots` to include `media/` and the `pdfjs-dist` build directory (for the worker and library files).
  - Calls `buildHtml` to generate the HTML.
  - Posts the PDF data to the webview as `{ type: 'pdfData', data: base64String }`.
- `buildHtml(webview, extensionUri)` -- generates the HTML page:
  - Uses `webview.asWebviewUri` to convert paths for `pdf.min.mjs` and `pdf.worker.min.mjs` from `pdfjs-dist/build/`.
  - Sets the worker path via a `<script>` block: `pdfjsLib.GlobalWorkerOptions.workerSrc = workerUri`.
  - Loads `preview.css` and `preview.js` from `media/`.
  - Content Security Policy allows scripts with a nonce, images from the webview source and data URIs, styles from the webview source and inline, fonts from the webview source, and worker-src from the webview source and blob.

**Result:** Provider file created.

**Verify:**
```bash
npm run check-types
```

### 2.4 Wire up extension.ts

Update [src/extension.ts](src/extension.ts):
- Import `AskPdfEditorProvider` from `./pdfProvider`.
- In `activate`, register the provider via `AskPdfEditorProvider.register(context)` and push to `context.subscriptions`.
- Register the `ask-pdf.openPreview` command that opens the current file with the `askPdf.preview` editor.

**Result:** Extension registers the custom editor and command.

**Verify:**
```bash
npm run compile
```

### 2.5 Manual smoke test

1. Open VS Code with the extension in development mode (`F5` or `Run > Start Debugging`).
2. Open any PDF file.
3. Confirm pages render in the webview.
4. Confirm text is selectable (drag to highlight).

**Result:** PDF renders with selectable text.

**Verify:**
1. Pages are visible as rendered content (not raw binary).
2. Dragging over text highlights it.
3. No errors in the webview developer tools (Help > Toggle Developer Tools).

### Test method

**What to test:** PDF files open in the custom editor and render all pages with selectable text.

**How to test:** Launch the extension in development mode. Open a multi-page PDF. Select text on different pages.

**Expected result:** All pages render. Text selection works. No console errors.

---

## Phase 3 -- Floating action bar with page mapping

**Goal:** When text is selected in the PDF preview, a floating bar appears with a "Claude" button. The extension knows which page(s) the selection spans and logs the selection details locally.

**What gets built in this phase:**

- [src/pageMapper.ts](src/pageMapper.ts) -- Formats a page reference string from a file path and page range.
  - `formatPageRef(filePath, startPage, endPage)` -- Returns `@file.pdf:page3` for a single page or `@file.pdf:page3-5` for a range. Uses the workspace-relative path.
- [media/preview.js](media/preview.js) -- Updated to detect which pages a text selection spans and to show a floating action bar.
  - `selectionPageRange()` -- Gets `window.getSelection()`, walks up to the nearest `.pdf-page` ancestor for anchor and focus nodes, reads `data-page` attributes, and returns `{ text, startPage, endPage }`.
  - Creates a `<div id="ask-bar">` with a single "Claude" button.
  - On `selectionchange` (debounced) and `mouseup`, computes the page range. If there is a selection, positions the bar above the selection bounding rect. Otherwise hides it.
  - Clicking "Claude" posts `{ type: 'askClaude', text, startPage, endPage }` to the extension host.
- [media/preview.css](media/preview.css) -- Updated with styles for the floating action bar matching ask-markdown's design (widget background, rounded border, shadow, hover states).
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated to handle the `askClaude` message from the webview. For now, logs the selected text and page range to the console. Full Claude Code integration comes in Phase 4.

### 3.1 Create src/pageMapper.ts

Create [src/pageMapper.ts](src/pageMapper.ts):

- `formatPageRef(filePath, startPage, endPage)`:
  - Computes the workspace-relative path using `vscode.workspace.asRelativePath`.
  - If `startPage === endPage`, returns `@file.pdf:page3`.
  - If different, returns `@file.pdf:page3-5` (ensuring start <= end).

**Result:** File created.

**Verify:**
```bash
npm run check-types
```

### 3.2 Add selection page range detection to preview.js

Update [media/preview.js](media/preview.js):

Add a helper `findPageElement(node)` that walks up the DOM to the nearest `.pdf-page` ancestor.

Add `selectionPageRange()`:
1. Gets `window.getSelection()`. Returns `null` if collapsed or empty.
2. Finds the `.pdf-page` ancestor of the anchor node and the focus node.
3. Reads `data-page` from each, returns `{ text, startPage: min, endPage: max }`.

**Result:** Page range is computable from any text selection.

**Verify:** Temporary `console.log` in `selectionPageRange`, select text across pages, check webview dev tools console.

### 3.3 Add floating action bar to preview.js

Update [media/preview.js](media/preview.js):

1. Create `<div id="ask-bar">` with one button: `Claude`.
2. On `selectionchange` (debounced 100 ms) and `mouseup`, call `selectionPageRange()`. If result exists, position the bar above the selection bounding rect and show it. Otherwise hide it.
3. When "Claude" is clicked, post `{ type: 'askClaude', text, startPage, endPage }` to the extension host, then hide the bar.
4. Respect a `data-enabled` attribute on the bar so the `showFloatingButton` setting can disable it.

Use 100 ms debounce (not 200 ms) because Phase 5 will reuse this same debounced callback to broadcast `selection_changed` notifications to Claude Code, and 100 ms is the same value used by claudecode.nvim.

**Result:** Bar appears on selection, disappears on deselection.

**Verify:** Launch extension, open PDF, select text, confirm bar appears above selection.

### 3.4 Add action bar styles to preview.css

Update [media/preview.css](media/preview.css) with styles for `#ask-bar` matching ask-markdown:
- `display: none`, `position: absolute`, `z-index: 100`.
- Background: `--vscode-editorWidget-background`.
- Border: `--vscode-editorWidget-border`.
- `border-radius: 5px`, `padding: 2px`, `box-shadow`, `white-space: nowrap`.
- Button styles: transparent background, editor foreground color, hover background.

**Result:** Bar is styled consistently with ask-markdown.

**Verify:** Visual inspection -- bar looks like a native VS Code widget.

### 3.5 Handle askClaude message in pdfProvider.ts

Update [src/pdfProvider.ts](src/pdfProvider.ts):

In `resolveCustomEditor`, add a `webview.onDidReceiveMessage` listener:
- On `{ type: 'askClaude', text, startPage, endPage }`: log the selection details to the console using `console.log('[ask-pdf]', ...)`. The server broadcast comes in Phase 4.

Also pass the `showFloatingButton` setting to the webview on load:
- Read `vscode.workspace.getConfiguration('ask-pdf').get<boolean>('showFloatingButton', true)`.
- Post `{ type: 'updateShowFloatingButton', enabled }` after the HTML loads.
- Listen for configuration changes and re-post when the setting changes.

**Result:** Clicking "Claude" logs the selection. The bar respects the setting.

**Verify:** Select text, click Claude, check the debug console. Toggle the setting off, confirm bar is hidden.

### Test method

**What to test:** Page range detection works for single-page and cross-page selections. The action bar appears on selection, disappears on deselection, and the Claude button logs the correct info. The `showFloatingButton` setting hides the bar when disabled.

**How to test:** Launch the extension. Open a multi-page PDF. Select text within page 2 -- confirm bar appears. Click "Claude" -- confirm the extension logs `{ text: "...", startPage: 2, endPage: 2 }`. Select text spanning pages 2-4 -- confirm range is `{ startPage: 2, endPage: 4 }`. Clear selection -- confirm bar disappears. Set `ask-pdf.showFloatingButton` to `false` -- confirm bar does not appear.

**Expected result:** Page numbers are correct. Bar appears/disappears correctly. Setting controls visibility. Debug log includes correct text and page numbers.

---

## Phase 4 -- MCP server foundation

**Goal:** A Claude Code CLI that runs `/ide` in a terminal can find and connect to ask-pdf, complete the MCP handshake without errors, and receive an `at_mentioned` notification when the user clicks the "Claude" button in the floating action bar. Tool handlers are still stubs at the end of this phase — Claude connects but can't query state yet.

This phase is about **plumbing**: lock file, WebSocket server, auth, JSON-RPC router, and the minimum set of handlers Claude Code requires on cold start. It's intentionally the least exciting phase but it's the foundation everything else in Phase 5–7 builds on.

**What gets built in this phase:**

- [src/claudeServer.ts](src/claudeServer.ts) -- New file. The MCP WebSocket server that Claude Code connects to.
  - `startServer` -- Picks a random free port on `127.0.0.1`, opens an HTTP server, attaches a `ws` WebSocket server, and writes a lock file telling Claude Code where to find us.
  - `stopServer` -- Closes all connections, removes the lock file, stops the HTTP server.
  - `broadcast` -- Sends a JSON-RPC notification to every connected Claude Code client. Used by the rest of the extension to push updates to Claude.
  - `isConnected` -- Returns whether any Claude Code client is currently connected. Used to decide whether to show a "no Claude connected" warning.
  - `writeLockFile` / `removeLockFile` -- Writes `~/.claude/ide/{port}.lock` with the expected JSON shape, respecting `$CLAUDE_CONFIG_DIR` if set.
  - `handleMessage` -- The top-level JSON-RPC dispatcher. Parses incoming frames, routes by `method`, responds only when the message has an `id`.
  - `handleInitialize` -- Returns the MCP handshake response with protocol version and capabilities.
  - `handlePromptsList` -- Returns `{ prompts: [] }`. Required even though empty.
  - `handleToolsList` -- Returns an empty tools array in this phase. Filled in in Phase 5.
  - `handleToolCall` -- Returns a "tool not found" error in this phase. Filled in in Phase 5.
- [src/extension.ts](src/extension.ts) -- Updated to start the Claude Code server on `activate` and stop it on `deactivate`.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated `askClaude` message handler. Instead of just logging, it broadcasts an `at_mentioned` notification to Claude Code (if connected) and focuses the terminal. If no Claude Code client is connected, shows a warning message.

### 4.1 Create src/claudeServer.ts (server skeleton + lock file)

Create [src/claudeServer.ts](src/claudeServer.ts) with the server skeleton. Implementation notes (all of these are load-bearing — cross-check with [claudecode-nvim-analysis.md](claudecode-nvim-analysis.md) if anything is unclear):

**Lock file directory resolution:**

```ts
function lockDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && configDir.length > 0) {
    return path.join(configDir, 'ide');
  }
  return path.join(os.homedir(), '.claude', 'ide');
}
```

**Lock file contents:**

```ts
interface LockFile {
  pid: number;
  workspaceFolders: string[];   // from vscode.workspace.workspaceFolders
  ideName: 'Ask PDF';
  transport: 'ws';
  authToken: string;             // UUID v4 from crypto.randomUUID()
}
```

Write it to `{lockDir}/{port}.lock`. Create the directory with `fs.mkdirSync(dir, { recursive: true })` before writing.

**Server bind:** Use `http.createServer()`, then `server.listen(0, '127.0.0.1', ...)`. Port `0` tells Node to pick any available ephemeral port. Read the actual port via `server.address().port`. **Never bind to `0.0.0.0`** — the auth token alone is not sufficient to protect against network exposure; binding to loopback is the real guarantee.

**WebSocket upgrade with auth:**

```ts
const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  const token = req.headers['x-claude-code-ide-authorization'];
  const valid =
    typeof token === 'string' &&
    token.length >= 10 && token.length <= 500 &&
    Buffer.byteLength(token) === Buffer.byteLength(authToken) &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(authToken));
  if (!valid) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
```

The auth header is named `x-claude-code-ide-authorization` (custom, not standard `Authorization`). Use `crypto.timingSafeEqual` rather than `===` to avoid timing leaks — cheap and right.

**Module-level state:**

```ts
let authToken: string | null = null;
let serverPort: number | null = null;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
```

Start with `startServer` and `stopServer`. Leave message handling as a stub that logs received frames.

**Result:** Server file exists. The extension can start the server, write a lock file, accept WebSocket connections, and reject unauthorized ones.

**Verify:**
```bash
npm run check-types
```

### 4.2 Add JSON-RPC router with initialize, prompts/list, tools/list stub

Update [src/claudeServer.ts](src/claudeServer.ts) with the JSON-RPC dispatcher.

**Dispatcher shape:**

```ts
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

function handleMessage(ws: WebSocket, raw: string): void {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(raw);
  } catch {
    return;  // parse error: don't respond
  }
  if (typeof req !== 'object' || req.jsonrpc !== '2.0') {
    return;  // invalid request: don't respond
  }
  const isRequest = req.id !== undefined;
  const result = dispatch(req);
  if (!isRequest) { return; }  // notifications never get responses
  if ('error' in result) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: result.error }));
  } else {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: result.value }));
  }
}
```

**Methods to handle in this phase:**

| Method                      | Response                                                                |
|-----------------------------|-------------------------------------------------------------------------|
| `initialize`                | Full capabilities object (see below).                                   |
| `notifications/initialized` | No-op. Return nothing (it's a notification).                            |
| `prompts/list`              | `{ prompts: [] }`. **Required** — Claude Code calls this on cold start. |
| `tools/list`                | `{ tools: [] }`. Real tools come in Phase 5.                            |
| `tools/call`                | Error `-32601` "Tool not found". Real dispatch comes in Phase 5.        |
| anything else               | Error `-32601` "Method not found".                                      |

**The initialize response is load-bearing:**

```ts
function handleInitialize(): unknown {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      logging: {},                                          // must be object, not array
      prompts:   { listChanged: true },
      resources: { subscribe: true, listChanged: true },    // subscribe is a lie, but required
      tools:     { listChanged: true },
    },
    serverInfo: {
      name: 'ask-pdf',
      version: '0.1.0',
    },
  };
}
```

Do not omit `prompts`, `resources`, or `logging`. Claude Code does capability negotiation against these fields and will log warnings if they're missing.

**Error codes to reserve** (used in Phase 5 too):

| Code     | Meaning              |
|----------|----------------------|
| `-32700` | Parse error          |
| `-32600` | Invalid request      |
| `-32601` | Method not found     |
| `-32602` | Invalid params       |
| `-32603` | Internal error       |
| `-32000` | Tool execution error |

**Result:** Server responds correctly to the full MCP handshake. Claude Code can complete `initialize` → `notifications/initialized` → `prompts/list` → `tools/list` → idle without errors.

**Verify:**
```bash
npm run check-types
```

### 4.3 Wire server into extension.ts

Update [src/extension.ts](src/extension.ts):
- Import `startServer` and `stopServer` from `./claudeServer`.
- In `activate`, call `startServer().then((port) => console.log('[ask-pdf] Claude server ready on port', port)).catch((err) => console.error('[ask-pdf] Failed to start Claude server:', err))`.
- In `deactivate`, call `stopServer()`.

**Result:** Server starts when the extension activates, stops when it deactivates.

**Verify:**
```bash
npm run compile
```

Then launch the extension in dev mode and check the debug console for the "Claude server ready on port N" log.

### 4.4 Broadcast at_mentioned on Claude button click

Update [src/pdfProvider.ts](src/pdfProvider.ts):

- Import `broadcast` and `isConnected` from `./claudeServer`.
- Replace the Phase 3 console-log-only handler for `{ type: 'askClaude', text, startPage, endPage }` with:
  - If `!isConnected()`, show a warning message: `'Ask PDF: No Claude CLI connected. Run "claude" in a terminal first.'` via `vscode.window.showWarningMessage`.
  - Otherwise, call `broadcast('at_mentioned', { filePath: document.uri.fsPath, lineStart: startPage, lineEnd: endPage })`.
  - Then `vscode.commands.executeCommand('workbench.action.terminal.focus')` to put the cursor in the user's `claude` terminal ready to type their question.

**Important:** For PDFs, `lineStart` and `lineEnd` in the `at_mentioned` payload are **1-indexed page numbers**. Claude Code renders this as `@file.pdf:{page}` in its input.

**Result:** Clicking "Claude" sends a page reference to Claude Code's terminal if connected, or warns the user if not.

**Verify:**
1. Launch the extension in dev mode.
2. Open a terminal, run `claude`.
3. In the Claude Code CLI, run `/ide` and select "Ask PDF".
4. Open a PDF, select text on page 2, click "Claude".
5. Confirm Claude Code shows the file reference in its input (e.g., `@paper.pdf:2`).
6. Without running `claude`, click "Claude" again -- confirm the warning message appears.

### Test method

**What to test:** Claude Code can discover the lock file, complete the MCP handshake, and receive `at_mentioned` notifications when the user clicks the button. Tool queries still fail gracefully.

**How to test:**
1. Launch the extension in dev mode.
2. Check that `~/.claude/ide/{port}.lock` is created with the correct JSON shape:
   ```bash
   ls ~/.claude/ide/
   cat ~/.claude/ide/*.lock
   ```
3. Run `claude` in a terminal, run `/ide`, confirm "Ask PDF" appears in the picker.
4. Select it. Confirm Claude Code says connected.
5. Open a PDF, select text, click "Claude". Confirm the reference appears in Claude Code.
6. Deactivate the extension. Confirm the lock file is removed.

**Expected result:** Lock file created/removed on lifecycle. Claude Code discovers and connects to the server. No errors on cold start. `at_mentioned` arrives in Claude Code's input. No crashes when Claude Code calls `prompts/list` or `tools/list` (tools/list returns empty).

---

## Phase 5 -- MCP tools and proactive selection broadcasting

**Goal:** Claude Code gets live selection context without polling. The user selects text in the PDF, immediately `selection_changed` fires over the WebSocket, and Claude Code can also call five MCP tools (`getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`) to query state on demand. This is the phase that makes Claude feel like it's actually watching over the user's shoulder.

**What gets built in this phase:**

- [src/claudeServer.ts](src/claudeServer.ts) -- Expanded with:
  - Module-level `currentSelection` and `latestSelection` state. `currentSelection` reflects whatever is selected right now (cleared when the user clicks away). `latestSelection` is only updated on **non-empty** selections and is never cleared — this is what `getLatestSelection` reads and what lets Claude answer "explain what I just highlighted" even after the user Tab-switches.
  - `setCurrentSelection` / `clearCurrentSelection` -- Called by `pdfProvider.ts` whenever the webview reports a new selection.
  - `broadcastSelectionChanged` -- Sends a `selection_changed` notification with the full selection payload to every connected Claude Code client.
  - Five real MCP tool handlers replacing the Phase 4 stub: `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`.
  - `handleToolsList` -- Returns the schemas for all five tools.
  - `handleToolCall` -- Dispatches by `params.name` to the right handler.
  - `mcpText(inner)` helper -- Wraps a JS object as `{ content: [{ type: 'text', text: JSON.stringify(inner) }] }`. The text field is **deliberately double-encoded JSON** — that's MCP convention, not a bug.
- [media/preview.js](media/preview.js) -- Updated to post a `selectionUpdate` message to the extension host on every `selectionchange` (reusing the Phase 3 debounced callback). Sends an empty-text update when the selection collapses.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated to forward `selectionUpdate` messages from the webview into the selection state in `claudeServer.ts` and trigger a `selection_changed` broadcast.

### 5.1 Define the selection data model in claudeServer.ts

Update [src/claudeServer.ts](src/claudeServer.ts):

Add a `PdfSelection` type and module-level state:

```ts
export interface PdfSelection {
  text: string;
  filePath: string;          // absolute filesystem path
  fileUrl: string;           // file:// URI
  startPage: number;         // 1-indexed
  endPage: number;           // 1-indexed
  totalPages: number;
}

let currentSelection: PdfSelection | null = null;
let latestSelection: PdfSelection | null = null;
```

Add the exported setters:

```ts
export function setCurrentSelection(sel: PdfSelection): void {
  currentSelection = sel;
  if (sel.text.length > 0) {
    latestSelection = sel;  // only non-empty selections update latest
  }
  broadcastSelectionChanged(sel);
}

export function clearCurrentSelection(): void {
  currentSelection = null;
  // do NOT clear latestSelection
}
```

**Result:** Selection state is tracked in the server module, ready for tool handlers to read.

**Verify:**
```bash
npm run check-types
```

### 5.2 Implement the PDF-to-LSP position encoding helper

Still in [src/claudeServer.ts](src/claudeServer.ts), add a helper that converts a `PdfSelection` into the LSP-flavored shape Claude Code expects.

PDFs don't have lines, so we fake LSP positions: `line` is the 0-indexed page number, `character` is always 0. We **also** include an extra `page` field (1-indexed) because Claude Code ignores unknown fields but we want the real page number to be available for prompts.

```ts
function selectionToPayload(sel: PdfSelection): unknown {
  return {
    success: true,
    text: sel.text,
    filePath: sel.filePath,
    fileUrl: sel.fileUrl,
    page: sel.startPage,                    // extra field, 1-indexed
    selection: {
      start: { line: sel.startPage - 1, character: 0 },
      end:   { line: sel.endPage   - 1, character: 0 },
      isEmpty: sel.text.length === 0,
    },
  };
}
```

For a selection spanning pages 3–5: `start.line = 2, end.line = 4, page = 3`.

**Result:** Helper ready for the tool handlers and the broadcast function.

### 5.3 Implement the five MCP tool handlers

Still in [src/claudeServer.ts](src/claudeServer.ts), replace the Phase 4 tool stubs:

**`mcpText` helper:**

```ts
function mcpText(inner: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(inner) }],
  };
}
```

Yes, double-encoded. That's the MCP convention.

**Tool schemas for `tools/list`:**

| Tool                    | inputSchema                                                                     |
|-------------------------|---------------------------------------------------------------------------------|
| `getCurrentSelection`   | `{ type: 'object', additionalProperties: false, $schema: ... }`                 |
| `getLatestSelection`    | `{ type: 'object', additionalProperties: false, $schema: ... }`                 |
| `getOpenEditors`        | `{ type: 'object', additionalProperties: false, $schema: ... }`                 |
| `getWorkspaceFolders`   | `{ type: 'object', additionalProperties: false, $schema: ... }`                 |
| `getDiagnostics`        | `{ type: 'object', properties: { uri: { type: 'string' } }, additionalProperties: false, $schema: ... }` |

All schemas include `"$schema": "http://json-schema.org/draft-07/schema#"`.

**`getCurrentSelection` handler:**

```ts
function handleGetCurrentSelection(): unknown {
  if (!currentSelection) {
    return mcpText({ success: false, message: 'No active PDF editor found' });
  }
  return mcpText(selectionToPayload(currentSelection));
}
```

**`getLatestSelection` handler:**

```ts
function handleGetLatestSelection(): unknown {
  if (!latestSelection) {
    return mcpText({ success: false, message: 'No selection available' });
  }
  return mcpText(selectionToPayload(latestSelection));
}
```

**`getOpenEditors` handler:** enumerate open PDF tabs via `vscode.window.tabGroups.all`, filter to tabs whose URI ends in `.pdf`, and format each as a tab entry. Fields:

| Field           | Value                                                    |
|-----------------|----------------------------------------------------------|
| `uri`           | `tab.input.uri.toString()`                               |
| `isActive`      | `tab.isActive`                                           |
| `isPinned`      | `false` (hard-coded)                                     |
| `isPreview`     | `tab.isPreview`                                          |
| `isDirty`       | `false` (PDFs are read-only)                             |
| `label`         | `tab.label`                                              |
| `groupIndex`    | group index in `tabGroups.all`                           |
| `viewColumn`    | `tab.group.viewColumn`                                   |
| `isGroupActive` | `tab.group.isActive`                                     |
| `fileName`      | `tab.input.uri.fsPath`                                   |
| `languageId`    | `'pdf'`                                                  |
| `lineCount`     | total page count — only known for the active tab, use `currentSelection.totalPages` or `0` |
| `isUntitled`    | `false`                                                  |
| `selection`     | only meaningful for the active tab; use the same `{start, end, isReversed:false}` shape, mapped from `currentSelection` |

Return `mcpText({ tabs: [...] })`.

**`getWorkspaceFolders` handler:** read `vscode.workspace.workspaceFolders` and format as:

```ts
{
  success: true,
  folders: folders.map((f) => ({
    name: f.name,
    uri: f.uri.toString(),
    path: f.uri.fsPath,
  })),
  rootPath: folders[0]?.uri.fsPath,
}
```

Return `mcpText(...)`.

**`getDiagnostics` handler:** PDFs don't produce diagnostics. **We still must register the tool** — Claude Code calls it as part of context-gathering and returning "method not found" would be noisier than returning empty. Return `mcpText([])`.

**`handleToolCall` dispatcher:**

```ts
function handleToolCall(params: { name?: string }): unknown {
  switch (params.name) {
    case 'getCurrentSelection':  return handleGetCurrentSelection();
    case 'getLatestSelection':   return handleGetLatestSelection();
    case 'getOpenEditors':       return handleGetOpenEditors();
    case 'getWorkspaceFolders':  return handleGetWorkspaceFolders();
    case 'getDiagnostics':       return handleGetDiagnostics();
    default:
      return { error: { code: -32601, message: `Tool not found: ${params.name}` } };
  }
}
```

**Result:** All five tools respond with real data, and `tools/list` advertises them.

**Verify:**
```bash
npm run check-types
```

### 5.4 Implement broadcastSelectionChanged

Still in [src/claudeServer.ts](src/claudeServer.ts), add:

```ts
function broadcastSelectionChanged(sel: PdfSelection): void {
  if (clients.size === 0) { return; }
  broadcast('selection_changed', selectionToPayload(sel));
}
```

This notification has no `id` (fire-and-forget) and is sent to every connected Claude Code client.

**Result:** The server can proactively push selection updates to Claude Code.

### 5.5 Mirror webview selection into the extension host

Update [media/preview.js](media/preview.js):

Inside the existing debounced `selectionchange` / `mouseup` callback (the one that shows/hides the action bar), also post a message to the extension host describing the current selection:

```js
// Always post an update, even if selection is empty -- the extension
// uses empty text to clear currentSelection.
const range = selectionPageRange();
vscode.postMessage({
  type: 'selectionUpdate',
  text: range ? range.text : '',
  startPage: range ? range.startPage : 0,
  endPage: range ? range.endPage : 0,
  totalPages: window.__pdfTotalPages ?? 0,   // set during PDF load
});
```

Store `totalPages` on `window.__pdfTotalPages` during PDF load so we can include it in every selection update.

Update [src/pdfProvider.ts](src/pdfProvider.ts) to handle the new message type:

```ts
case 'selectionUpdate': {
  if (msg.text.length === 0) {
    clearCurrentSelection();
  } else {
    setCurrentSelection({
      text: msg.text,
      filePath: document.uri.fsPath,
      fileUrl: document.uri.toString(),
      startPage: msg.startPage,
      endPage: msg.endPage,
      totalPages: msg.totalPages,
    });
  }
  break;
}
```

Import `setCurrentSelection` and `clearCurrentSelection` from `./claudeServer`.

**Result:** Every selection change in the webview updates the server's selection state and broadcasts `selection_changed` to Claude Code (if connected).

**Verify:** With Claude Code connected, select text in a PDF. Check the debug console in the extension host -- you should see the selection state being mirrored.

### Test method

**What to test:** Claude Code can query the current PDF selection via `getCurrentSelection`, retrieve the last non-empty selection via `getLatestSelection` (even after the user clicks away), list open PDFs via `getOpenEditors`, and receives proactive `selection_changed` notifications when the user selects text.

**How to test:**
1. Launch the extension in dev mode.
2. Run `claude` in a terminal, run `/ide`, select "Ask PDF".
3. Open a multi-page PDF.
4. Select text on page 3.
5. Without clicking the Claude button, ask Claude: "What am I looking at right now?"
6. Confirm Claude references the selected text (it either used the `selection_changed` broadcast directly or called `getCurrentSelection`).
7. Click into an empty area of the PDF to clear the selection.
8. Ask Claude: "What was I just looking at?"
9. Confirm Claude references the last selection (it called `getLatestSelection`).
10. Ask Claude to list open files. Confirm it sees the PDF with `languageId: "pdf"`.

**Expected result:** Claude Code answers correctly based on live selection state without requiring any button click. `getCurrentSelection` returns the live selection; `getLatestSelection` returns the last non-empty selection; `getOpenEditors` lists the open PDF.

---

## Phase 6 -- Page navigation

**Goal:** The user can navigate between pages using keyboard shortcuts, a page indicator, and a go-to-page input.

**What gets built in this phase:**

- [media/preview.js](media/preview.js) -- Updated with page navigation controls.
  - Page indicator at the top of the viewport showing "Page N of M".
  - `IntersectionObserver` on each `.pdf-page` to detect which page is most visible and update the indicator.
  - Clicking the indicator opens a go-to-page text input. Enter scrolls to that page. Escape or blur reverts to the indicator.
  - Keyboard shortcuts: PageDown scrolls to the next page, PageUp to the previous page, Home to page 1, End to the last page.
- [media/preview.css](media/preview.css) -- Updated with styles for the page indicator and go-to-page input.

### 6.1 Add page indicator

Update [media/preview.js](media/preview.js):

1. Create a fixed-position `<div id="page-indicator">` showing "Page N of M".
2. After all pages render, set up an `IntersectionObserver` with `threshold: 0.5` on each `.pdf-page`. When a page crosses the threshold, update the indicator text.

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

Listen for `keydown` events:
- `PageDown` -- scroll to the next page.
- `PageUp` -- scroll to the previous page.
- `Home` -- scroll to page 1.
- `End` -- scroll to the last page.

Do not handle these when the go-to-page input is focused.

**Result:** Keyboard page navigation works.

**Verify:** Open a PDF, press PageDown several times, confirm pages advance. Press Home, confirm it returns to page 1.

### 6.4 Add page indicator and input styles to preview.css

Update [media/preview.css](media/preview.css):

- `#page-indicator` -- fixed position top-center, `z-index: 98`, widget background, rounded, small padding, semi-transparent, hover brightens.
- `#page-indicator input` -- small number input styled to match the indicator.

**Result:** Indicator and input are styled consistently.

**Verify:** Visual inspection.

### Test method

**What to test:** Page indicator shows the correct current page. Go-to-page works. Keyboard shortcuts navigate correctly.

**How to test:** Open a 10+ page PDF. Scroll to page 5 -- confirm indicator says "Page 5 of N". Click indicator, type "8", press Enter -- confirm page 8 is in view and indicator says "Page 8 of N". Press PageDown -- confirm page 9. Press Home -- confirm page 1.

**Expected result:** All navigation methods work and the indicator stays in sync.

---

## Phase 7 -- Polish (error handling, keepalive, openFile)

**Goal:** The extension handles corrupt PDFs gracefully, survives laptop sleep without dropping the Claude Code connection, and lets Claude Code drive page navigation via a new `openFile` tool.

**What gets built in this phase:**

- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated with error handling for corrupt or encrypted PDFs, and empty files.
- [media/preview.js](media/preview.js) -- Updated to show a clear error message in the webview when pdf.js fails to load a document, to handle empty PDFs, and to listen for a new `scrollToPage` message that triggers page navigation (used by the `openFile` tool).
- [src/claudeServer.ts](src/claudeServer.ts) -- Updated with:
  - Ping/pong keepalive with wake-from-sleep detection so the WebSocket connection survives closing the laptop lid.
  - A sixth MCP tool, `openFile`, that lets Claude Code tell the extension to scroll to a specific page.
  - An `onOpenFile` callback that `pdfProvider.ts` registers so the tool can forward the page navigation request into the active webview.

### 7.1 Error handling for bad PDFs

Update [media/preview.js](media/preview.js):
- Wrap the `pdfjsLib.getDocument` call in a try/catch.
- If pdf.js fails (corrupt, encrypted, unsupported format), show an error message in the webview: `"Failed to load PDF: <error message>"` styled with the `.error` class.
- If the file is empty (zero bytes), show `"This PDF is empty."`.

Update [src/pdfProvider.ts](src/pdfProvider.ts):
- Before posting PDF data, check if the file is empty. If so, post `{ type: 'pdfEmpty' }` instead.

**Result:** Bad PDFs show a clear error instead of a blank page or crash.

**Verify:** Open a corrupt PDF (e.g., a text file renamed to `.pdf`). Confirm an error message appears in the webview.

### 7.2 Add ping/pong keepalive with wake-from-sleep detection

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

### 7.3 Implement openFile tool (Claude drives page navigation)

Update [src/claudeServer.ts](src/claudeServer.ts):

Add a new tool `openFile` with this schema:

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

Update [src/pdfProvider.ts](src/pdfProvider.ts):

In `resolveCustomEditor`, register the callback:

```ts
setOnOpenFile((filePath, startPage, endPage) => {
  if (filePath !== document.uri.fsPath) { return; }
  webviewPanel.webview.postMessage({ type: 'scrollToPage', page: startPage });
});
```

Update [media/preview.js](media/preview.js):

Handle the `scrollToPage` message by finding the `.pdf-page[data-page="N"]` element and calling `scrollIntoView({ behavior: 'smooth', block: 'start' })`.

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

**What to test:** Error handling for corrupt PDFs. Keepalive survives sleep. `openFile` drives navigation. Clean compile.

**How to test:**
1. Open a file that is not a valid PDF but has a `.pdf` extension -- confirm error message.
2. Connect Claude Code, close the laptop lid for 2+ minutes, reopen, confirm the connection is still alive.
3. Ask Claude to use `openFile` to jump to a page, confirm the webview scrolls.
4. Run `npm run check-types && npm run lint`.

**Expected result:** Error message for corrupt files. Connection survives sleep. `openFile` works. Clean compile.

---

## Phase 8 -- Ship

**Goal:** The extension is packaged as a `.vsix` file and installable in VS Code.

**What gets built in this phase:**

- `ask-pdf-0.1.0.vsix` -- The packaged extension file.
- [README.md](README.md) -- Updated with feature description, usage instructions, and requirements.
- [media/icon.png](media/icon.png) -- Extension icon (128x128 PNG).

### 8.1 Update README.md

Write [README.md](README.md) with:
- One-line description.
- Features list (PDF rendering, text selection, floating action bar, Claude Code integration with live selection broadcasting, page navigation, Claude-driven page jumps via `openFile`).
- Claude Code integration instructions (run `claude`, use `/ide`, select Ask PDF).
- Requirements (VS Code 1.85+, Claude Code CLI).
- Extension settings reference (`ask-pdf.showFloatingButton`).

**Result:** README is complete.

**Verify:**
```bash
head -20 README.md
```

### 8.2 Add extension icon

Create or place [media/icon.png](media/icon.png) -- a 128x128 PNG icon for the extension.

**Result:** Icon file exists.

**Verify:**
```bash
ls media/icon.png
```

### 8.3 Package the extension

```bash
npx @vscode/vsce package
```

**Result:** `ask-pdf-0.1.0.vsix` is created.

**Verify:**
```bash
ls *.vsix
```

### 8.4 Install and smoke test

```bash
code --install-extension ask-pdf-0.1.0.vsix
```

1. Open VS Code (not in dev mode).
2. Open a PDF file.
3. Confirm it renders.
4. Select text, confirm action bar appears.
5. Run `claude`, connect via `/ide`, select text, ask a question without clicking the button -- confirm Claude knows the selection.
6. Click "Claude" -- confirm the reference appears in the terminal.

**Result:** Extension works when installed from the `.vsix`.

**Verify:** All 6 checks above pass.

### Test method

**What to test:** The packaged extension installs and works end-to-end, including proactive selection broadcasting.

**How to test:** Install the `.vsix` in a clean VS Code window. Open a PDF. Select text. Ask Claude about it without clicking. Click Claude. Confirm the full flow works.

**Expected result:** PDF renders, action bar works, Claude Code connects, live selection broadcasting works (Claude answers without needing a button click), `at_mentioned` on click also works, keepalive survives sleep.
