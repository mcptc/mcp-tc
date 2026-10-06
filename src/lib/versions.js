// Exact versions that `mcp-tc create` writes into new projects, one line each. To move to a new SDK release, change
// the numbers here and run the slow test (MCPTC_SLOW=1 npm test), which installs exactly these versions into each
// template and runs a real MCP handshake against it.

/** @type {Readonly<Record<string, string>>} */
export const VERSIONS = Object.freeze({
  '@modelcontextprotocol/server': '2.3.1',
  '@modelcontextprotocol/node': '2.1.1',
  '@modelcontextprotocol/express': '2.0.2', // 2.0.2 or later: 2.0.1 drops requireBearerAuth's expectedResource (no audience check)
  express: '5.2.1',
  zod: '4.6.5',
  tsx: '4.23.15',
  typescript: '7.0.2',
  '@types/node': '20.19.43', // the oldest Node.js line the projects support (engines: node >= 20)
  '@types/express': '5.0.6',
  wrangler: '4.148.0', // needs Node.js 22 or later
});

/** Cloudflare Workers compatibility date written into wrangler.jsonc. */
export const WORKERS_COMPATIBILITY_DATE = '2026-10-01';

/** Used only by the slow test, to talk to generated servers the way a real client does. */
export const TEST_CLIENT_VERSION = '2.3.1'; // @modelcontextprotocol/client
