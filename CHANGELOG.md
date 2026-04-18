# Changelog

## 0.0.0 - 2026-04-18

Initial release.

### Added

- Custom editor (`askPdf.preview`) that renders `.pdf` files in a VS Code webview via pdf.js.
- **Ask PDF: Open PDF Preview** command and editor-title button for opening the current PDF in the custom editor.
- Floating action bar with an **Ask Claude** button for the current text selection, plus zoom controls and page mapping for multi-page selections.
- Local WebSocket MCP server that writes a lock file to `~/.claude/ide/` (or `$CLAUDE_CONFIG_DIR/ide/`) so the `claude` CLI can discover the editor.
- MCP tools: `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`.
- `ask-pdf.showFloatingButton` setting to toggle the floating action bar.
- Extension icon and packaging metadata.
- Regenerated extension icon (`media/icon.png`) from the source SVG at 128×128.
- Project `README.md` describing features, layout, build, usage, and configuration.
