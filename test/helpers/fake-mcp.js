// A local MCP server with switchable behaviour, for the doctor, check and card tests. Nothing here talks to the network.
//
//   const fake = await startFakeMcp({ modern: true, legacy: true, reply: 'json' });
//   fake.url        the MCP endpoint (http://127.0.0.1:PORT/mcp by default)
//   fake.requests   every request seen: {method, path, headers, body}
//   fake.set({...}) change options between steps; fake.close() when done
//
// Options (all optional):
//   path            endpoint path ('/mcp')
//   modern          answer the 2026-07-28 style: server/discover and per-request _meta (true)
//   modernVersions  versions that style accepts (['2026-07-28'])
//   modernReply     what a server without the modern style says to server/discover:
//                   'method-not-found' (200 + -32601), 'not-initialized' (400), 'http-404' (404 page)
//   legacy          answer initialize (true); legacyVersions the versions it agrees to, newest first
//   session         issue Mcp-Session-Id on initialize, require it afterwards, end it on DELETE (false);
//                   deleteStatus answers DELETE with this status instead
//   reply           'json' or 'sse' (replies as text/event-stream); sseKeepOpen leaves the SSE reply open (false)
//   tools           the tool list (two annotated read-only tools); pageSize > 0 splits tools/list into pages
//   prompts, resources   lists; offered in capabilities when given
//   serverInfo, instructions, capabilities   override what the handshake says
//   auth            'none', 'oauth' (401 + RFC 9728 metadata), 'apikey' (401, no challenge), 'optional' (200 +
//                   WWW-Authenticate), 'waf' (403 firewall page), 'tools' (handshake open, tools/list needs sign-in)
//   token           the credential that passes with auth set ('test-token', as "Authorization: Bearer test-token")
//   prm, as         overrides merged into the metadata documents; prmHeader (true) puts resource_metadata in the
//                   challenge; prmServed / asServed (true) serve the documents
//   legacySse       serve the old HTTP+SSE transport at `path` (GET stream + POST /messages) instead
//   delayMs         wait before answering MCP requests
//   broken          answer MCP requests with a cut-off JSON body
//   html            answer everything with a web page
//   status          answer MCP requests with this HTTP status and an empty JSON-RPC-less body
//   rateLimit       answer this many requests with 429 first (Retry-After: 0)
//   redirectTo      answer MCP requests with a 307 to this URL
//   gone            answer 410 with {"endpoint": gone} (the new URL)
//   retiredSse      a retired HTTP+SSE URL: POST answers 405 and GET 410 with {"error": ..., "endpoint": retiredSse}
//   echoToken       on a refused token, quote it back without "Bearer " (in WWW-Authenticate error_description, in
//                   lowercase in the JSON-RPC error message, and its first 12 characters in error.data.hint)
//   hostCheck, originCheck   refuse a foreign Host / Origin with 403 (DNS rebinding protection)
//   card            JSON served at <path>/server-card; wellKnownCard at /.well-known/mcp/server-card.json;
//                   cardCors (true) adds Access-Control-Allow-Origin: *
//   directory       {slug: get_server structuredContent}: POST /dir/mcp answers mcp.tc's get_server for these
//   pointTo         answer MCP requests like a directory page: 409 with error.data.endpoint = this URL
//
// Run as a script it is a stdio server instead (for check --command):
//   node test/helpers/fake-mcp.js --fake-stdio '{"modern": false}'
// Options: modern, legacy, tools, pageSize, serverInfo, and
//   noise           print a plain log line on stdout before answering (a common bug)
//   crash           write an error to stderr and exit 1 at once
//   ignoreDiscover  don't answer server/discover at all (some older servers drop requests before initialize)
//   pingFirst       send a ping request to the client before answering initialize
//   hang            keep running after stdin closes (the client has to stop it)
//   pinEra          keep the connection in the era of its first request other than server/discover, refusing the
//                   other era with -32022, as the TypeScript SDK's serveStdio does; with pidFile, append this
//                   process's pid to that file (to count how many processes a check starts)
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

