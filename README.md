# bm.ftp

`bm.ftp` is a VS Code extension project for browsing local and FTP/FTPS folders in a dual-pane file manager inspired by Norton Commander. Its interface is built with Angular and runs in a VS Code webview. FTP credentials are stored with VS Code SecretStorage.

## Current scope

- Browse a local folder and a remote FTP/FTPS folder side by side.
- Connect with FTP or explicit FTPS.
- Navigate folders and transfer a selected file with **F5**.
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
