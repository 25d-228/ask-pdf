# ask-pdf Development Plan

## What this project is

ask-pdf is a VS Code extension that opens PDF files in a rendered webview using pdf.js. Users can select text in the rendered PDF, and a floating action bar appears with a button to send the selected text and page reference to Claude Code. The extension runs a local MCP WebSocket server that Claude Code CLI connects to, and it **proactively broadcasts the current selection** to Claude Code whenever it changes — so when the user Tab-switches to their `claude` terminal and asks "explain this", Claude already knows exactly which passage they're looking at. It's the PDF counterpart to ask-markdown, following the same architecture and UX patterns.

A critical design choice: every MCP message references a **readable markdown sidecar file**, not the binary PDF. When a PDF is opened, the extension extracts text, images, tables, and structural metadata from every page using pdf.js, writes them to a `.pdf.md` file in a temp directory, and maps page numbers to real line numbers in that file. Claude Code can then read, search, and re-read any part of the document — not just the current selection. This solves the fundamental problem that PDFs are binary and Claude Code's file tools can't parse them.

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

After Phase 6, the extension will also produce at runtime:

```text
$TMPDIR/ask-pdf/           -- or os.tmpdir()/ask-pdf/
  <basename>.pdf.md        -- markdown sidecar (text + image refs + tables)
  <basename>.pdf.images/   -- extracted images as PNG files
    page3-fig1.png
    page5-fig2.png
```

And `src/sidecar.ts` will be added to the source tree.

All commands run from the repo root `/Users/ip33/Documents/GitHub/ask-pdf`.

---

## Phase 1 -- Project setup [DONE]

**Goal:** The project runs inside a pinned Node environment, compiles, lints, and produces a bundled extension that activates on PDF files.

**What was built:** [.nvmrc](.nvmrc), [package.json](package.json) (v0.0.4), [tsconfig.json](tsconfig.json), [eslint.config.mjs](eslint.config.mjs), [esbuild.js](esbuild.js), [src/extension.ts](src/extension.ts), [.gitignore](.gitignore), [.vscodeignore](.vscodeignore).

**Commits:** `98fc70a`, `c7a9fa6`.

---

## Phase 2 -- PDF rendering in webview [DONE]

**Goal:** Opening a PDF file in VS Code shows all pages rendered in a webview with selectable text.

**What was built:** [src/pdfProvider.ts](src/pdfProvider.ts) (CustomReadonlyEditorProvider, CSP, base64 transport), [media/preview.js](media/preview.js) (pdf.js dynamic import, HiDPI canvas, TextLayer overlay), [media/preview.css](media/preview.css) (theme-aware styles, selection highlight).

**Commit:** `4101bb8`.

---

## Phase 3 -- Floating action bar, zoom controls, and page mapping [DONE]

**Goal:** When text is selected in the PDF preview, a floating bar appears with a "Claude" button. Zoom controls let the user scale the PDF.

**What was built:** [src/pageMapper.ts](src/pageMapper.ts) (`formatPageRef`), [media/preview.js](media/preview.js) (selection page range detection, `#ask-bar` with Claude button, `#zoom-bar` with +/-/Reset, Ctrl/Cmd+wheel and keyboard zoom, 0.5x-4.0x range), [media/preview.css](media/preview.css) (bar styles), [src/pdfProvider.ts](src/pdfProvider.ts) (`askClaude` handler, `showFloatingButton` setting).

**Commit:** `826c502`.

---

## Phase 4 -- MCP server foundation [DONE]

**Goal:** Claude Code CLI can find and connect to ask-pdf, complete the MCP handshake, and receive an `at_mentioned` notification when the user clicks the "Claude" button.