export const GOOD_TOOLS = Object.freeze([
  {
    name: 'search_docs',
    title: 'Search docs',
    description: 'Search the documentation and return matching pages with their titles and links.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for' } }, required: ['query'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_page',
    title: 'Get page',
    description: 'Return the full text of one documentation page, given its path from search_docs.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

/**
 * n plain tools named tool_1 ... tool_n.
 * @param {number} n
 */
export function manyTools(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i + 1}`,
    description: `Return item number ${i + 1} from the example catalogue.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }));
}

const PV = 'io.modelcontextprotocol/protocolVersion';
const SI = 'io.modelcontextprotocol/serverInfo';

/**
 * @param {Record<string, any>} [options]
 */
export async function startFakeMcp(options = {}) {
  /** @type {Record<string, any>} */
  const o = {
    path: '/mcp',
    modern: true,
    modernVersions: ['2026-07-28'],
    modernReply: 'method-not-found',
    legacy: true,
    legacyVersions: ['2025-11-25', '2025-06-18', '2025-03-26'],
    session: false,
    reply: 'json',
    sseKeepOpen: false,
    tools: GOOD_TOOLS,
    pageSize: 0,
    auth: 'none',
    token: 'test-token',
    prm: {},
    as: {},
    prmHeader: true,
    prmServed: true,
    asServed: true,
    legacySse: false,
    delayMs: 0,
    broken: false,
    html: false,
    status: 0,
    rateLimit: 0,
    redirectTo: null,
    gone: null,
    retiredSse: null,
    echoToken: false,
    hostCheck: false,
    originCheck: false,
    card: null,
    wellKnownCard: null,
    cardCors: true,
    directory: {},
    pointTo: null,
    ...options,
  };
  /** @type {{method: string, path: string, headers: Record<string, any>, body: string}[]} */
  const requests = [];
  const sessions = new Set();
  /** @type {string[]} */
  const deleted = [];
  /** @type {Set<import('node:http').ServerResponse>} */
  const open = new Set();
  /** @type {Map<string, import('node:http').ServerResponse>} */
  const sseStreams = new Map();
  let sid = 0;
  let base = '';

  const serverInfo = () => ({
    name: 'fake-docs',
    title: 'Fake Docs',
    version: '1.2.3',
    description: 'Search and read the Fake Docs documentation.',
    websiteUrl: 'https://docs.example.com',
    icons: [{ src: 'https://docs.example.com/icon.png', mimeType: 'image/png', sizes: ['128x128'] }],
    ...(o.serverInfo || {}),
  });
  const capabilities = () => {
    if (o.capabilities) return o.capabilities;
    /** @type {Record<string, object>} */
    const c = { tools: {} };
    if (o.prompts) c.prompts = {};
    if (o.resources) c.resources = {};
    return c;
  };
  const instructions = () => (o.instructions !== undefined ? o.instructions : 'Use search_docs first, then get_page for the full text.');
  const endpoint = () => `${base}${o.path}`;
  const prmUrl = () => `${base}/.well-known/oauth-protected-resource${o.path}`;

  /**
   * A page of a list.
   * @param {any[]} all
   * @param {string} key
   * @param {any} cursor
   */
  const page = (all, key, cursor) => {
    const size = o.pageSize > 0 ? o.pageSize : all.length || 1;
    const start = cursor === undefined || cursor === null ? 0 : Number(String(cursor).replace(/^c/, ''));
    if (!Number.isInteger(start) || start < 0 || start > all.length) return null;
    const items = all.slice(start, start + size);
    /** @type {Record<string, any>} */
    const res = { [key]: items };
    if (start + size < all.length) res.nextCursor = `c${start + size}`;
    return res;
  };

  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests.push({ method: req.method || 'GET', path: req.url || '/', headers: { ...req.headers }, body });
      const url = new URL(req.url || '/', 'http://fake');
      /** @param {number} status @param {unknown} v @param {Record<string, string>} [h] */
      const json = (status, v, h = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...h });
        res.end(JSON.stringify(v));
      };

      if (o.rateLimit > 0) {
        o.rateLimit--;
        return json(429, { error: 'slow down' }, { 'Retry-After': '0' });
      }
      const port = String(server.address() && /** @type {any} */ (server.address()).port);
      if (o.hostCheck && ![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host))) {
        return json(403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: `Invalid Host: ${req.headers.host}` } });
      }
      if (o.originCheck && req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(String(req.headers.origin))) {
        return json(403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Invalid Origin' } });
      }

      // OAuth metadata
      if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        if (!['oauth', 'tools'].includes(o.auth) || !o.prmServed || (url.pathname !== `/.well-known/oauth-protected-resource${o.path}` && url.pathname !== '/.well-known/oauth-protected-resource')) {
          return json(404, { error: 'not_found' });
        }
        return json(200, { resource: endpoint(), authorization_servers: [base], scopes_supported: ['docs:read'], bearer_methods_supported: ['header'], resource_name: 'Fake Docs', ...o.prm });
      }
      if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration')) {
        if (!['oauth', 'tools'].includes(o.auth) || !o.asServed) return json(404, { error: 'not_found' });
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
          scopes_supported: ['docs:read'],
          ...o.as,
        });
      }
      // server cards
      const cors = o.cardCors ? { 'Access-Control-Allow-Origin': '*' } : {};
      if (req.method === 'GET' && url.pathname === `${o.path.replace(/\/+$/, '')}/server-card`) {
        if (!o.card) return json(404, { error: 'not_found' });
        res.writeHead(200, { 'Content-Type': 'application/mcp-server-card+json', ...cors });
        return res.end(typeof o.card === 'string' ? o.card : JSON.stringify(o.card));
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/mcp/server-card.json') {
        if (!o.wellKnownCard) return json(404, { error: 'not_found' });
        return json(200, o.wellKnownCard, cors);
      }
      // a stand-in for mcp.tc's get_server
      if (url.pathname === '/dir/mcp') return directory(body, json);

      if (o.html) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><html><head><title>Fake Docs</title></head><body>Welcome</body></html>');
      }
      if (o.legacySse) return legacySse(req, res, url, body);
      if (url.pathname !== o.path) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.gone) return json(410, { error: 'gone', endpoint: o.gone });
      if (o.retiredSse) {
        if (req.method === 'GET') return json(410, { error: 'SSE transport is deprecated', message: 'Use Streamable HTTP.', endpoint: o.retiredSse });
        res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain' });
        return res.end('Method Not Allowed');
      }
      if (o.redirectTo) {
        res.writeHead(307, { Location: o.redirectTo });
        return res.end();
      }
      if (o.status) {
        res.writeHead(o.status, { 'Content-Type': 'text/plain' });
        return res.end('Server error');
      }
      if (o.broken) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"jsonrpc":"2.0","id":1,"result":{"protocolVers');
      }
      if (o.pointTo) {
        return json(409, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: `This link is a page, not an MCP endpoint. Connect to the server's own URL: ${o.pointTo}`, data: { endpoint: o.pointTo, listing: `${base}/i/fake` } },
        });
      }
      if (req.method === 'GET') {
        res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } }));
      }
      if (req.method === 'DELETE') {
        const s = String(req.headers['mcp-session-id'] || '');
        if (o.deleteStatus) {
          res.writeHead(o.deleteStatus);
          return res.end();
        }
        if (o.session && sessions.has(s)) {
          sessions.delete(s);
          deleted.push(s);
          res.writeHead(200);
          return res.end();
        }
        res.writeHead(o.session ? 404 : 405);
        return res.end();
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        return res.end();
      }
      return mcp(req, res, body, json);
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} raw
   * @param {(status: number, v: unknown, h?: Record<string, string>) => void} json
   */
  function mcp(req, res, raw, json) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    const authz = String(req.headers.authorization || '');
    const authed = authz === `Bearer ${o.token}`;
    /** @type {Record<string, string>} */
    const extra = {};
    if (!authed && ['oauth', 'apikey', 'waf'].includes(o.auth)) return denied(res, json, o.auth, authz);
    if (!authed && o.auth === 'tools' && msg.method === 'tools/list') return denied(res, json, 'oauth');
    if (o.auth === 'optional') extra['WWW-Authenticate'] = `Bearer resource_metadata="${prmUrl()}"`;

    const id = msg.id;
    if (id === undefined) {
      res.writeHead(202, extra);
      return res.end();
    }
    const params = msg.params || {};
    const answer = (/** @type {number} */ status, /** @type {any} */ m, /** @type {Record<string, string>} */ h = {}) => {
      const full = { jsonrpc: '2.0', id, ...m };
      if (o.reply === 'sse' && status === 200) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...extra, ...h });
        res.write(': fake stream\n\n');
        res.write(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"working"}}\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify(full)}\n\n`);
        if (o.sseKeepOpen) {
          open.add(res);
          res.on('close', () => open.delete(res));
          return;
        }
        return res.end();
      }
      return json(status, full, { ...extra, ...h });
    };

    const pv = params._meta && params._meta[PV];
    const modernStyle = msg.method !== 'initialize' && (pv !== undefined || msg.method === 'server/discover');
    if (modernStyle) {
      if (!o.modern) {
        if (o.modernReply === 'not-initialized') return answer(400, { error: { code: -32000, message: 'Bad Request: Server not initialized' } });
        if (o.modernReply === 'http-404') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Not found');
        }
        return answer(200, { error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
      if (typeof pv !== 'string') return answer(400, { error: { code: -32020, message: 'Header mismatch: params._meta protocolVersion is required.' } });
      if (!o.modernVersions.includes(pv)) {
        return answer(400, { error: { code: -32022, message: 'Unsupported protocol version', data: { supported: o.modernVersions, requested: pv } } });
      }
      if (req.headers['mcp-protocol-version'] !== pv || req.headers['mcp-method'] !== msg.method) {
        return answer(400, { error: { code: -32020, message: 'Header mismatch.' } });
      }
      const meta = { [SI]: serverInfo() };
      switch (msg.method) {
        case 'server/discover':
          return answer(200, { result: { supportedVersions: o.modernVersions, capabilities: capabilities(), instructions: instructions(), resultType: 'complete', _meta: meta } });
        case 'tools/list':
        case 'prompts/list':
        case 'resources/list': {
          const key = msg.method.split('/')[0];
          const p = page(o[key] || [], key, params.cursor);
          if (!p) return answer(200, { error: { code: -32602, message: 'Invalid cursor' } });
          return answer(200, { result: { ...p, resultType: 'complete', _meta: meta } });
        }
        default:
          return answer(404, { error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
    }

    if (msg.method === 'initialize') {
      if (!o.legacy) return answer(400, { error: { code: -32600, message: 'This server speaks 2026-07-28 only: use server/discover.' } });
      const asked = params.protocolVersion;
      const version = o.legacyVersions.includes(asked) ? asked : o.legacyVersions[0];
      /** @type {Record<string, string>} */
      const h = {};
      if (o.session) {
        const s = `fake-session-${++sid}`;
        sessions.add(s);
        h['Mcp-Session-Id'] = s;
      }
      return answer(200, { result: { protocolVersion: version, capabilities: capabilities(), serverInfo: serverInfo(), instructions: instructions() } }, h);
    }
    if (!o.legacy) return answer(400, { error: { code: -32600, message: 'Bad Request' } });
    if (o.session && !sessions.has(String(req.headers['mcp-session-id'] || ''))) {
      return answer(400, { error: { code: -32000, message: 'Bad Request: No valid session ID provided' } });
    }
    const hv = req.headers['mcp-protocol-version'];
    if (hv !== undefined && !o.legacyVersions.includes(hv)) {
      return answer(400, { error: { code: -32000, message: `Bad Request: Unsupported protocol version: ${hv}` } });
    }
    switch (msg.method) {
      case 'ping':
        return answer(200, { result: {} });
      case 'tools/list':
      case 'prompts/list':
      case 'resources/list': {
        const key = msg.method.split('/')[0];
        const p = page(o[key] || [], key, params.cursor);
        if (!p) return answer(200, { error: { code: -32602, message: 'Invalid cursor' } });
        return answer(200, { result: p });
      }
      default:
        return answer(200, { error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  }

  /**
   * A refusal for a request without the right credential.
   * @param {import('node:http').ServerResponse} res
   * @param {(status: number, v: unknown, h?: Record<string, string>) => void} json
   * @param {string} [kind]
   * @param {string} [authz] the Authorization header the request carried
   */
  function denied(res, json, kind = o.auth, authz = '') {
    if (kind === 'waf') {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' });
      return res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>');
    }
    if (kind === 'apikey') return json(401, { error: 'Missing API key. Send it in the X-API-Key header.' });
    const challenge = o.prmHeader ? `Bearer resource_metadata="${prmUrl()}", scope="docs:read"` : 'Bearer realm="fake"';
    const token = authz.replace(/^Bearer\s+/i, '');
    if (o.echoToken && token) {
      const error = { code: -32001, message: `Unauthorized: the token ${token.toLowerCase()} is not valid`, data: { hint: `token starts with ${token.slice(0, 12)}` } };
      return json(401, { jsonrpc: '2.0', id: null, error }, { 'WWW-Authenticate': `${challenge}, error="invalid_token", error_description="token ${token} expired"` });
    }
    return json(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, { 'WWW-Authenticate': challenge });
  }

  /**
   * The HTTP+SSE transport of 2024-11-05.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {string} raw
   */
  function legacySse(req, res, url, raw) {
    if (req.method === 'GET' && url.pathname === o.path) {
      const s = `sse-${++sid}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: endpoint\ndata: /messages?sessionId=${s}\n\n`);
      sseStreams.set(s, res);
      open.add(res);
      res.on('close', () => {
        sseStreams.delete(s);
        open.delete(res);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const stream = sseStreams.get(url.searchParams.get('sessionId') || '');
      if (!stream) {
        res.writeHead(404);
        return res.end('Unknown session');
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        res.writeHead(400);
        return res.end('Bad JSON');
      }
      res.writeHead(202);
      res.end('Accepted');
      if (msg.id === undefined) return;
      const params = msg.params || {};
      /** @type {any} */
      let reply;
      if (msg.method === 'initialize') {
        reply = { result: { protocolVersion: '2024-11-05', capabilities: capabilities(), serverInfo: serverInfo(), instructions: instructions() } };
      } else if (msg.method === 'tools/list' || msg.method === 'prompts/list' || msg.method === 'resources/list') {
        const key = msg.method.split('/')[0];
        const p = page(o[key] || [], key, params.cursor);
        reply = p ? { result: p } : { error: { code: -32602, message: 'Invalid cursor' } };
      } else {
        reply = { error: { code: -32601, message: 'Method not found' } };
      }
      setTimeout(() => stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply })}\n\n`), 5);
      return;
    }
    res.writeHead(405, { Allow: 'GET' });
    return res.end();
  }

  /**
   * POST /dir/mcp: mcp.tc's get_server for the listings in o.directory.
   * @param {string} raw
   * @param {(status: number, v: unknown, h?: Record<string, string>) => void} json
   */
  function directory(raw, json) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const args = (msg.params && msg.params.arguments) || {};
    const slug = String(args.slug || '').toLowerCase();
    const sc = o.directory[slug];
    if (!sc) {
      return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `No listing at mcp.tc/i/${slug}. Use search_servers to find the right slug.` }], isError: true } });
    }
    return json(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: sc.name }], structuredContent: sc } });
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    get url() {
      return `${base}${o.path}`;
    },
    port: addr.port,
    requests,
    sessions,
    deleted,
    options: o,
    /** @param {Record<string, any>} next */
    set(next) {
      Object.assign(o, next);
    },
    reset() {
      requests.length = 0;
    },
    /** Requests to the MCP endpoint only, as parsed JSON-RPC bodies (non-JSON bodies are skipped). */
    rpc() {
      return requests
        .filter((r) => r.method === 'POST')
        .map((r) => {
          try {
            return { ...JSON.parse(r.body), headers: r.headers };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },
    close() {
      for (const r of open) r.end();
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      });
    },
  };
}

