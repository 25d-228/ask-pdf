import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Selection data model
// ---------------------------------------------------------------------------

export interface PdfSelection {
  text: string;
  filePath: string;
  fileUrl: string;
  startPage: number;
  endPage: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let authToken: string | null = null;
let serverPort: number | null = null;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

let currentSelection: PdfSelection | null = null;
let latestSelection: PdfSelection | null = null;

// ---------------------------------------------------------------------------
// Lock file helpers
// ---------------------------------------------------------------------------

function lockDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && configDir.length > 0) {
    return path.join(configDir, 'ide');
  }
  return path.join(os.homedir(), '.claude', 'ide');
}

function lockFilePath(port: number): string {
  return path.join(lockDir(), `${port}.lock`);
}

function writeLockFile(port: number, token: string): void {
  const dir = lockDir();
  fs.mkdirSync(dir, { recursive: true });

  const folders = vscode.workspace.workspaceFolders;
  const workspaceFolders = folders
    ? folders.map((f) => f.uri.fsPath)
    : [];

  const data = {
    pid: process.pid,
    workspaceFolders,
    ideName: 'Ask PDF',
    transport: 'ws',
    authToken: token,
  };

  fs.writeFileSync(lockFilePath(port), JSON.stringify(data, null, 2));
}

function removeLockFile(port: number): void {
  try {
    fs.unlinkSync(lockFilePath(port));
  } catch {
    // already gone — fine
  }
}

// ---------------------------------------------------------------------------
// Selection state management
// ---------------------------------------------------------------------------

export function setCurrentSelection(sel: PdfSelection): void {
  currentSelection = sel;
  if (sel.text.length > 0) {
    latestSelection = sel;
  }
  broadcastSelectionChanged(sel);
}

export function clearCurrentSelection(): void {
  currentSelection = null;
}

function selectionToPayload(sel: PdfSelection): unknown {
  return {
    success: true,
    text: sel.text,
    filePath: sel.filePath,
    fileUrl: sel.fileUrl,
    page: sel.startPage,
    selection: {
      start: { line: sel.startPage - 1, character: 0 },
      end: { line: sel.endPage - 1, character: 0 },
      isEmpty: sel.text.length === 0,
    },
  };
}

function broadcastSelectionChanged(sel: PdfSelection): void {
  if (clients.size === 0) {
    return;
  }
  broadcast('selection_changed', selectionToPayload(sel));
}

// ---------------------------------------------------------------------------
// MCP tool helpers
// ---------------------------------------------------------------------------

function mcpText(inner: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(inner) }],
  };
}

const TOOL_SCHEMA = 'http://json-schema.org/draft-07/schema#';

const TOOL_DEFINITIONS = [
  {
    name: 'getCurrentSelection',
    description: 'Get the current text selection in the active PDF editor',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      $schema: TOOL_SCHEMA,
    },
  },
  {
    name: 'getLatestSelection',
    description: 'Get the most recent non-empty text selection from any PDF editor',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      $schema: TOOL_SCHEMA,
    },
  },
  {
    name: 'getOpenEditors',
    description: 'Get a list of all open PDF editor tabs',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      $schema: TOOL_SCHEMA,
    },
  },
  {
    name: 'getWorkspaceFolders',
    description: 'Get the workspace folders open in VS Code',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      $schema: TOOL_SCHEMA,
    },
  },
  {
    name: 'getDiagnostics',
    description: 'Get diagnostics for a file',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
      },
      additionalProperties: false,
      $schema: TOOL_SCHEMA,
    },
  },
];

// ---------------------------------------------------------------------------
// MCP tool handlers
// ---------------------------------------------------------------------------

function handleGetCurrentSelection(): unknown {
  if (!currentSelection) {
    return mcpText({ success: false, message: 'No active PDF editor found' });
  }
  return mcpText(selectionToPayload(currentSelection));
}

function handleGetLatestSelection(): unknown {
  if (!latestSelection) {
    return mcpText({ success: false, message: 'No selection available' });
  }
  return mcpText(selectionToPayload(latestSelection));
}

