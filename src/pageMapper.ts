import * as vscode from 'vscode';
import * as path from 'path';

export function formatPageRef(
  filePath: string,
  startPage: number,
  endPage: number
): string {
  const relative = vscode.workspace.asRelativePath(filePath, false);
  const display = relative || path.basename(filePath);
  const lo = Math.min(startPage, endPage);
  const hi = Math.max(startPage, endPage);
  const suffix = lo === hi ? `page${lo}` : `page${lo}-${hi}`;
  return `@${display}:${suffix}`;
}
