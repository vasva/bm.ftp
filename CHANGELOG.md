# Changelog

## 0.1.3

- Fixed Windows activation failing with a `Bad Image` error caused by a macOS native SSH binary in the extension package.
- Excluded platform-specific native Node.js modules from the VSIX. SFTP uses `ssh2`'s JavaScript implementation on both Windows and macOS.
