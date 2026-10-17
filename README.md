# bm.ftp

`bm.ftp` is a VS Code extension project for browsing local and FTP/FTPS folders in a dual-pane file manager inspired by Norton Commander. Its interface is built with Angular and runs in a VS Code webview. FTP credentials are stored with VS Code SecretStorage.

## Current scope

- Browse a local folder and a remote FTP/FTPS folder side by side.
- Connect with FTP or explicit FTPS.
- Navigate folders and transfer selected files or folder trees recursively between panels.
- Ask before replacing an existing destination file.

The first version focuses on browsing and transfer. Directly editing a remote file and synchronizing its save back to the server can be added as a separate feature.

## Development

Requirements: Node.js 24.0 or later and npm.

```sh
npm install
npm run build
```

Open this folder in VS Code and press **F5** to launch an Extension Development Host. In the new window, run **bm.ftp: Open FTP Commander** from the Command Palette.

The extension's `publisher` value is currently `local`; set it to the Marketplace publisher ID before publishing. The repository is public, but no reuse license has been selected yet.

## AI agent access

After connecting to an FTP server, run **bm.ftp: Grant read-only access to AI agents** from the Command Palette and confirm the requested remote root. VS Code can then start the bundled `bm.ftp` MCP server for its integrated agents. The server can list folders, search names, and read bounded UTF-8 text files under that root. FTP credentials are not exposed to the MCP process.

### Open problem: automatic Codex MCP setup

Direct Codex MCP use currently requires manual setup on macOS or Linux: run **bm.ftp: Copy Codex MCP configuration**, add the copied block to `~/.codex/config.toml`, then reload Codex MCP servers once. The command does not edit Codex configuration. After registration, later FTP grants are discovered dynamically and do not require another Codex restart. Automatic Codex detection and registration, plus refreshing an already-running Codex conversation without a restart, remain open problems. The extension does not initialize or update the Codex runtime during startup. Windows ACL validation is also pending, so direct Codex registration is unavailable there.

The runtime token stays in a private directory under VS Code global storage and is removed when access is revoked, the FTP session ends, or the Commander closes. The launcher attaches only when exactly one granted FTP session is active.

Use **bm.ftp: Revoke AI agent access** to end the grant; disconnecting or closing the Commander also revokes it.

The current MCP implementation does not write to FTP or download files to the workspace. See [the MCP design and implementation plan](docs/mcp/03-solution-design.md) for limits, security boundaries, Codex setup, and planned download support.
