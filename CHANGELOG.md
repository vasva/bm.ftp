# Changelog

## 0.1.4 — 2026-11-11

### Added

- MCP access for local and remote panels, controlled by a visible grant/revoke toggle.
- Directory listing and name-based selection for both panels, plus local content search, panel navigation, and bounded text reads.
- Offline MCP activation with authorization for FTP root `/` on a server connected later.

### Scope

- MCP can list, search, navigate, select, and read. It cannot write, delete, upload, or download files.
- MCP reads and content searches may send file text to the selected AI model.

## 0.1.3

- Fixed Windows activation failing with a `Bad Image` error caused by a macOS native SSH binary in the extension package.
- Excluded platform-specific native Node.js modules from the VSIX. SFTP uses `ssh2`'s JavaScript implementation on both Windows and macOS.
