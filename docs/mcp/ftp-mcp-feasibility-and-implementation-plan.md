# bm.ftp MCP documentation

The documents separate the requirements analysis, feasibility findings, and technical design. The read-only implementation and its current manual Codex setup path are documented; automatic Codex initialization remains an open problem.

1. [Requirements and repository analysis](01-analysis.md) — goals, boundaries, and current `bm.ftp` architecture.
2. [Feasibility study](02-feasibility.md) — verified VS Code/Codex capabilities, compatibility, and limitations.
3. [Solution design and implementation plan](03-solution-design.md) — architecture, security, MCP tools, phases, and test cases.

The implementation targets the VS Code MCP provider and supports read-only FTP browsing and bounded text-file reading. Direct Codex CLI/IDE registration currently requires manual setup; automatic registration and refreshing an already-running Codex conversation are open problems. Approved workspace downloads remain separate follow-up work. MCP server code belongs in the repository's top-level `mcp/` folder; the extension-host bridge currently lives in `src/` to reuse the existing FTP session.