**What was built:** [src/claudeServer.ts](src/claudeServer.ts) (lock file at `~/.claude/ide/{port}.lock`, HTTP server on `127.0.0.1:0`, WebSocket upgrade with auth token, JSON-RPC dispatcher for `initialize`/`notifications/initialized`/`prompts/list`/`tools/list`/`tools/call`, `broadcast`/`isConnected`/`startServer`/`stopServer`), [src/extension.ts](src/extension.ts) (server lifecycle), [src/pdfProvider.ts](src/pdfProvider.ts) (`at_mentioned` broadcast on Claude button click).

**Commit:** `0fafd61`.

---

## Phase 5 -- MCP tools and proactive selection broadcasting [DONE]

**Goal:** Claude Code gets live selection context without polling. The user selects text in the PDF, `selection_changed` fires over WebSocket, and Claude Code can call five MCP tools to query state on demand.

**What was built:** [src/claudeServer.ts](src/claudeServer.ts) (`PdfSelection` interface, `currentSelection`/`latestSelection` state, `selectionToPayload`, `broadcastSelectionChanged`, five tools: `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`), [media/preview.js](media/preview.js) (`selectionUpdate` messages, `window.__pdfTotalPages`), [src/pdfProvider.ts](src/pdfProvider.ts) (selection forwarding).

**Known limitation (addressed in Phase 6):** All MCP payloads reference the binary PDF path and fake line numbers (page-as-line). Claude Code cannot read the binary PDF, so `@paper.pdf:3` is a dead reference.

**Commit:** `1d53ce9`.

---

## Phase 6 -- Markdown sidecar extraction

**Goal:** When a PDF is opened, the extension extracts its full content — text, images, tables, annotations, outline — into a readable `.pdf.md` markdown file in a temp directory, with extracted images saved alongside as PNGs. All MCP messages switch from referencing the binary PDF to referencing the sidecar, with real line numbers. Claude Code can now read, search, and re-read any part of the document.

This phase fixes the fundamental problem identified at the end of Phase 5: every MCP payload sent the binary PDF path, which Claude Code cannot read.

### The problem in detail

The MCP integration (Phases 4-5) tells Claude Code about files using `filePath` and LSP-style `line`/`character` positions. For a text editor, Claude reads the file at those positions. For PDFs:

1. The `filePath` points to a binary file — Claude's Read tool gets garbage.
2. The `line` numbers are faked (page-as-line) — they don't correspond to anything in the file.
3. When the user asks "what comes after this?", Claude has no way to read surrounding context.
4. Images, figures, tables, and formulas in the PDF are invisible to Claude entirely.

### What pdf.js can extract

| API                                                         | Data                                                                                  |
|-------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `page.getTextContent()`                                     | Text items with position (x, y), font size, font family, direction, EOL flags.        |
| `page.getOperatorList()` + `OPS.paintImageXObject`          | Embedded images — decoded pixel data (width, height, RGBA/RGB).                       |
| `page.getOperatorList()` + `OPS.constructPath` + stroke/fill | Lines and rectangles — raw drawing commands that form table borders, rules, diagrams. |
| `page.getAnnotations()`                                     | Link annotations with URLs and internal destinations.                                 |
| `page.getStructTree()`                                      | Structural tag tree (if the PDF is tagged — many are not).                            |
| `pdf.getOutline()`                                          | Document outline / table of contents / bookmarks.                                     |
| `pdf.getMetadata()`                                         | Title, author, creator, creation date.                                                |
| Text item `.height` + `.fontName`                           | Font size and family — distinguishes headings from body from code.                    |

What pdf.js does **not** do natively: table detection, column layout detection, figure/caption association, or semantic paragraph grouping. These must be inferred from positions, font sizes, and path geometry.

### The sidecar approach

For each open PDF, write a markdown file that Claude Code can read like any source file at `$TMPDIR/ask-pdf/`. The sidecar is structured markdown with page delimiters (`## Page N`), heading detection from font sizes, code detection from monospace fonts, images as `![label](path)` references, tables as pipe tables, and link annotations as markdown links. The extension builds a page-to-line mapping (`Map<pageNum, { startLine, endLine }>`) so every MCP payload can reference real line numbers.

