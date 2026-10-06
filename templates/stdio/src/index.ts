#!/usr/bin/env node
// A local MCP server: the client starts this program and talks to it over stdin and stdout.
//
// stdout carries the protocol, so never print to it: one console.log breaks the connection. Log with console.error,
// which clients keep out of the protocol and show in their server logs.
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { buildServer } from './server.js';

// serveStdio answers both protocol eras: 2026-07-28 clients and older ones that open with initialize.
const handle = serveStdio(buildServer);

// The server also stops by itself when the client closes stdin.
function stop(): void {
    void handle.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
