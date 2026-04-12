import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WebSocket, WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let authToken: string | null = null;
let serverPort: number | null = null;
let httpServer: http.Server | null = null;
let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

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
      return { value: { tools: [] } };
    case 'tools/call':
      return {
        error: { code: -32601, message: 'Tool not found' },
      };
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