**What gets built in this phase:**

- [src/sidecar.ts](src/sidecar.ts) -- New file. Extracts content from PDF pages and writes the markdown sidecar.
  - `SidecarResult` -- Return type holding the sidecar path, images directory, and page-to-line mapping.
  - `buildSidecar(pdfPath, pages)` -- Takes the PDF file path and an array of per-page extracted data. Writes the `.pdf.md` file and image PNGs. Returns the sidecar path and page-to-line mapping.
  - `removeSidecar(sidecarPath)` -- Cleans up the sidecar file and images directory.
  - `sidecarDir()` -- Returns `os.tmpdir()/ask-pdf/`, creating it if needed.
  - `formatTextItems(items, styles)` -- Clusters text items by Y position into lines. Uses font size to detect headings (significantly larger than body text). Uses font family to detect code spans (monospace). Merges items on the same line with appropriate spacing.
  - `detectImages(ops, page)` -- Walks the operator list looking for `paintImageXObject` and `paintInlineImageXObject`. Extracts pixel data and encodes as PNG.
  - `detectTables(textItems, pathOps)` -- Heuristic table detection. Looks for grid-aligned text near horizontal/vertical line segments. Falls back to tab-separated columns when path data is absent. Formats detected tables as markdown pipe tables.
  - `formatAnnotations(annotations)` -- Converts link annotations to markdown links.
- [media/preview.js](media/preview.js) -- Updated. After rendering all pages, extracts per-page data (text content, operator list images, annotations, path segments, viewport) and sends it to the extension host as a `pdfExtracted` message.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated. Handles `pdfExtracted` message, calls `buildSidecar`, stores the result. Calls `removeSidecar` on panel dispose.
- [src/claudeServer.ts](src/claudeServer.ts) -- Updated. All MCP payloads (`selectionToPayload`, `at_mentioned`, `getOpenEditors`) switch from the binary PDF path to the sidecar path, and from fake page-as-line numbers to real line numbers from the page mapping. Adds `originalPdfPath` as a secondary field so Claude knows which actual file is open.

### 6.1 Create src/sidecar.ts -- text formatting core

Create [src/sidecar.ts](src/sidecar.ts) with the text extraction and formatting logic.

Define interfaces for the data that flows from the webview: `PageData` (pageNum, textItems, styles, images, annotations, pathSegments, viewport), `ExtractedImage` (dataUrl, position, dimensions, label), `TextItem` (str, dir, width, height, transform, fontName, hasEOL), `TextStyle` (fontFamily, ascent, descent, vertical), `PathSegment` (type, coordinates), `Annotation` (subtype, rect, url, dest, contents), `SidecarResult` (sidecarPath, imagesDir, pageLineMap).

The core function `formatTextItems` takes raw text items from `getTextContent()` and produces readable text:

1. **Sort items by position.** Group by Y coordinate (with tolerance for baseline variation within a line -- items within 2pt of the same Y are on the same line). Sort groups top-to-bottom, items within a group left-to-right.
2. **Detect headings.** Compute the median font height across all items (this is the body text size). Items whose height exceeds the median by 20%+ are headings. One `#` per step above median: 40%+ above is `#`, 20-40% is `##`.
3. **Detect code spans.** Items in a monospace font family get wrapped in backticks if inline, or fenced code blocks if they form consecutive lines.
4. **Merge items into lines.** Concatenate items on the same line. If the gap between two adjacent items exceeds 2x the font size, insert a space. Respect `hasEOL` flags for line breaks.
5. **Detect paragraphs.** Consecutive lines with similar Y-spacing are a paragraph. A gap larger than 1.5x the line spacing starts a new paragraph (blank line in output).

**Result:** File created with text formatting logic and type definitions.

**Verify:**
```bash
npm run check-types
```

### 6.2 Add image extraction to the webview

Update [media/preview.js](media/preview.js).

