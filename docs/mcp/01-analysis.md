# bm.ftp MCP: requirements and repository analysis

Date: 17 October 2026. Status: baseline analysis; implementation has since begun.

## Goal

Let Codex and other supported agents explore FTP content available after signing in to `bm.ftp`, read selected files, identify issues, and suggest fixes. The agent must not modify files on the FTP server.

A later extension may recursively download selected items to a chosen local workspace, but only after the user explicitly approves it and the FTP account has the required permissions. Signing in to FTP does not by itself authorize sharing its content with an agent or writing to the workspace.

## Requirements and boundaries

- List directories, search by name, and read bounded text files.
- The connected agent analyzes the requested content and proposes fixes.
- FTP credentials stay in VS Code `SecretStorage`; they must not be MCP tool arguments or appear in tool results.
- MCP code, contracts, adapters, and their tests belong in the repository's top-level `mcp/` folder; documentation belongs in `docs/mcp/`.
- FTP uploads, deletion, and remote edits are out of scope.
- Workspace downloads are a separate phase with a preview, explicit approval, and destination path restrictions.
- Reading sends file contents to the selected model/agent; sensitive files and untrusted content must be handled carefully.

## Verified repository state

| Area | Finding from source inspection | Implementation impact |
| --- | --- | --- |
| Extension entry point | `src/extension.ts` registers the Commander and status bar. | Assemble the session service and bridge lifecycle here. |
| FTP session | `src/commanderPanel.ts` owns the `Client`, profile, connection state, and `OperationQueue`; the MCP bridge delegates back to that panel. | UI and MCP FTP operations use the same client and queue. A standalone session service remains a possible refactor, not a prerequisite. |
| Lifecycle | Closing the webview calls `shutdown()` and closes the FTP client. | Closing the panel revokes MCP access. |
| Password | `context.secrets.get/store`; `getPasswordKey()` in `src/core.ts` builds the key. The profile without its password is in `globalState`. | Retain `SecretStorage`; never send the password to the agent. Signing in is not consent to agent access. |
| Concurrency | UI, read-only document, and MCP FTP operations use the panel's queue. | Keep all new FTP operations on this queue. |
| File reads | Existing read-only document opening still buffers its full file. MCP reads reject reported files over 1 MiB, keep at most 1 MiB in memory, and reject binary or invalid UTF-8 data. | The MCP reader has bounded output memory; transfer cancellation and a strict network-byte cap remain to validate. |
| Copy operations | Recursive scanning, conflict prompts, staging files, atomic rename, and size comparison already exist. | Reuse only appropriate primitives. `copyItems()` is tied to pane paths and also supports uploads, so MCP must not call it as a general operation. |
| Transfer verification | Downloads compare expected and received sizes. | Equal size does not prove identical content; describe exactly what was checked. |
| Tests | `test/core.test.cjs`, `test/commanderPanel.test.cjs`, and `test/selection.test.cjs` use Node's test runner and a fake FTP client. | Extend the current test style for contracts, grants, and isolation. |
| Compatibility | The extension minimum is now `^1.102.0`; `@types/vscode` is 1.140.0. | Test the actual minimum editor; newer type definitions do not prove runtime compatibility. |
| Build/package | The MCP server is an ESM `.mjs` file under `mcp/`; the extension launches it with the editor's Node runtime. | Verify its inclusion in a VSIX and test paths containing spaces. |

This baseline analysis did not contact a live FTP server. Implementation and test status are maintained in the solution design. Existing worktree changes were preserved.

## Assumptions

- Initial support targets desktop VS Code and a local Codex/agent running as the same OS user.
- Agent access is an explicit action separate from ordinary FTP login.
- Bounded UTF-8 text reading is sufficient for the MVP; binary and oversized files are rejected.
- This analysis inspected source and documentation only; it did not connect to a live FTP server or run a build or tests.

See the [feasibility study](02-feasibility.md) and the [solution design and implementation plan](03-solution-design.md).
