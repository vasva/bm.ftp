# bm.ftp MCP: feasibility study

Date: 17 October 2026. Status: feasibility findings by Sol (`gpt-6.1-sol`); an initial VS Code provider implementation has since begun.

## Conclusion

The MCP integration is feasible. The first phase should expose only directory listing, filename search, and bounded reads of text files. The connected agent can then identify issues and suggest fixes. The extension will not include its own model or require an OpenAI API key.

A later phase can add recursive FTP-to-workspace downloads. Each download must be approved in the extension UI before any local write, and the FTP account must have read permission. Uploads, remote edits, and deletion are outside this plan.

To reuse the already-authenticated FTP session, separate the MCP adapter from the FTP client and connect it to the extension host through a narrow authenticated local IPC bridge. The standalone MCP process must not receive the FTP password.

## Client support and compatibility

VS Code extensions can publish MCP server definitions through `contributes.mcpServerDefinitionProviders` and `vscode.lm.registerMcpServerDefinitionProvider`. VS Code supports both STDIO and Streamable HTTP definitions. Definition discovery must not trigger interactive authentication; that belongs in the later resolve/start step. [Official VS Code MCP guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)

The provider API is present in the public VS Code 1.101.0 types and absent from 1.100.0. MCP support became generally available in VS Code 1.102. For automatic provider registration, raise the extension minimum to `^1.102.0` and test that version. Do not assume examples using current constructors work on older runtimes; the build types must match the actual minimum. [VS Code 1.101.0 types](https://raw.githubusercontent.com/microsoft/vscode/1.101.0/src/vscode-dts/vscode.d.ts), [VS Code 1.100.0 types](https://raw.githubusercontent.com/microsoft/vscode/1.100.0/src/vscode-dts/vscode.d.ts), [VS Code 1.102 release](https://code.visualstudio.com/updates/v1_102)

Codex supports STDIO and Streamable HTTP and stores its configuration in `~/.codex/config.toml`, or in a trusted project's `.codex/config.toml`. Its local clients share that configuration. A VS Code provider registration is therefore not a documented way to register a server with Codex; the current implementation provides a separate Codex configuration snippet. OpenAI documents both `codex mcp add` and adding a server in the IDE, with the IDE flow requiring an extension restart after adding it. [Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### Open problem: automatic Codex initialization

Users should not have to find the Codex configuration file, paste TOML, or restart Codex for routine FTP sessions. The current opt-in setup still requires that manual registration and an initial Codex MCP reload. Automatic detection and registration when Codex is installed, and refreshing an already-running Codex conversation through a supported public API, are unresolved. The extension must not attempt Codex setup at startup while this remains open. After a server is registered, the current launcher does discover and revoke FTP grants dynamically without restarting Codex for each session.

| Integration | Clients | Proposed approach |
| --- | --- | --- |
| VS Code provider | VS Code's built-in MCP client and agents that use it | Provider starts the packaged STDIO server with the exact bridge ID for that window. |
| Codex configuration | Codex IDE/CLI and other local clients sharing the same Codex host | An explicit command copies a user-level config block pointing to a stable launcher under VS Code global storage. Registration automation remains an open problem. The launcher reads a private per-grant registry and attaches only to exactly one live bridge. |
| Other MCP agents | Depends on the specific client | Register the same STDIO server separately; verify compatibility with each client. |

The initial supported topology is desktop VS Code and a local agent running under the same OS user on the same computer. Codex Cloud cannot access a local socket. Remote SSH, WSL, Dev Containers, and multiple OS users need a separate design for process placement, sockets, and data; do not assume `localhost` or a filesystem path refers to the same machine. Reject these topologies clearly in the first phase.

## Feasibility by capability

| Capability | Result | Condition or limitation |
| --- | --- | --- |
| Codex reads the already-connected FTP session | Feasible | Local MCP STDIO process with an authenticated IPC bridge to the extension host. |
| Agent lists and searches items | Feasible | Grant scoped to a root, bounded depth and output, and one shared FTP queue. |
| Agent reads files and suggests fixes | Feasible | Bounded text files; their contents become part of the agent's context. |
| Recursive download to workspace | Feasible as phase two | One-time plan, user approval, safe destination validation, and conflict handling. |
| Agent edits or deletes FTP files | Out of scope | The MCP API will not expose these operations. |
| Codex Cloud uses the local FTP session | Not in the current topology | A local socket is unavailable to a remote cloud agent. |
| Remote VS Code (SSH/WSL/container) | Unverified | Requires another design for process placement, sockets, and data. |

## Remaining validation

The prototype now uses the official `@modelcontextprotocol/server` 2.3.1 package (Node.js 20+) and the VS Code provider API with a private local socket or named pipe. The external Codex launcher and private registry are implemented for macOS/Linux. Still verify the SDK/Node runtime in an installed VSIX, the minimum VS Code version, Windows named-pipe and registry ACLs, and actual Codex clients. Local source builds alone cannot confirm these behaviors.

Detailed architecture, security model, tool contracts, test matrix, and delivery phases are in the [solution design](03-solution-design.md). Requirements and source-code findings are in the [analysis](01-analysis.md).
