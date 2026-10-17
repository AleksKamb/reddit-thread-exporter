#!/usr/bin/env node
/**
 * Thread Exporter for Reddit: local MCP server.
 *
 * Speaks MCP over stdio with the agent and reaches the extension through the local
 * bridge on 127.0.0.1 (see docs/AGENTS.md). stdout carries MCP messages only, so
 * everything else is logged to stderr.
 */

import process from 'node:process';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { Bridge } from './lib/bridge.js';
import { loadConfig } from './lib/config.js';
import { createMcpServer } from './lib/tools.js';

/** @param {string} message */
function log(message) {
  process.stderr.write(`[thread-exporter] ${message}\n`);
}

const config = loadConfig(process.env);
config.warnings.forEach(log);

const bridge = new Bridge({ port: config.port, extensionIds: config.extensionIds, log });
const server = createMcpServer({ bridge, config, log });

// Show the extension which agent this is ("claude-code", "cursor"…) once the client says.
server.server.oninitialized = () => {
  const clientName = server.server.getClientVersion()?.name;
  if (clientName) bridge.setName(clientName);
};

let shuttingDown = false;
async function shutDown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Closing the hub lets another agent session take over the port.
  await bridge.close();
  await server.close();
  process.exit(0);
}

// The MCP client ends a stdio server by closing stdin; the open port would otherwise keep it running.
process.stdin.on('end', shutDown);
process.stdin.on('close', shutDown);
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);

await server.connect(new StdioServerTransport());
await bridge.start();