After rendering each page, extract images from the operator list. The webview has access to the canvas API, which is the natural place to decode image pixel data into PNGs.

For each `paintImageXObject` op (fnArray code 85) in the operator list: get the image object from the page's `objs` collection via `page.objs.get(objId)`. The object contains raw pixel data (RGBA, RGB, or grayscale). Create an offscreen canvas, convert to the correct RGBA format based on the image kind, put the image data on it, call `canvas.toDataURL('image/png')`. Record the position from the current transform matrix.

For `paintInlineImageXObject` (fnArray code 86), the image data is directly in the args array. Handle the same way.

Also extract path segments from `constructPath` ops (fnArray code 91) for table detection. Walk the sub-operations array: `lineTo` (code 2) produces line segments, `rect` (code 5) produces rectangle segments. Collect coordinates from the flat args array.

After all pages are rendered, send the full extracted data as a `pdfExtracted` message to the extension host, including per-page text content, styles, images, annotations, path segments, and viewport dimensions.

**Result:** The webview extracts full page data and sends it to the extension host.

**Verify:** Open a PDF with images. Check the debug console for `pdfExtracted` message size.

### 6.3 Add table detection heuristic to sidecar.ts

Update [src/sidecar.ts](src/sidecar.ts) with `detectTables`.

The heuristic:

1. **Find horizontal lines.** Filter path segments where `y1 === y2` (horizontal) or `x1 === x2` (vertical), with a tolerance of 1pt.
2. **Cluster horizontal lines by Y.** Groups of 3+ horizontal lines at roughly equal Y spacing, with similar X extents, suggest table rows.
3. **Match text to cells.** For each candidate table region, find text items whose Y falls between consecutive horizontal lines. Group these by X position (column alignment).
4. **Format as markdown.** Emit a pipe table with header separator.
5. **Fallback for borderless tables.** If no path segments exist near a region but text items have consistent column-aligned X positions (3+ rows with 2+ columns at the same X offsets), treat it as a borderless table.

Mark text items consumed by table detection so they are not also emitted as regular paragraphs.

**Result:** Tables in the PDF are formatted as readable markdown tables in the sidecar.

**Verify:**
```bash
npm run check-types
```

### 6.4 Implement buildSidecar (assemble the markdown file)

Update [src/sidecar.ts](src/sidecar.ts) with the main `buildSidecar` function.

1. Create the sidecar directory: `os.tmpdir()/ask-pdf/`.
2. Determine the sidecar file name: `<basename>.pdf.md`. If a sidecar already exists for this PDF path, overwrite it.
3. For each page, call `formatTextItems`, `detectTables`, and `formatAnnotations`. Save images from `dataUrl` to PNG files in `<basename>.pdf.images/`.
4. Assemble the full markdown: header comment with PDF path, page count, and extraction timestamp. Outline / TOC (if provided) formatted as a bullet list. Per-page sections with `## Page N` headers. Text, images (`![label](path)`), tables, and annotation links.
5. Track the starting line number of each `## Page N` header in the output. Build `pageLineMap`.
6. Write the file. Return `SidecarResult`.

Also implement `removeSidecar` to delete the file and images directory.

**Result:** Opening a PDF produces a readable markdown sidecar alongside extracted images.

**Verify:**
```bash
npm run check-types
```

### 6.5 Wire sidecar into pdfProvider.ts

Update [src/pdfProvider.ts](src/pdfProvider.ts).

Handle the `pdfExtracted` message from the webview: call `buildSidecar(document.uri.fsPath, msg.pages, outline)`, store the result, and call `registerSidecar(document.uri.fsPath, result)` (imported from `./claudeServer`).

On `webviewPanel.onDidDispose`, call `removeSidecar` and `unregisterSidecar`.

Pass the document outline (from `pdf.getOutline()` -- fetched in the webview and sent alongside) to `buildSidecar` for the TOC section.

