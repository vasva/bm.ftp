# bm.ftp

Projects page: [WESTBOHEMIA.COM](https://www.westbohemia.com/developer/en/index.html).

![bm.ftp FTP Commander in Visual Studio Code, with sensitive server and file names blurred](https://www.westbohemia.com/developer/bm.ftp.commander/assets/ftp-commander-overview.png)

`bm.ftp` is a VS Code extension project for browsing local and FTP/FTPS/SFTP folders in a dual-pane file manager inspired by Norton Commander. Its interface is built with Angular and runs in a VS Code webview. Server passwords and trusted SFTP host keys are stored with VS Code SecretStorage.

## Current scope

- Browse a local folder and a remote server folder side by side.
- Connect with FTP, explicit FTPS, or SFTP over SSH.
- Navigate folders and transfer selected files or folder trees recursively between panels.
- Ask before replacing an existing destination file.

The first version focuses on browsing and transfer. Directly editing a remote file and synchronizing its save back to the server can be added as a separate feature.

## Connection profiles and controls

The Commander header places the product name and saved-connection picker on the first row, with the connection form on the second. Saved connections open in a popup list; each entry shows its username, host, port, and protocol and has its own delete button. Deleting an entry opens an in-app confirmation dialog and removes that profile's saved password too. The protocol picker is also a popup, with FTP, FTPS, and SFTP choices.

Connection profiles are stored separately from passwords. After a successful connection, the password is saved in VS Code SecretStorage and reused for that profile on later connections. The password field is cleared when a saved profile is selected; the extension retrieves the matching secret when connecting. Failed connections do not save passwords. While connected, the server, port, username, password, and protocol controls are disabled.

## SFTP connections

Choose **SFTP (SSH)** in the connection protocol selector. SFTP defaults to port 22; a custom port is preserved when switching protocols. On first connection, review the SSH key algorithm and SHA256 fingerprint and choose **Trust key and connect**. The accepted key is stored in VS Code SecretStorage for that host and port. If the key later changes, the connection stops until you verify the change and explicitly choose **Replace trusted key and connect**; cancelling keeps the saved key.

Focused checks: `npm run compile:extension`, `node --test test/sftpHostKeys.test.cjs test/sftpProtocolIntegration.test.cjs`, and `npm run test:e2e -- --grep SFTP`.

## License

The project is free and open source under the MIT License.

## AI agent access

After connecting to a remote server, run **bm.ftp: Grant read-only access to AI agents** from the Command Palette and confirm the requested remote root. VS Code can then start the bundled `bm.ftp` MCP server for its integrated agents. The server can list folders, search names, and read bounded UTF-8 text files under that root. Server credentials are not exposed to the MCP process.

### Open problem: automatic Codex MCP setup

Direct Codex MCP use currently requires manual setup on macOS or Linux: run **bm.ftp: Copy Codex MCP configuration**, add the copied block to `~/.codex/config.toml`, then reload Codex MCP servers once. The command does not edit Codex configuration. After registration, later FTP grants are discovered dynamically and do not require another Codex restart. Automatic Codex detection and registration, plus refreshing an already-running Codex conversation without a restart, remain open problems. The extension does not initialize or update the Codex runtime during startup. Windows ACL validation is also pending, so direct Codex registration is unavailable there.

The runtime token stays in a private directory under VS Code global storage and is removed when access is revoked, the FTP session ends, or the Commander closes. The launcher attaches only when exactly one granted FTP session is active.

Use **bm.ftp: Revoke AI agent access** to end the grant; disconnecting or closing the Commander also revokes it.

The current MCP implementation does not write to FTP or download files to the workspace. See [the MCP design and implementation plan](docs/mcp/03-solution-design.md) for limits, security boundaries, Codex setup, and planned download support.
