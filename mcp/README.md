# Thread Exporter MCP server

A small local [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude Code, Claude
Desktop, Cursor…) use the Thread Exporter for Reddit extension. The agent calls a tool, the server
passes the request to the extension over `127.0.0.1`, and the extension does the work in your Chrome,
with your limits. Threads are formatted with the extension's own code, so the output matches its
export files.

## Install

```bash
cd reddit-thread-exporter/mcp
npm install
```

Node.js 20 or later.

## Add it to your agent

```bash
claude mcp add thread-exporter -- node /absolute/path/to/reddit-thread-exporter/mcp/server.js
```

For other clients, add a stdio MCP server with the command `node` and the argument
`/absolute/path/to/reddit-thread-exporter/mcp/server.js`.

Then open the exporter in Chrome, find **Agent access** and switch on **Allow agents**.

## Tools

`export_threads`, `find_threads`, `get_exported_threads`, `add_to_queue`, `get_queue` and
`get_status`. Large results are saved to a file and the path is returned.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `THREAD_EXPORTER_PORT` | `39317` | Local port shared with the extension (set the same one under Agent access → Advanced). |
| `THREAD_EXPORTER_OUTPUT_DIR` | `~/Downloads/Reddit Thread Exporter` | Where large results are saved. |
| `THREAD_EXPORTER_INLINE_LIMIT` | `60000` | Results longer than this many characters are saved to a file. |
| `THREAD_EXPORTER_EXTENSION_IDS` | – | Extra extension IDs to accept, comma-separated. |

With Claude Code, pass them with `-e`, for example
`claude mcp add thread-exporter -e THREAD_EXPORTER_PORT=39318 -- node …/mcp/server.js`.

## Development

```bash
npm test
```

The server logs to stderr only; stdout carries MCP messages. Setup, limits and the bridge protocol
between this server and the extension are described in [docs/AGENTS.md](../docs/AGENTS.md).