**Result:** Sidecar is built when PDF is opened and cleaned up when closed.

**Verify:** Open a PDF in dev mode. Check that `$TMPDIR/ask-pdf/<name>.pdf.md` exists with readable content.

### 6.6 Switch all MCP payloads to use the sidecar

Update [src/claudeServer.ts](src/claudeServer.ts).

Add a sidecar registry: a `Map<string, SidecarInfo>` keyed by PDF path, with exported `registerSidecar` and `unregisterSidecar` functions.

Update `selectionToPayload`: look up the sidecar for the selection's PDF path. If found, use the sidecar path as `filePath` and convert page numbers to real line numbers via the `pageLineMap`. Include `originalPdfPath` as a secondary field.

Update the `at_mentioned` broadcast in [src/pdfProvider.ts](src/pdfProvider.ts) to use the sidecar path and line numbers.

Update `handleGetOpenEditors` to use sidecar paths for `uri`, `fileName`, and `lineCount` (total lines in sidecar file).

**Result:** Every MCP message now references a readable file with real line numbers. Claude Code can read `@paper.pdf.md:47` and see actual content.

**Verify:**
1. Open a PDF in dev mode.
2. Run `claude` in terminal, connect via `/ide`.
3. Select text on page 2, click "Claude".
4. Confirm Claude Code shows `@paper.pdf.md:N` (not `@paper.pdf:2`).
5. Ask Claude "read line N of that file" -- confirm it returns readable text.
6. Ask Claude "what comes after the passage I selected?" -- confirm it reads the sidecar and answers correctly.

### Test method

**What to test:** Sidecar is created on PDF open, contains readable text organized by page, includes images as referenced PNGs, detects tables as markdown. All MCP messages reference the sidecar path with correct line numbers. Claude Code can read and search the sidecar.

**How to test:**
1. Open a PDF with text, images, and tables.
2. Verify `$TMPDIR/ask-pdf/<name>.pdf.md` exists and is readable markdown.
3. Verify images are saved in `$TMPDIR/ask-pdf/<name>.pdf.images/`.
4. Connect Claude Code. Select text. Ask Claude to read the sidecar around that selection.
5. Close the PDF tab. Verify the sidecar and images are cleaned up.
6. Open a text-only PDF. Verify sidecar contains text with correct page boundaries.

**Expected result:** Sidecar is correct markdown. Images are valid PNGs. MCP messages use sidecar paths. Claude Code can read and navigate the sidecar. Cleanup works.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- That Claude Code now references a readable `.pdf.md` file instead of the binary PDF.
- The sidecar location (`$TMPDIR/ask-pdf/`).
- How to verify: open a PDF, check the sidecar file, connect Claude and ask it to read surrounding context.

---

## Phase 7 -- Page navigation

**Goal:** The user can navigate between pages using keyboard shortcuts, a page indicator, and a go-to-page input.

**What gets built in this phase:**

- [media/preview.js](media/preview.js) -- Updated with page navigation controls.
  - `#page-indicator` at the top of the viewport showing "Page N of M".
  - `IntersectionObserver` on each `.pdf-page` to detect which page is most visible and update the indicator.
  - Clicking the indicator opens a go-to-page text input. Enter scrolls to that page. Escape or blur reverts to the indicator.
  - Keyboard shortcuts: PageDown scrolls to the next page, PageUp to the previous page, Home to page 1, End to the last page.
  - `scrollToPage` message handler that scrolls a target page into view (used by the `openFile` tool in Phase 8).
- [media/preview.css](media/preview.css) -- Updated with styles for the page indicator and go-to-page input.

### 7.1 Add page indicator

Update [media/preview.js](media/preview.js).

Create a fixed-position `<div id="page-indicator">` showing "Page N of M". Position it at top-center, to the left of the existing zoom bar. After all pages render, set up an `IntersectionObserver` with `threshold: 0.5` on each `.pdf-page`. When a page crosses the threshold, update the indicator text. Store the current page number in a module-level variable so other features can read it.

