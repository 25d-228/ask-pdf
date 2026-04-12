import * as vscode from 'vscode';
import { startServer, stopServer } from './claudeServer';
import { AskPdfEditorProvider } from './pdfProvider';

function getActiveTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('[ask-pdf] activated');

  startServer()
    .then((port) => console.log('[ask-pdf] Claude server ready on port', port))
    .catch((err) => console.error('[ask-pdf] Failed to start Claude server:', err));

  context.subscriptions.push(AskPdfEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('ask-pdf.openPreview', async () => {
      const uri = getActiveTabUri();
      if (!uri) {
        vscode.window.showWarningMessage('Ask PDF: no active file to open.');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        AskPdfEditorProvider.viewType
      );
    })
  );
}

export function deactivate(): void {
  stopServer();
}