/**
 * A stdio MCP server on this process's stdin and stdout.
 * @param {Record<string, any>} options
 */
export function runStdioFake(options = {}) {
  const o = { modern: true, legacy: true, tools: GOOD_TOOLS, pageSize: 0, ...options };
  if (o.crash) {
    process.stderr.write("Error: Cannot find module 'zod'\n");
    process.exit(1);
  }
  const serverInfo = { name: 'fake-stdio', title: 'Fake Stdio', version: '0.3.0', description: 'A local test server.', ...(o.serverInfo || {}) };
  if (o.pidFile) appendFileSync(o.pidFile, `${process.pid}\n`);
  /** @type {'modern'|'legacy'|null} the era this connection is kept in (pinEra) */
  let era = null;
  const send = (/** @type {unknown} */ m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  if (o.noise) process.stdout.write('Fake stdio server started\n');
  /** @type {Map<string, () => void>} */
  const pending = new Map();
  let pingId = 1000;
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (msg.method === undefined && msg.id !== undefined) {
      const done = pending.get(String(msg.id));
      if (done) done();
      return;
    }
    if (msg.id === undefined) return;
    const params = msg.params || {};
    const reply = (/** @type {any} */ m) => send({ jsonrpc: '2.0', id: msg.id, ...m });
    const list = (/** @type {string} */ key) => {
      const all = o[key] || [];
      const size = o.pageSize > 0 ? o.pageSize : all.length || 1;
      const start = params.cursor ? Number(String(params.cursor).slice(1)) : 0;
      /** @type {Record<string, any>} */
      const res = { [key]: all.slice(start, start + size) };
      if (start + size < all.length) res.nextCursor = `c${start + size}`;
      return res;
    };
    const modernStyle = msg.method !== 'initialize' && (msg.method === 'server/discover' || (params._meta && params._meta[PV]));
    if (o.pinEra && msg.method !== 'server/discover') {
      const wants = modernStyle ? 'modern' : 'legacy';
      if (era === null) era = wants;
      else if (era !== wants) {
        const version = modernStyle ? params._meta[PV] : params.protocolVersion || '2025-11-25';
        return reply({ error: { code: -32022, message: `Unsupported protocol version: ${version}` } });
      }
    }
    if (modernStyle) {
      if (msg.method === 'server/discover' && o.ignoreDiscover) return;
      if (!o.modern) return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
      if (msg.method === 'server/discover') {
        return reply({ result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, resultType: 'complete', _meta: { [SI]: serverInfo } } });
      }
      if (msg.method === 'tools/list') return reply({ result: { ...list('tools'), resultType: 'complete' } });
      return reply({ error: { code: -32601, message: 'Method not found' } });
    }
    if (msg.method === 'initialize') {
      if (!o.legacy) return reply({ error: { code: -32600, message: 'This server speaks 2026-07-28 only.' } });
      const answer = () => reply({ result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo, instructions: 'Local test server.' } });
      if (o.pingFirst) {
        const id = ++pingId;
        pending.set(String(id), answer);
        return send({ jsonrpc: '2.0', id, method: 'ping' });
      }
      return answer();
    }
    if (msg.method === 'tools/list') return reply({ result: list('tools') });
    return reply({ error: { code: -32601, message: 'Method not found' } });
  });
  rl.on('close', () => {
    if (!o.hang) process.exit(0);
    setInterval(() => {}, 1000);
  });
}

if (process.argv.includes('--fake-stdio')) {
  const i = process.argv.indexOf('--fake-stdio');
  runStdioFake(JSON.parse(process.argv[i + 1] || '{}'));
}