**Result:** Page indicator updates as the user scrolls.

**Verify:** Open a PDF, scroll through pages, confirm the indicator updates.

### 7.2 Add go-to-page input

Update [media/preview.js](media/preview.js).

When the user clicks the page indicator: replace the indicator text with a number input field (min 1, max totalPages). On Enter, scroll the target page into view with smooth scrolling. On Escape or blur, revert to the indicator text.

**Result:** Clicking the indicator lets the user jump to a page.

**Verify:** Click the indicator, type "5", press Enter. Confirm page 5 scrolls into view.

### 7.3 Add keyboard navigation

Update [media/preview.js](media/preview.js).

Listen for `keydown` events (only when the go-to-page input is NOT focused): PageDown scrolls to the next page, PageUp to the previous page, Home to page 1, End to the last page. Use `scrollIntoView({ behavior: 'smooth', block: 'start' })`.

**Result:** Keyboard page navigation works.

**Verify:** Open a PDF, press PageDown several times, confirm pages advance. Press Home, confirm it returns to page 1.

### 7.4 Add scrollToPage message handler

Update [media/preview.js](media/preview.js).

In the `window.addEventListener('message', ...)` handler, add a case for `scrollToPage`. Look up the `.pdf-page` element with the matching `data-page` attribute and scroll it into view. This will be triggered by the `openFile` MCP tool added in Phase 8.

**Result:** The extension host can request page navigation from the webview.

**Verify:** Defer verification to Phase 8 when `openFile` is wired up.

### 7.5 Add page indicator and input styles to preview.css

Update [media/preview.css](media/preview.css).

Style `#page-indicator` with fixed position top-center, `z-index: 101`, widget background, rounded corners, semi-transparent, hover brightens. Position it to the left of the zoom bar. Style the number input inside it to match the indicator (no spin buttons). Add an `.editing` state that widens to accommodate the input field.

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

## Phase 8 -- Polish (keepalive, openFile tool)

**Goal:** The extension survives laptop sleep without dropping the Claude Code connection, and lets Claude Code drive page navigation via a new `openFile` tool.

**What gets built in this phase:**

- [src/claudeServer.ts](src/claudeServer.ts) -- Updated with:
  - Ping/pong keepalive with wake-from-sleep detection so the WebSocket connection survives closing the laptop lid.
  - A sixth MCP tool, `openFile`, that lets Claude Code tell the extension to scroll to a specific page.
  - An `onOpenFile` callback that `pdfProvider.ts` registers so the tool can forward the page navigation request into the active webview.
- [src/pdfProvider.ts](src/pdfProvider.ts) -- Updated to register the `onOpenFile` callback, forwarding `scrollToPage` messages to the webview.

### 8.1 Add ping/pong keepalive with wake-from-sleep detection

Update [src/claudeServer.ts](src/claudeServer.ts).

Track `lastPong` on each connected client. On `ws.on('pong')`, update `lastPong` to `Date.now()`. Start a 30-second interval timer that pings each client and disconnects any whose `lastPong` is older than 60 seconds.

Wake-from-sleep detection: record `lastTick` at the top of each interval. If the elapsed time since the previous tick is greater than 45 seconds (1.5x the interval), assume the system was suspended and forgive everyone's `lastPong` (set it to `Date.now()`) before doing the liveness check. Without this, closing a laptop lid for 5 minutes would kill every connection even though nothing is actually wrong.

Clear the timer in `stopServer`.

**Result:** Connection survives laptop sleep without a false disconnect.

**Verify:** Connect Claude Code, close and reopen your laptop, confirm the connection is still live.

### 8.2 Implement openFile tool (Claude drives page navigation)

Update [src/claudeServer.ts](src/claudeServer.ts).

Add a new tool `openFile` to `TOOL_DEFINITIONS`. It accepts `filePath` (string, required), `startLine` (integer, optional -- line in sidecar or 1-based page number to scroll to), `endLine` (integer, optional), and `makeFrontmost` (boolean, default true).

