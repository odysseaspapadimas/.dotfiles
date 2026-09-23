# Local Pi MCP package

Vendored from dmmulroy/pi-mcp at acd1428863dd6ce8ee30371b30f0958e8fb8fbe2 (MIT). Source: https://github.com/dmmulroy/pi-mcp

Local changes: src/index.ts hides the footer when disconnected and renders a dim `mcp N` when connected; src/mcp-command.ts uses a dim temporary operation marker. Keep these changes when updating upstream.

Dependencies: `npm ci --prefix ~/.pi/agent/packages/pi-mcp --omit=dev --ignore-scripts`. The node_modules directory is gitignored. The global MCP configuration is `~/.pi/agent/mcp.json` (gitignored); the former adapter configuration was backed up to `~/.pi/agent/mcp.pi-mcp-adapter.backup.json`.

Use `/mcp` → select atlassian → `c` to connect, `a` for OAuth if requested, `d` to disconnect. Default mode is lazy/direct: no MCP tools, connection, or footer status until connected. OAuth credentials from pi-mcp-adapter are not migrated; first use may require signing in again.
