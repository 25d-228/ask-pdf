import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { broadcast, clearCurrentSelection, isConnected, setCurrentSelection } from './claudeServer';

class PdfDocument implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly data: Uint8Array
  ) {}

  dispose(): void {}
}

export class AskPdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  public static readonly viewType = 'askPdf.preview';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new AskPdfEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      AskPdfEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
    const data = await vscode.workspace.fs.readFile(uri);
    return new PdfDocument(uri, data);
  }

  async resolveCustomEditor(
    document: PdfDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs'),
      ],
    };

    webview.html = this.buildHtml(webview);

    const postPdfData = (): void => {
      const base64 = Buffer.from(document.data).toString('base64');
      webview.postMessage({ type: 'pdfData', data: base64 });
    };

    const postShowFloatingButton = (): void => {
      const enabled = vscode.workspace
        .getConfiguration('ask-pdf')
        .get<boolean>('showFloatingButton', true);
      webview.postMessage({ type: 'updateShowFloatingButton', enabled });
    };

    const messageListener = webview.onDidReceiveMessage((msg) => {
      if (!msg || typeof msg !== 'object') {
        return;
      }
      if (msg.type === 'ready') {
        postPdfData();
        postShowFloatingButton();
        return;
      }
      if (msg.type === 'askClaude') {
        const startPage = Number(msg.startPage);
        const endPage = Number(msg.endPage);
        if (!isConnected()) {
          vscode.window.showWarningMessage(
            'Ask PDF: No Claude CLI connected. Run "claude" in a terminal first.'
          );
          return;
        }
        broadcast('at_mentioned', {
          filePath: document.uri.fsPath,
          lineStart: startPage,
          lineEnd: endPage,
        });
        vscode.commands.executeCommand('workbench.action.terminal.focus');
        return;
      }
      if (msg.type === 'selectionUpdate') {
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (text.length === 0) {
          clearCurrentSelection();
        } else {
          setCurrentSelection({
            text,
            filePath: document.uri.fsPath,
            fileUrl: document.uri.toString(),
            startPage: Number(msg.startPage),
            endPage: Number(msg.endPage),
            totalPages: Number(msg.totalPages),
          });
        }
        return;
      }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ask-pdf.showFloatingButton')) {
        postShowFloatingButton();
      }
    });

    webviewPanel.onDidDispose(() => {
      messageListener.dispose();
      configListener.dispose();
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const pdfjsRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdfjs');

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.js'));
    const pdfjsLibUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'pdf.min.mjs'));
    const pdfjsWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(pdfjsRoot, 'pdf.worker.min.mjs'));

    const cspSource = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} data: blob:`,
      `style-src ${cspSource} 'unsafe-inline'`,
      `font-src ${cspSource} data:`,
      `script-src 'nonce-${nonce}' ${cspSource}`,
      `worker-src ${cspSource} blob:`,
      `connect-src ${cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Ask PDF</title>
  </head>
  <body>
    <div id="pdf-container">
      <div id="loading" class="loading">Loading PDF…</div>
    </div>
    <script nonce="${nonce}">
      window.__pdfjsLibUrl = ${JSON.stringify(pdfjsLibUri.toString())};
      window.__pdfjsWorkerUrl = ${JSON.stringify(pdfjsWorkerUri.toString())};
    </script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