The handler resolves `startLine` back to a page number using the sidecar's inverse line mapping (find the page whose line range contains `startLine`). Falls back to treating `startLine` as a 1-indexed page number if no sidecar is registered. Calls the registered `onOpenFile` callback.

Add an exported `setOnOpenFile(cb)` function that stores the callback.

**Result:** Claude Code can call `openFile` and the callback fires.

### 8.3 Wire openFile into pdfProvider.ts

Update [src/pdfProvider.ts](src/pdfProvider.ts).

Import `setOnOpenFile` from `./claudeServer`. In `resolveCustomEditor`, register a callback that checks if the `filePath` matches the current document and, if so, posts a `scrollToPage` message to the webview with the resolved page number. The `scrollToPage` message handler in `preview.js` was already added in Phase 7.4.

**Result:** Claude Code can call `openFile` and the user sees the PDF scroll to the requested page.

**Verify:** From the Claude Code terminal, ask: "use the openFile tool to jump to page 5". Confirm the PDF scrolls to page 5.

### 8.4 Final lint and type check

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

## Phase 9 -- Ship

**Goal:** The extension is packaged as a `.vsix` file with a complete README and installable in VS Code.

**Status:** Partially done. Extension icon exists. VSIX files have been built through v0.0.4. README is still a stub.

**What gets built in this phase:**

- [README.md](README.md) -- Full feature description, usage instructions, and requirements.
- Version bump in [package.json](package.json) to reflect the release.
- Final `.vsix` package.

### 9.1 Update README.md

Write [README.md](README.md) with: one-line description, features list (PDF rendering, text selection, floating action bar, zoom controls, markdown sidecar extraction with images and tables, Claude Code integration with live selection broadcasting, page navigation, Claude-driven page jumps via `openFile`), how the sidecar works, Claude Code integration instructions, requirements (VS Code 1.85+, Claude Code CLI), extension settings reference, keyboard shortcuts reference.

**Result:** README is complete.

**Verify:**
```bash
head -30 README.md
```

### 9.2 Package the extension

Bump the version in [package.json](package.json) as appropriate, then package:

```bash
npx @vscode/vsce package
```

**Result:** New `.vsix` file is created.

**Verify:**
```bash
ls *.vsix
```

### 9.3 Install and smoke test

```bash
code --install-extension ask-pdf-*.vsix
```

1. Open VS Code (not in dev mode).
2. Open a PDF file. Confirm it renders.
3. Select text, confirm action bar appears.
4. Test zoom controls.
5. Test page navigation (page indicator, go-to-page, keyboard).
6. Verify sidecar exists in `$TMPDIR/ask-pdf/`.
7. Run `claude`, connect via `/ide`, select text, ask a question -- confirm Claude knows the selection.
8. Ask Claude "what comes after the passage I selected?" -- confirm Claude reads surrounding context from the sidecar.
9. Click "Claude" -- confirm the reference points to the sidecar, not the binary PDF.
10. Ask Claude to use `openFile` to jump to a specific page.
11. Open a PDF with figures -- confirm images are extracted and Claude can reference them.

**Result:** Extension works when installed from the `.vsix`.

**Verify:** All checks above pass.

### Test method

**What to test:** The packaged extension installs and works end-to-end, including sidecar extraction and proactive selection broadcasting.

**How to test:** Install the `.vsix` in a clean VS Code window. Open a PDF with text, images, and tables. Verify sidecar. Connect Claude and test the full flow.

**Expected result:** PDF renders, action bar works, zoom works, page navigation works, sidecar is readable markdown with images and tables, Claude Code connects, live selection broadcasting works, `at_mentioned` references the sidecar, Claude can read surrounding context, keepalive survives sleep.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- The final version number and VSIX file name.
- How to install: `code --install-extension <file>.vsix`.
