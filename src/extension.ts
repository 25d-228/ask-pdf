import * as vscode from 'vscode';
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

export function deactivate(): void {}
