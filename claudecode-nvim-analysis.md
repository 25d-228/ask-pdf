# How Claude Code Integration Works (and what ask-pdf needs)

A deep-dive into how editor extensions integrate with the Claude Code CLI without using the Anthropic API — distilled from an analysis of [coder/claudecode.nvim](https://github.com/coder/claudecode.nvim) — and exactly how ask-pdf should implement each piece in TypeScript / VS Code.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [The architecture: asymmetric two-direction protocol](#2-the-architecture-asymmetric-two-direction-protocol)
3. [Discovery: lock files](#3-discovery-lock-files)
4. [The WebSocket server](#4-the-websocket-server)
5. [JSON-RPC 2.0 protocol](#5-json-rpc-20-protocol)
6. [The MCP tools ask-pdf needs](#6-the-mcp-tools-ask-pdf-needs)
7. [Selection tracking and broadcasting](#7-selection-tracking-and-broadcasting)
8. [Keepalive, liveness, wake-from-sleep](#8-keepalive-liveness-wake-from-sleep)
9. [Lifecycle: start, stop, shutdown](#9-lifecycle-start-stop-shutdown)
10. [PDF-specific adaptations](#10-pdf-specific-adaptations)
11. [Implementation priority for ask-pdf](#11-implementation-priority-for-ask-pdf)
12. [Protocol reference (exact wire format)](#12-protocol-reference-exact-wire-format)

---

## 1. Executive summary

**An editor extension that integrates with Claude Code never talks to the Anthropic API.** It has no API key, no HTTP client, no streaming response parser, no model picker. The extension is purely a **WebSocket MCP tool server** that the `claude` CLI connects to.

The split of responsibilities is:

| Component             | Role                                                                                      |
|-----------------------|-------------------------------------------------------------------------------------------|
| Claude Code CLI       | The only thing that calls the LLM. Full AI brain. User runs it in their own terminal.    |
| ask-pdf               | Exposes PDF state (current selection, current page, open files, workspace) via WebSocket MCP so Claude Code can use it as context. |

The user installs `claude` once (with their own subscription), runs `/ide` in the CLI, and ask-pdf shows up as an "IDE" Claude Code can attach to. Zero API key management on our side, zero billing code, zero streaming parser.

Everything in this document is about **the passive context channel**: ask-pdf exposes state, Claude Code reads it. We never call Claude from the extension. When the user wants an answer, they type into their own `claude` terminal.

---

## 2. The architecture: asymmetric two-direction protocol

Most people assume "editor integrates with Claude" means the editor calls Claude. It doesn't. Data flows in two directions, both initiated by Claude Code CLI once it's launched, and they're asymmetric in nature:

```text
                ┌──────────────────────┐
                │   Claude Code CLI    │  ← runs in a terminal
                │   (the LLM brain)    │
                └──────────────────────┘
                   ▲                ▲
                   │                │
         requests  │                │  notifications
         (id set)  │                │  (no id, fire-and-forget)
                   │                │
                   ▼                │
         ┌───────────────────────────────┐
         │   ask-pdf                     │  ← VS Code extension
         │   WebSocket MCP server        │
         │   127.0.0.1:{random_port}     │
         └───────────────────────────────┘
```

- **Claude → ask-pdf (requests):** `initialize`, `tools/list`, `tools/call`, `prompts/list`. These all carry an `id`; the extension must respond.
- **ask-pdf → Claude (notifications):** `selection_changed`, `at_mentioned`. No `id`, no response — fire and forget.

**There is no `tools/call` in the other direction.** The extension never asks Claude to do anything over the WebSocket. When the user wants an answer, they type into their own `claude` terminal — and because Claude Code can call `getCurrentSelection` on us, it already knows what the user is looking at.

Knowing that the protocol is asymmetric — **Claude drives, we answer, we also push state changes** — simplifies every design decision below. Our tool handlers are all synchronous reads from local state. No coroutines, no blocking operations, no deferred responses.

---

## 3. Discovery: lock files

Before Claude Code can connect to anything, it needs to know where the server is and whether to trust it. ask-pdf tells it via a **file convention** in a well-known directory.

### 3.1 Lock file location

Resolved as:

| Condition                               | Directory                    |
|-----------------------------------------|------------------------------|
| `$CLAUDE_CONFIG_DIR` set and non-empty  | `$CLAUDE_CONFIG_DIR/ide`     |
| otherwise                               | `~/.claude/ide`              |

The file name is `{port}.lock` where `{port}` is the WebSocket port we picked. Claude Code scans the directory and picks the lock file whose workspace matches the user's current project.

### 3.2 Lock file JSON

```json
{
  "pid": 12345,
  "workspaceFolders": ["/path/to/project"],
  "ideName": "Ask PDF",
  "transport": "ws",
  "authToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

Every field matters:

| Field              | Type        | Notes                                                                          |
|--------------------|-------------|--------------------------------------------------------------------------------|
| `pid`              | integer     | `process.pid`. Claude Code uses it to detect stale lock files from crashed IDEs. |
| `workspaceFolders` | `string[]`  | Absolute paths from `vscode.workspace.workspaceFolders`. Becomes the roots Claude considers "inside the workspace." |
| `ideName`          | string      | Shows up in Claude Code's `/ide` picker. For us: `"Ask PDF"`.                  |
| `transport`        | string      | Always `"ws"`.                                                                 |
| `authToken`        | string      | UUID v4. Validated on every WebSocket handshake. Length must be 10–500 chars. |

### 3.3 Auth token generation

Use `crypto.randomUUID()` from Node's built-in `node:crypto` module. That's 36 characters, well within the 10–500 range. No dependency needed.

```ts
import { randomUUID } from 'node:crypto';
const authToken = randomUUID();
```

### 3.4 Writing the lock file

Create the directory with `fs.mkdirSync(dir, { recursive: true })`, then `fs.writeFileSync(lockPath, JSON.stringify(lockContent))`. A plain write is fine — nobody else writes to that file and Claude Code reads it once at startup. For extra safety, write to a `.tmp` file and `fs.renameSync` — atomic on the same filesystem.

### 3.5 Removing the lock file

On extension deactivate and on process exit, `fs.unlinkSync(lockPath)`. **If the extension crashes or VS Code force-quits, the lock file is left behind.** Claude Code doesn't care — it will ignore a lock file whose `pid` no longer exists. We should still clean up on the happy path via `deactivate()`.

### 3.6 Environment variables (we do NOT need to set these)

claudecode.nvim launches `claude` as a child process from an internal terminal split and injects env vars (`CLAUDE_CODE_SSE_PORT`, `ENABLE_IDE_INTEGRATION`, `FORCE_CODE_TERMINAL`). We don't do that — the user runs `claude` in their own terminal. Claude Code falls back to scanning lock files in `~/.claude/ide/` and picks the one whose workspace matches. That works with zero env setup on our side.

---

## 4. The WebSocket server

claudecode.nvim implements an **entire RFC 6455 WebSocket server in pure Lua** with zero dependencies (~1500 lines). In Node.js we don't need any of that — the `ws` package (the same one VS Code itself uses) handles TCP, HTTP upgrade, framing, masking, UTF-8 validation, fragmentation, and control frames for us. We only re-implement the parts that are **policy** (port selection, auth validation, keepalive).

### 4.1 Port selection

- Range: **10000–65535**.
- Random order, not sequential, so multiple IDEs don't all claim 10000.
- Bind to **`127.0.0.1` only** — never `0.0.0.0`. The auth token alone is not enough to protect against network exposure; binding to loopback is the real guarantee.

Simplest approach in Node: use `server.listen(0, '127.0.0.1', ...)` and let the OS pick a random free port. Read the actual port from `server.address().port`. This skips the range-and-shuffle logic entirely while remaining safe. The only thing we lose is a fixed port range — Claude Code doesn't care because it reads the port from the lock file.

### 4.2 The handshake

Standard RFC 6455 HTTP upgrade. `ws` handles this. The only custom logic we add is an **auth check on the HTTP upgrade request**, before `ws` accepts the connection:

```ts
const httpServer = http.createServer();
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const token = req.headers['x-claude-code-ide-authorization'];
  if (typeof token !== 'string' || !timingSafeEqualString(token, authToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
```

Key bits:

1. **The auth header is custom**, not HTTP `Authorization`. It's named `x-claude-code-ide-authorization` and carries the UUID from the lock file verbatim.
2. **Length bounds are 10–500 chars** per the reference implementation. A UUID v4 is 36 chars so we're comfortable.
3. **Use constant-time comparison** (`crypto.timingSafeEqual`) rather than `===`. We're local-only but it's trivial hygiene.

### 4.3 Frame handling

`ws` handles all of this: FIN bit, opcodes, masking, 16/64-bit extended lengths, UTF-8 validation on TEXT frames, close-frame payload validation, 100 MB payload cap, control frame size limits, PING auto-reply with PONG. We get an `on('message', (data) => ...)` callback with a Buffer. Decode as UTF-8 and parse as JSON.

Be forgiving: treat BINARY frames the same as TEXT for JSON-RPC. Claude Code always sends TEXT but a one-liner fallback doesn't hurt.

---

## 5. JSON-RPC 2.0 protocol

All WebSocket messages are UTF-8 JSON objects conforming to JSON-RPC 2.0. The dispatcher shape:

```ts
function handleMessage(ws: WebSocket, data: string): void {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(data);
  } catch {
    // -32700 parse error, but don't send anything back for parse errors
    return;
  }
  if (typeof req !== 'object' || req.jsonrpc !== '2.0') {
    return;  // -32600 invalid request
  }
  if (req.id !== undefined) {
    handleRequest(ws, req);       // has id → send a response
  } else {
    handleNotification(ws, req);  // no id → fire-and-forget
  }
}
```

Presence of `id` is the **sole** signal for request-vs-notification. Notifications get zero response even on error.

### 5.1 Error codes

| Code     | Meaning                     | When                                          |
|----------|-----------------------------|-----------------------------------------------|
| `-32700` | Parse error                 | Invalid JSON in incoming frame                |
| `-32600` | Invalid Request             | Not JSON-RPC 2.0                              |
| `-32601` | Method not found            | Unknown method or unknown tool name           |
| `-32602` | Invalid params              | Missing required tool argument                |
| `-32603` | Internal error              | Unexpected server-side exception              |
| `-32000` | Tool execution error        | Used by individual tool handlers on failure   |

### 5.2 Registered methods

| Method                      | Direction    | Purpose                                                      |
|-----------------------------|--------------|--------------------------------------------------------------|
| `initialize`                | Claude → us  | MCP handshake. Returns protocol version + capabilities.      |
| `notifications/initialized` | Claude → us  | Ack after initialize. Handler is a no-op (no response).      |
| `prompts/list`              | Claude → us  | Returns `{ prompts: [] }`. **Required** — if we don't handle this, Claude Code logs errors. |
| `tools/list`                | Claude → us  | Returns the schema for every exposed tool.                   |
| `tools/call`                | Claude → us  | Invokes a named tool with arguments.                         |
| `selection_changed`         | us → Claude  | Notification: user changed the selection in the PDF.         |
| `at_mentioned`              | us → Claude  | Notification: user explicitly clicked the "Claude" button.   |

### 5.3 The initialize response

```ts
function initializeResponse() {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      logging: {},                                // must be object, not array
      prompts:   { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      tools:     { listChanged: true },
    },
    serverInfo: {
      name: 'ask-pdf',
      version: '0.1.0',
    },
  };
}
```

Subtleties:

- **`protocolVersion` is `"2024-11-05"`.** This is what Claude Code expects; newer dates exist in the MCP spec but `2024-11-05` is what claudecode.nvim reports and what Claude Code happily accepts.
- **`resources.subscribe = true` is a lie** — we don't implement resource subscriptions. Claude Code doesn't seem to care. Declare the capability, never implement it.
- **Empty objects must be objects, not arrays.** In JavaScript `{}` serializes correctly — we're fine.

### 5.4 Response shape

Tool results all look like this:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "{\"success\":true,\"text\":\"...\",\"filePath\":\"...\",\"page\":3}" }
    ]
  }
}
```

The `content` array is MCP-standard. Each item has a `type` (`"text"`, `"image"`, `"resource"`) and fields appropriate to that type. **Notice the tool payload is a JSON-stringified JSON object inside a text item.** It's not pretty — the payload gets double-encoded — but it's what MCP tool calls expect. Claude Code parses the inner JSON out of the text.

Helper:

```ts
function mcpText(inner: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(inner) }],
  };
}
```

Errors:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": { "code": -32602, "message": "Invalid params", "data": "Missing filePath parameter" }
}
```

---

## 6. The MCP tools ask-pdf needs

claudecode.nvim registers 12 tools. Most are editor-specific (open files, save documents, show diffs) and we don't need them. ask-pdf needs **six** tools, all of which are pure reads from local state — no blocking, no coroutines.

### Tool registry pattern

Each tool is an entry in a table with `name`, `description`, `inputSchema`, and a handler function:

```ts
const tools = {
  getCurrentSelection: {
    description: 'Get the current text selection in the PDF',
    inputSchema: { type: 'object', additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' },
    handler: () => getCurrentSelection(),
  },
  // ...
};
```

`tools/list` walks the table and returns `[{ name, description, inputSchema }]`. `tools/call` looks up by `params.name` and invokes the handler.

### 6.1 `getCurrentSelection` — **required**

Returns the current selection in the active PDF editor, or an empty-selection object if nothing is selected, or `{ success: false, message: "No active PDF editor found" }` if no PDF is open.

Success shape for ask-pdf:

```json
{
  "success": true,
  "text": "the selected text",
  "filePath": "/abs/path/to/doc.pdf",
  "fileUrl": "file:///abs/path/to/doc.pdf",
  "page": 3,
  "selection": {
    "start": { "line": 2, "character": 0 },
    "end":   { "line": 2, "character": 0 },
    "isEmpty": false
  }
}
```

See [section 10](#10-pdf-specific-adaptations) for why we use `line = page - 1` and include `page` as an extra field.

### 6.2 `getLatestSelection` — **required**

Same shape as `getCurrentSelection`, but returns the **last non-empty selection** even if the user has since clicked into their `claude` terminal. This is how Claude Code can answer "explain what I just highlighted" after the user Tab-switches away.

The distinction in implementation:

- `getCurrentSelection` returns the live selection. If the webview no longer has a selection (e.g., user clicked elsewhere), it returns an empty-selection object.
- `getLatestSelection` returns the **last non-empty** selection the extension remembers. If the user hasn't selected anything yet, it returns `{ success: false, message: "No selection available" }`.

We maintain two pieces of state in the extension:
- `currentSelection: Selection | null` — updated on every webview selectionchange, cleared when selection collapses.
- `latestSelection: Selection | null` — updated only on **non-empty** selections. Never cleared.

### 6.3 `getOpenEditors` — **required**

Returns the list of open PDF tabs. For ask-pdf this is usually one entry (the currently open PDF):

```json
{
  "tabs": [
    {
      "uri": "file:///abs/path/to/doc.pdf",
      "isActive": true,
      "isPinned": false,
      "isPreview": false,
      "isDirty": false,
      "label": "doc.pdf",
      "groupIndex": 0,
      "viewColumn": 1,
      "isGroupActive": true,
      "fileName": "/abs/path/to/doc.pdf",
      "languageId": "pdf",
      "lineCount": 42,
      "isUntitled": false,
      "selection": {
        "start": { "line": 2, "character": 0 },
        "end":   { "line": 2, "character": 0 },
        "isReversed": false
      }
    }
  ]
}
```

For us the `languageId` is `"pdf"`, `lineCount` is the total page count of the PDF, `selection` reflects the current selection mapped to page-as-line. Most fields can be hard-coded (`isDirty: false` — we're read-only; `isPinned: false` — we don't track VS Code pinning; `groupIndex: 0`).

We enumerate open PDF tabs via `vscode.window.tabGroups.all` and filter to tabs whose input `uri` ends in `.pdf`.

### 6.4 `getWorkspaceFolders` — **required**

Returns:

```json
{
  "success": true,
  "folders": [
    { "name": "my-papers", "uri": "file:///abs/path", "path": "/abs/path" }
  ],
  "rootPath": "/abs/path"
}
```

Read from `vscode.workspace.workspaceFolders` and format each entry.

### 6.5 `getDiagnostics` — **required (stub)**

PDFs don't produce diagnostics. But we **still must register the tool** because Claude Code may call it as part of context-gathering, and returning "method not found" is noisier than returning an empty array.

Schema:

```json
{
  "name": "getDiagnostics",
  "description": "Get diagnostics from the editor",
  "inputSchema": {
    "type": "object",
    "properties": { "uri": { "type": "string", "description": "Optional file URI" } },
    "additionalProperties": false
  }
}
```

Return value: `mcpText([])` — an empty array wrapped in the MCP content envelope.

### 6.6 `openFile` — **stretch (polish phase)**

Lets Claude Code tell us to navigate to a specific page:

```json
{
  "name": "openFile",
  "description": "Open a PDF and optionally scroll to a specific page",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filePath": { "type": "string" },
      "startLine": { "type": "integer", "description": "Page number to scroll to (1-based)" },
      "endLine":   { "type": "integer" },
      "makeFrontmost": { "type": "boolean", "default": true }
    },
    "required": ["filePath"]
  }
}
```

For us, `startLine` = page number. When Claude calls this tool, we post a `scrollToPage` message to the webview. This lets Claude drive navigation ("jump to page 5") which is a nice UX win but not required for the first shipping version.

### 6.7 Tools we do **not** need

| Tool                    | Why we skip it                                 |
|-------------------------|------------------------------------------------|
| `openDiff`              | Editor-only. Blocks on user accept/reject. We're read-only. |
| `saveDocument`          | We don't write to PDFs.                        |
| `checkDocumentDirty`    | PDFs are never dirty.                          |
| `closeAllDiffTabs`      | Cleanup for `openDiff`.                        |
| `close_tab`             | Internal to Neovim.                            |
| `executeCode`           | Jupyter-only.                                  |

Because we skip `openDiff`, we also skip all the coroutine / deferred-response machinery that exists only to support it. Every ask-pdf tool handler is **synchronous**.

### Summary: ask-pdf tools

| Tool                    | Phase | Notes                                          |
|-------------------------|-------|------------------------------------------------|
| `getCurrentSelection`   | 5     | Core context for Claude Code.                  |
| `getLatestSelection`    | 5     | Persists across focus changes.                 |
| `getOpenEditors`        | 5     | One entry per open PDF tab.                    |
| `getWorkspaceFolders`   | 5     | From `vscode.workspace.workspaceFolders`.      |
| `getDiagnostics`        | 5     | Stub returning `[]`. **Still required.**       |
| `openFile`              | 7     | Polish. Lets Claude drive page navigation.     |

Five tools in the main integration phase, one in polish.

---

## 7. Selection tracking and broadcasting

This is the piece most plans miss. claudecode.nvim doesn't just expose selection on demand via `getCurrentSelection`; it also **proactively pushes** selection updates to Claude Code via `selection_changed` notifications. That way, Claude Code always knows what's highlighted without having to call a tool first.

For ask-pdf this matters because the **typical workflow is**:

1. User selects text in the PDF webview.
2. User Tab-switches to their `claude` terminal.
3. User types "explain this".
4. Claude Code — who's been receiving `selection_changed` notifications all along — already knows what "this" refers to and can reference it directly or call `getCurrentSelection` for more detail.

Without proactive broadcasting, Claude has to guess or the user has to click the "Claude" button first. With broadcasting, it feels like magic.

### 7.1 Debouncing

The webview fires `selectionchange` events on every mouse movement while dragging. Coalesce them with a 100 ms debounce before posting to the extension host. This is already the pattern ask-pdf uses for showing the floating action bar; reuse the same debounced callback.

### 7.2 Selection persistence (the "demotion" pattern)

In Neovim, when the user exits visual mode, the selection disappears. If they're exiting to go ask Claude about it, we want the selection to still be the visual one, not empty. claudecode.nvim solves this with a 50 ms delay: when the selection clears, wait 50 ms before promoting "empty" to the new state. If during those 50 ms the user lands in the Claude terminal, cancel the demotion and keep the previous selection.

In a VS Code webview, the equivalent problem exists: when the user clicks into the `claude` terminal, the webview's `Selection` object remains intact (the DOM selection isn't cleared) — but the webview loses focus. So for the webview's perspective, nothing breaks. The `currentSelection` state is still valid.

**What we actually need** is simpler: maintain `latestSelection` separately from `currentSelection`. `latestSelection` is only written when the selection is **non-empty**. It's never cleared. `getLatestSelection` reads it. This means even after the user collapses the selection (click elsewhere), `getLatestSelection` still returns the last meaningful selection. This gives us all the behavior we need without any visual-mode demotion hack.

### 7.3 Broadcast shape

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "text": "photoreceptor layer",
    "filePath": "/home/me/papers/octopus.pdf",
    "fileUrl": "file:///home/me/papers/octopus.pdf",
    "page": 4,
    "selection": {
      "start": { "line": 3, "character": 0 },
      "end":   { "line": 3, "character": 0 },
      "isEmpty": false
    }
  }
}
```

Notification — no `id`, no response. Sent to **every** connected client (in practice there's just the one Claude Code connection).

### 7.4 at_mentioned

When the user clicks the "Claude" button in the floating action bar, we send an **additional** notification to explicitly surface the selection as an at-mention in Claude Code's conversation:

```json
{
  "jsonrpc": "2.0",
  "method": "at_mentioned",
  "params": {
    "filePath": "/home/me/papers/octopus.pdf",
    "lineStart": 4,
    "lineEnd":   4
  }
}
```

Note: `lineStart` / `lineEnd` are the field names Claude Code expects — for ask-pdf we use page numbers here (1-based) and Claude Code renders them into a reference in the chat. This is the notification that makes Claude Code show `@octopus.pdf:4` in its input.

After broadcasting, we call `vscode.commands.executeCommand('workbench.action.terminal.focus')` so the user's cursor lands in the terminal ready to type their question.

---

## 8. Keepalive, liveness, wake-from-sleep

claudecode.nvim pings every 30 seconds and disconnects clients that haven't pong'd in 60 seconds. There's a very nice touch for laptop use:

> If the ping timer fires more than 45 seconds into a 30-second interval, assume the system was asleep and reset everyone's `last_pong` to "now" instead of immediately declaring them timed out.

Without this, closing a laptop lid for 5 minutes would kill every Claude Code connection even though nothing is actually wrong.

In Node with `ws`, we get ping/pong for free via `ws.ping()` / `ws.on('pong', ...)`. We build the wake-detection ourselves:

```ts
const INTERVAL = 30_000;
let lastTick = Date.now();
const pingTimer = setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTick;
  const wake = elapsed > INTERVAL * 1.5;
  lastTick = now;
  for (const client of clients) {
    if (wake) {
      client.lastPong = now;  // forgive everyone
    } else if (now - client.lastPong > INTERVAL * 2) {
      client.ws.terminate();  // dead
      continue;
    }
    client.ws.ping();
  }
}, INTERVAL);
```

Ship this in the polish phase. It's cheap, small, and prevents a frustrating class of "my Claude integration died after lunch" bugs.

---

## 9. Lifecycle: start, stop, shutdown

### 9.1 Start

Order matters: auth token → server → lock file → selection tracking. If any step fails, tear down everything prior.

```ts
async function start(): Promise<void> {
  authToken = randomUUID();
  port = await startWebSocketServer(authToken);  // binds and listens
  try {
    lockPath = writeLockFile(port, authToken);
  } catch (e) {
    stopWebSocketServer();
    throw e;
  }
  startPingTimer();
}
```

### 9.2 Stop

```ts
function stop(): void {
  stopPingTimer();
  if (lockPath) { removeLockFile(lockPath); }
  for (const client of clients) { client.ws.close(); }
  clients.clear();
  wss?.close();
}
```

### 9.3 Hooking into VS Code extension lifecycle

Call `start()` in `extension.ts`'s `activate()`. Call `stop()` in `deactivate()`. VS Code gives us this contract:

```ts
export function activate(context: vscode.ExtensionContext): void {
  start().catch((err) => console.error('[ask-pdf] Failed to start MCP server', err));
  // ... register editor provider, commands, etc.
}

export function deactivate(): void {
  stop();
}
```

If VS Code force-quits, `deactivate()` may not run. The lock file will be left behind, but Claude Code handles stale lock files gracefully via the `pid` check.

---

## 10. PDF-specific adaptations

This is where ask-pdf diverges from editors that work with text files.

### 10.1 PDFs don't have lines

claudecode.nvim works with text buffers where `{line, character}` positions are LSP-standard. PDFs don't have lines — they have pages with text runs at arbitrary x/y positions. We fake the LSP position schema by:

1. **Using `line` as the 0-indexed page number**, `character` stays 0. A selection on page 4 becomes `start: {line: 3, character: 0}, end: {line: 3, character: 0}`.
2. **Including `page` as an extra 1-indexed field** in the JSON payload so it's unambiguous for Claude Code to interpret. Claude ignores extra fields it doesn't recognize, so this is safe.
3. **`lineCount` in `getOpenEditors` becomes the total page count.**

Proposed response shape for a PDF selection:

```json
{
  "success": true,
  "text": "photoreceptor layer",
  "filePath": "/abs/path/to/doc.pdf",
  "fileUrl": "file:///abs/path/to/doc.pdf",
  "page": 4,
  "selection": {
    "start": { "line": 3, "character": 0 },
    "end":   { "line": 3, "character": 0 },
    "isEmpty": false
  }
}
```

For a selection spanning pages 3–5:

```json
{
  "page": 3,
  "selection": {
    "start": { "line": 2, "character": 0 },
    "end":   { "line": 4, "character": 0 },
    "isEmpty": false
  }
}
```

`page` holds the starting page for convenience; the full range is in `selection.start.line` / `selection.end.line`.

### 10.2 at_mentioned line fields are 1-indexed pages

When broadcasting `at_mentioned`, we use `lineStart` / `lineEnd` with **1-indexed page numbers**:

```json
{ "filePath": "/abs/doc.pdf", "lineStart": 3, "lineEnd": 5 }
```

Claude Code renders this as `@doc.pdf:3-5` in the chat. The user sees a page reference, not a "line" reference, in the context of a PDF — which is exactly what they expect.

### 10.3 The webview is the source of truth

In a text editor, `vscode.window.activeTextEditor.selection` is the authoritative source. For us, the webview owns the selection (it's the one running pdf.js and handling `window.getSelection()`). The extension host mirrors the latest selection state via `webview.onDidReceiveMessage`.

```ts
// In pdfProvider.ts
webviewPanel.webview.onDidReceiveMessage((msg) => {
  if (msg.type === 'selectionUpdate') {
    const sel: PdfSelection = {
      text: msg.text,
      filePath: document.uri.fsPath,
      fileUrl: document.uri.toString(),
      page: msg.startPage,
      startPage: msg.startPage,
      endPage: msg.endPage,
    };
    setCurrentSelection(sel);     // always updates current
    if (msg.text.length > 0) {
      setLatestSelection(sel);    // only updates latest if non-empty
    }
    broadcastSelectionChanged(sel);
  }
});
```

`setCurrentSelection` and `setLatestSelection` live in `claudeServer.ts` as module-level state. The tool handlers read from them. The `broadcastSelectionChanged` call also lives there and sends the notification to connected Claude Code clients.

---

## 11. Implementation priority for ask-pdf

These steps are written so each one is testable and the system works (in degraded form) after every step.

| # | Step                                                                                       | Test after              |
|---|--------------------------------------------------------------------------------------------|-------------------------|
| 1 | Write / remove lock file at `~/.claude/ide/{port}.lock` with correct JSON.                 | Inspect the file.       |
| 2 | Start WebSocket server on `127.0.0.1`, random port, auth check on upgrade.                 | `wscat` handshake.      |
| 3 | JSON-RPC router: `initialize`, `notifications/initialized`, `prompts/list`, `tools/list` (empty), `tools/call` (stub). | `claude /ide` finds us. |
| 4 | Implement `at_mentioned` broadcast on "Claude" button click.                               | Reference appears in terminal. |
| 5 | Implement `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`. | Ask Claude about the current selection; it works. |
| 6 | Implement `selection_changed` proactive broadcasting (debounced 100 ms).                   | Claude reacts to new selections without being asked. |
| 7 | Add ping/pong keepalive with wake-from-sleep detection.                                    | Close laptop lid, reopen, connection still alive. |
| 8 | (Stretch) Implement `openFile` so Claude can tell us to jump to a page.                    | Ask Claude "show me page 5"; we scroll. |

Steps 1–3 are "MCP server foundation". Steps 4–6 are "MCP integration complete". Steps 7–8 are "polish".

**The single biggest lesson** from the claudecode.nvim analysis: do not stop at "tool/call works". The proactive `selection_changed` broadcast (step 6) is what makes the experience feel connected vs. transactional. It's cheap to add and disproportionately improves the UX.

**The second biggest lesson**: Claude Code calls `prompts/list`, `getDiagnostics`, and other tools you don't think matter **as part of its cold-start context gathering**. If any of them return "method not found" or "tool not found", Claude Code logs errors and sometimes gives up. Register stubs for everything listed in section 6, even the ones that return empty.

---

## 12. Protocol reference (exact wire format)

### 12.1 Handshake (Claude Code → us)

```http
GET / HTTP/1.1
Host: 127.0.0.1:12345
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
x-claude-code-ide-authorization: 550e8400-e29b-41d4-a716-446655440000
```

### 12.2 Handshake response (us → Claude Code)

```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

`ws` builds this automatically. We only add the auth check on the upgrade request.

### 12.3 Initialize (Claude Code → us)

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
```

### 12.4 Initialize response (us → Claude Code)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "logging": {},
      "prompts":   { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "tools":     { "listChanged": true }
    },
    "serverInfo": { "name": "ask-pdf", "version": "0.1.0" }
  }
}
```

### 12.5 Initialized notification (Claude Code → us)

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }
```

We return nothing (notifications don't get responses).

### 12.6 prompts/list (Claude Code → us)

```json
{ "jsonrpc": "2.0", "id": 2, "method": "prompts/list", "params": {} }
```

### 12.7 prompts/list response (us → Claude Code)

```json
{ "jsonrpc": "2.0", "id": 2, "result": { "prompts": [] } }
```

Always empty. **Do not omit this handler** — Claude Code calls it on cold start.

### 12.8 tools/list (Claude Code → us)

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {} }
```

### 12.9 tools/list response (us → Claude Code)

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "tools": [
      {
        "name": "getCurrentSelection",
        "description": "Get the current text selection in the PDF",
        "inputSchema": { "type": "object", "additionalProperties": false, "$schema": "http://json-schema.org/draft-07/schema#" }
      },
      {
        "name": "getLatestSelection",
        "description": "Get the most recent text selection (even if not in the active PDF)",
        "inputSchema": { "type": "object", "additionalProperties": false, "$schema": "http://json-schema.org/draft-07/schema#" }
      },
      {
        "name": "getOpenEditors",
        "description": "Get list of currently open PDF tabs",
        "inputSchema": { "type": "object", "additionalProperties": false, "$schema": "http://json-schema.org/draft-07/schema#" }
      },
      {
        "name": "getWorkspaceFolders",
        "description": "Get all workspace folders currently open",
        "inputSchema": { "type": "object", "additionalProperties": false, "$schema": "http://json-schema.org/draft-07/schema#" }
      },
      {
        "name": "getDiagnostics",
        "description": "Get diagnostics from the editor",
        "inputSchema": {
          "type": "object",
          "properties": { "uri": { "type": "string" } },
          "additionalProperties": false,
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      }
    ]
  }
}
```

### 12.10 tools/call (Claude Code → us)

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "getCurrentSelection",
    "arguments": {}
  }
}
```

### 12.11 tools/call response (us → Claude Code)

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"success\":true,\"text\":\"photoreceptor layer\",\"filePath\":\"/home/me/papers/octopus.pdf\",\"fileUrl\":\"file:///home/me/papers/octopus.pdf\",\"page\":4,\"selection\":{\"start\":{\"line\":3,\"character\":0},\"end\":{\"line\":3,\"character\":0},\"isEmpty\":false}}"
      }
    ]
  }
}
```

**The `text` field is a JSON-stringified JSON object.** That's MCP convention, not a bug. Double encoding is how it's supposed to look.

### 12.12 selection_changed notification (us → Claude Code)

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "text": "photoreceptor layer",
    "filePath": "/home/me/papers/octopus.pdf",
    "fileUrl": "file:///home/me/papers/octopus.pdf",
    "page": 4,
    "selection": {
      "start": { "line": 3, "character": 0 },
      "end":   { "line": 3, "character": 0 },
      "isEmpty": false
    }
  }
}
```

No `id` → no response expected.

### 12.13 at_mentioned notification (us → Claude Code)

```json
{
  "jsonrpc": "2.0",
  "method": "at_mentioned",
  "params": {
    "filePath": "/home/me/papers/octopus.pdf",
    "lineStart": 4,
    "lineEnd":   4
  }
}
```

No `id` → no response expected. For ask-pdf, `lineStart` / `lineEnd` are **1-indexed page numbers**.

### 12.14 Error response (us → Claude Code)

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32601,
    "message": "Tool not found: foo"
  }
}
```

### 12.15 Error codes we actually use

| Code     | Meaning                        | When                                          |
|----------|--------------------------------|-----------------------------------------------|
| `-32700` | Parse error                    | Invalid JSON in incoming frame (don't respond) |
| `-32600` | Invalid Request                | Not JSON-RPC 2.0 (don't respond)              |
| `-32601` | Method not found               | Unknown method or unknown tool name           |
| `-32602` | Invalid params                 | Missing required tool argument                |
| `-32603` | Internal error                 | Unexpected server-side exception              |
| `-32000` | Tool execution error           | Individual tool handler threw                 |

---

## Appendix: complete tool schemas

```json
{
  "getCurrentSelection": {
    "type": "object",
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  },
  "getLatestSelection": {
    "type": "object",
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  },
  "getOpenEditors": {
    "type": "object",
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  },
  "getWorkspaceFolders": {
    "type": "object",
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  },
  "getDiagnostics": {
    "type": "object",
    "properties": {
      "uri": {
        "type": "string",
        "description": "Optional file URI to get diagnostics for. If not provided, gets diagnostics for all open files."
      }
    },
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  },
  "openFile": {
    "type": "object",
    "properties": {
      "filePath": { "type": "string" },
      "startLine": { "type": "integer", "description": "Page number (1-based) to scroll to" },
      "endLine":   { "type": "integer" },
      "makeFrontmost": { "type": "boolean", "default": true }
    },
    "required": ["filePath"],
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  }
}
```

Including `$schema` is optional but claudecode.nvim does it and Claude Code accepts it. Safer to include than omit.