function handleGetOpenEditors(): unknown {
  const tabs: unknown[] = [];
  for (const [groupIndex, group] of vscode.window.tabGroups.all.entries()) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputCustom)) {
        continue;
      }
      if (!input.uri.fsPath.endsWith('.pdf')) {
        continue;
      }
      const isActiveTab = tab.isActive && group.isActive;
      const sel = isActiveTab && currentSelection
        ? {
            start: { line: currentSelection.startPage - 1, character: 0 },
            end: { line: currentSelection.endPage - 1, character: 0 },
            isReversed: false,
          }
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isReversed: false };

      tabs.push({
        uri: input.uri.toString(),
        isActive: tab.isActive,
        isPinned: false,
        isPreview: tab.isPreview,
        isDirty: false,
        label: tab.label,
        groupIndex,
        viewColumn: group.viewColumn,
        isGroupActive: group.isActive,
        fileName: input.uri.fsPath,
        languageId: 'pdf',
        lineCount: isActiveTab && currentSelection ? currentSelection.totalPages : 0,
        isUntitled: false,
        selection: sel,
      });
    }
  }
  return mcpText({ tabs });
}

function handleGetWorkspaceFolders(): unknown {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return mcpText({ success: true, folders: [], rootPath: undefined });
  }
  return mcpText({
    success: true,
    folders: folders.map((f) => ({
      name: f.name,
      uri: f.uri.toString(),
      path: f.uri.fsPath,
    })),
    rootPath: folders[0].uri.fsPath,
  });
}

function handleGetDiagnostics(): unknown {
  return mcpText([]);
}

function handleToolCall(params: { name?: string }): DispatchResult {
  switch (params.name) {
    case 'getCurrentSelection':
      return { value: handleGetCurrentSelection() };
    case 'getLatestSelection':
      return { value: handleGetLatestSelection() };
    case 'getOpenEditors':
      return { value: handleGetOpenEditors() };
    case 'getWorkspaceFolders':
      return { value: handleGetWorkspaceFolders() };
    case 'getDiagnostics':
      return { value: handleGetDiagnostics() };
    default:
      return { error: { code: -32601, message: `Tool not found: ${params.name}` } };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatcher
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

type DispatchResult =
  | { value: unknown }
  | { error: { code: number; message: string } };

function dispatch(req: JsonRpcRequest): DispatchResult {
  switch (req.method) {
    case 'initialize':
      return { value: handleInitialize() };
    case 'notifications/initialized':
      return { value: undefined };
    case 'prompts/list':
      return { value: { prompts: [] } };
    case 'tools/list':
      return { value: { tools: TOOL_DEFINITIONS } };
    case 'tools/call':
      return handleToolCall(req.params as { name?: string });
    default:
      return {
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

function handleInitialize(): unknown {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      logging: {},
      prompts: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      tools: { listChanged: true },
    },
    serverInfo: {
      name: 'ask-pdf',
      version: '0.1.0',
    },
  };
}

function handleMessage(ws: WebSocket, raw: string): void {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof req !== 'object' || req.jsonrpc !== '2.0') {
    return;
  }
  const isRequest = req.id !== undefined;
  const result = dispatch(req);
  if (!isRequest) {
    return;
  }
  if ('error' in result) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: result.error }));
  } else {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: result.value }));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function broadcast(method: string, params: unknown): void {
  if (clients.size === 0) {
    return;
  }
  const frame = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
  });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
    }
  }
}

export function isConnected(): boolean {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      return true;
    }
  }
  return false;
}

export async function startServer(): Promise<number> {
  authToken = crypto.randomUUID();

  httpServer = http.createServer();
  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const token = req.headers['x-claude-code-ide-authorization'];
    const valid =
      typeof token === 'string' &&
      token.length >= 10 &&
      token.length <= 500 &&
      Buffer.byteLength(token) === Buffer.byteLength(authToken!) &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(authToken!));
    if (!valid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (data) => {
      handleMessage(ws, String(data));
    });
    ws.on('close', () => {
      clients.delete(ws);
    });
    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  return new Promise<number>((resolve, reject) => {
    httpServer!.listen(0, '127.0.0.1', () => {
      const addr = httpServer!.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      serverPort = addr.port;
      writeLockFile(serverPort, authToken!);
      resolve(serverPort);
    });
    httpServer!.on('error', reject);
  });
}

export function stopServer(): void {
  if (serverPort !== null) {
    removeLockFile(serverPort);
  }
  for (const ws of clients) {
    ws.close();
  }
  clients.clear();
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  authToken = null;
  serverPort = null;
}
