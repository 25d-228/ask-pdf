# ask-pdf

Render PDFs inside a VS Code webview and send selected passages to Claude Code.

`ask-pdf` registers a custom editor for `.pdf` files that opens them with
[pdf.js](https://mozilla.github.io/pdf.js/) and adds a floating action bar for
the current text selection. Selected text is shared with a running `claude`
CLI over a local WebSocket server using the same IDE protocol as the official
Claude Code VS Code extension.

## Features

- Custom editor (`askPdf.preview`) that renders any `.pdf` in a VS Code tab.
- Text selection across pages with a floating **Ask Claude** button.
- Local WebSocket MCP server that advertises itself to the `claude` CLI via a
  lock file in `~/.claude/ide/` (or `$CLAUDE_CONFIG_DIR/ide/`).
- MCP tools exposed to Claude: `getCurrentSelection`, `getLatestSelection`,
  `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`.

## Layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Activation entry point; registers the custom editor and command. |
| `src/pdfProvider.ts` | `CustomReadonlyEditorProvider` that builds the webview and wires messages. |
| `src/claudeServer.ts` | Local WebSocket / MCP server and selection state. |
| `src/pageMapper.ts` | Helpers for mapping text selections to page ranges. |
| `media/preview.js` | Webview-side pdf.js renderer, selection tracking, floating bar. |
| `media/preview.css` | Webview styles. |
| `media/icon.{svg,png}` | Extension icon. |
| `esbuild.js` | Bundles `src/extension.ts` to `dist/extension.js` and copies pdf.js assets to `dist/pdfjs/`. |
| `docs/` | Development plan and PDF extraction research notes. |
| `example.pdf` | Sample file for manual testing. |

## Requirements

- VS Code `^1.85.0`
- Node `>=20.11.0` (see `.nvmrc`)
- The `claude` CLI on your `PATH` if you want to send selections to Claude Code.

## Build

```sh
npm install
npm run compile     # type-check, lint, bundle
npm run watch       # rebuild on change (esbuild + tsc in parallel)
npm run package     # production bundle
```

Packaging an installable VSIX uses `@vscode/vsce`:

```sh
npx vsce package
```

## Usage

1. Open a `.pdf` file in VS Code.
2. If another editor grabs it first, run **Ask PDF: Open PDF Preview** from the
   command palette or click the preview icon in the editor title bar.
3. Start `claude` in an integrated terminal so the extension can find it via
   the lock file.
4. Select text in the PDF and click the floating **Ask Claude** button — the
   selection and page range are sent to Claude as an `at_mentioned` event and
   focus moves to the terminal.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `ask-pdf.showFloatingButton` | `true` | Show the floating action bar when text is selected. |

## License

MIT — see `LICENSE`.
