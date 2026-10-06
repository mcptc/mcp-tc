// A local stand-in for mcp.tc's public read endpoints, answering with responses recorded from production on
// 2026-10-06 (test/fixtures/directory). Tests point MCPTC_BASE_URL (or the base option) at it.
//
//   POST /mcp            tools/call for search_servers, get_server, list_categories (2026-07-28 or legacy style)
//   GET|HEAD /i/{slug}.json   deepwiki, memory (English), notion (?lang=it); removed-server answers 410
//   GET /api/index.json  12 recorded entries
//   GET /directory?q=    303 to a listing for a recorded address, 303 to the suggest form for other URLs, else 200
//   POST /submit         the JSON suggestion endpoint (fixtures/directory/submit.json): 202 queued with a new token,
//                        200 duplicate for a listed URL, 400 for a body that is not {"url": string}
//   GET /s/{token}.json  the suggestion's status: each read moves one step along its list of states, then stays on
//                        the last; 404 {"state": "missing"} for an unknown token
//
// Overrides for error paths, served before normal routing, one per request:
//   fake.rateLimit(times, retryAfter)   429 (retryAfter null = no Retry-After header)
//   fake.block(times, kind)             Cloudflare-style 403: '1010', 'challenge' or 'html'
//   fake.fail(times, status)            a plain error status (500, 502 ...)
//   fake.respond(status, body, headers) any answer (a body that is not a string is sent as JSON)
//   fake.submitError(name)              the next POST /submit gets submit.json's errors[name] or raw[name]
// What POST /submit does next (one plan per suggestion, default: queued, then queued, checking, reviewing, listed):
//   fake.planSubmit({states, existing, listing})  states: keys of submit.json's "status"; existing: answer
//                                       "existing_submission": true; listing: {slug, name} for links and duplicates
// fake.requests lists every request seen: {method, path, headers, body}.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';

const FIX = new URL('../fixtures/directory/', import.meta.url);

/** @param {string} name */
export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIX), 'utf8'));
}

/** Slugs with a recorded get_server answer (git and upstash: local servers whose setup has /path/to/ and YOUR_ values). */
export const GET_SLUGS = Object.freeze(['deepwiki', 'notion', 'memory', 'mcp-tc', 'ref-tools', 'git', 'upstash']);
/** A slug the fake treats as removed (410 / "was removed"). */
export const GONE_SLUG = 'removed-server';
const MODERN = '2026-07-28';

/**
 * @param {{modernVersions?: string[]}} [opts] modernVersions: what the fake accepts as 2026-07-28-style versions
 */
export async function startFakeDirectory(opts = {}) {
  const modern = opts.modernVersions || [MODERN];
  /** @type {{method: string, path: string, headers: Record<string, string|string[]|undefined>, body: string}[]} */
  const requests = [];
  /** @type {{status: number, headers: Record<string, string>, body: string}[]} */
  const queue = [];
  const categories = fixture('mcp-categories').message.result.structuredContent.categories.map((/** @type {any} */ c) => c.slug);
  const redirects = fixture('directory').redirects;
  const submitFix = fixture('submit');
  /** @type {any[]} plans for the next suggestions */
  const plans = [];
  /** @type {Map<string, {states: string[], step: number, listing: {slug: string, name: string}}>} */
  const submissions = new Map();
  let tokens = 0;
  /** @type {{base: string}} */
  const self = { base: '' };
  /** Fixture text with the fake's base URL and the placeholders filled in. @param {any} v @param {Record<string, string>} vars */
  const fill = (v, vars) =>
    JSON.parse(
      JSON.stringify(v)
        .replaceAll('https://mcp.tc', self.base)
        .replace(/\{(token|slug|name)\}/g, (m, k) => (vars[k] !== undefined ? JSON.stringify(vars[k]).slice(1, -1) : m)),
    );

  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      requests.push({ method: req.method || 'GET', path: req.url || '/', headers: { ...req.headers }, body });
      const send = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers, /** @type {string} */ text) => {
        res.writeHead(status, headers);
        res.end(req.method === 'HEAD' ? undefined : text);
      };
      const json = (/** @type {number} */ status, /** @type {unknown} */ v, /** @type {Record<string, string>} */ extra = {}) =>
        send(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra }, JSON.stringify(v));
      const next = queue.shift();
      if (next) return send(next.status, next.headers, next.body);

      const url = new URL(req.url || '/', 'http://fake');
      if (url.pathname === '/mcp') return handleMcp(req, body, json, modern, categories);
      let m;
      if (req.method === 'POST' && url.pathname === '/submit') {
        const nostore = { 'Cache-Control': 'no-store' };
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') return send(403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'This form takes posts from mcp.tc pages only.');
        let d = null;
        try {
          d = JSON.parse(body);
        } catch {
          d = null;
        }
        if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.url !== 'string') {
          return json(400, submitFix.errors.invalid_request.body, nostore);
        }
        const plan = plans.shift() || {};
        const listing = plan.listing || submitFix.listings[d.url] || submitFix.default_listing;
        if (submitFix.listings[d.url] && !plan.states) return json(200, fill(submitFix.duplicate, listing), nostore);
        tokens += 1;
        const token = `faketok${String(tokens).padStart(6, '0')}`;
        submissions.set(token, { states: plan.states || ['queued', 'checking', 'reviewing', 'listed'], step: 0, listing });
        const accepted = fill(submitFix.accepted, { token });
        if (plan.existing) accepted.existing_submission = true;
        return json(202, accepted, { ...nostore, Location: `${self.base}/s/${token}.json` });
      }
      if (req.method === 'GET' && (m = /^\/s\/([A-Za-z0-9_-]{8,64})\.json$/.exec(url.pathname))) {
        const sub = submissions.get(m[1]);
        if (!sub) return json(404, submitFix.status.missing, { 'Cache-Control': 'no-store' });
        const state = sub.states[Math.min(sub.step, sub.states.length - 1)];
        sub.step += 1;
        return json(200, fill(submitFix.status[state], sub.listing), { 'Cache-Control': 'no-store' });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && (m = /^\/i\/([^/]+)\.json$/.exec(url.pathname))) {
        const slug = decodeURIComponent(m[1]).toLowerCase();
        const lang = url.searchParams.get('lang');
        if (slug === GONE_SLUG) return json(410, { error: 'gone', docs: 'https://mcp.tc/embed#json' });
        const name = lang && lang !== 'en' ? `listing-${slug}.${lang}` : `listing-${slug}`;
        if (/^[a-z0-9-]+$/.test(slug) && existsSync(new URL(`${name}.json`, FIX))) return json(200, fixture(name).body);
        return json(404, fixture('listing-unknown').body);
      }
      if (req.method === 'GET' && url.pathname === '/api/index.json') return json(200, fixture('index'));
      if (req.method === 'GET' && url.pathname === '/directory') {
        const q = url.searchParams.get('q') || '';
        if (redirects[q]) return send(303, { Location: redirects[q], 'Content-Type': 'text/html; charset=UTF-8' }, '');
        if (/^https?:\/\/\S+$/i.test(q)) return send(303, { Location: `/submit?url=${encodeURIComponent(q)}`, 'Content-Type': 'text/html; charset=UTF-8' }, '');
        return send(200, { 'Content-Type': 'text/html; charset=UTF-8' }, '<!doctype html><title>Directory</title><p>search results</p>');
      }
      return send(404, { 'Content-Type': 'text/html' }, '<!doctype html><title>Not found</title>');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  self.base = `http://127.0.0.1:${addr.port}`;

  return {
    base: self.base,
    requests,
    /** @param {{states?: string[], existing?: boolean, listing?: {slug: string, name: string}}} plan */
    planSubmit(plan) {
      plans.push(plan);
    },
    /** @param {string} name a key of submit.json's errors or raw */
    submitError(name) {
      const f = submitFix.errors[name] || submitFix.raw[name];
      if (!f) throw new Error(`no submit fixture "${name}"`);
      const body = typeof f.body === 'string' ? f.body : JSON.stringify(fill(f.body, {}));
      const ct = typeof f.body === 'string' ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      queue.push({ status: f.status, headers: { ...ct, ...(f.headers || {}) }, body });
    },
    /** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
    respond(status, body, headers = {}) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      queue.push({ status, headers: { ...(typeof body === 'string' ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: text });
    },
    /** @param {number} times @param {string|null} [retryAfter] */
    rateLimit(times, retryAfter = '0') {
      for (let i = 0; i < times; i++) {
        queue.push({
          status: 429,
          headers: { 'Content-Type': 'application/json', ...(retryAfter === null ? {} : { 'Retry-After': retryAfter }) },
          body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit: 120 requests per minute per address.' } }),
        });
      }
    },
    /** @param {number} times @param {'1010'|'challenge'|'html'} [kind] */
    block(times, kind = '1010') {
      for (let i = 0; i < times; i++) {
        /** @type {Record<string, string>} */
        const headers = { 'cf-ray': '8f00000000000000-FRA', Server: 'cloudflare' };
        let text = '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>';
        if (kind === '1010') {
          headers['Content-Type'] = 'text/plain; charset=UTF-8';
          text = 'error code: 1010';
        } else {
          headers['Content-Type'] = 'text/html; charset=UTF-8';
          if (kind === 'challenge') headers['cf-mitigated'] = 'challenge';
        }
        queue.push({ status: 403, headers, body: text });
      }
    },
    /** @param {number} times @param {number} [status] */
    fail(times, status = 502) {
      for (let i = 0; i < times; i++) queue.push({ status, headers: { 'Content-Type': 'text/html' }, body: '<html>Bad gateway</html>' });
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      plans.length = 0;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      });
    },
  };
}

/**
 * Run the CLI in this process with captured output. stdout is not a terminal, so there are no colors.
 * @param {string[]} argv
 * @param {{base?: string, env?: Record<string, string|undefined>, stdin?: any, platform?: NodeJS.Platform, spawn?: any, cwd?: string}} [opts]
 */
export async function runCli(argv, opts = {}) {
  const { main } = await import('../../src/cli.js');
  let stdout = '';
  let stderr = '';
  const env = { PATH: process.env.PATH, COLUMNS: '100', ...(opts.base ? { MCPTC_BASE_URL: opts.base } : {}), ...(opts.env || {}) };
  const code = await main(argv, {
    stdout: /** @type {any} */ ({ isTTY: false, write: (/** @type {string} */ s) => ((stdout += s), true) }),
    stderr: /** @type {any} */ ({ isTTY: false, write: (/** @type {string} */ s) => ((stderr += s), true) }),
    stdin: opts.stdin,
    env,
    platform: opts.platform,
    spawn: opts.spawn,
    cwd: opts.cwd,
  });
  return {
    code,
    stdout,
    stderr,
    /** stdout parsed as the one JSON document it must be */
    json() {
      return JSON.parse(stdout);
    },
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} raw
 * @param {(status: number, v: unknown, extra?: Record<string, string>) => void} json
 * @param {string[]} modern
 * @param {string[]} categories
 */
function handleMcp(req, raw, json, modern, categories) {
  if (req.method !== 'POST') {
    return json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP endpoint takes JSON-RPC messages by POST.' } });
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return json(400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the body is not valid JSON.' } });
  }
  const id = msg && msg.id;
  const reply = (/** @type {number} */ status, /** @type {any} */ m) => json(status, { jsonrpc: '2.0', id, ...m });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return reply(400, { error: { code: -32600, message: 'Invalid Request.' } });
  }
  const params = msg.params || {};
  const pv = params._meta && params._meta['io.modelcontextprotocol/protocolVersion'];
  if (pv !== undefined) {
    if (!modern.includes(pv)) {
      return reply(400, { error: { code: -32022, message: 'Unsupported protocol version', data: { supported: modern, requested: pv } } });
    }
    const h = req.headers;
    if (h['mcp-protocol-version'] !== pv || h['mcp-method'] !== msg.method || (msg.method === 'tools/call' && h['mcp-name'] !== params.name)) {
      return reply(400, { error: { code: -32020, message: 'Header mismatch.' } });
    }
  }
  if (msg.method !== 'tools/call') return reply(pv !== undefined ? 404 : 200, { error: { code: -32601, message: `Method not found: ${msg.method}` } });
  const args = params.arguments || {};
  const recorded = (/** @type {string} */ name) => {
    const f = fixture(name);
    return reply(f.status, structuredClone(f.message));
  };
  switch (params.name) {
    case 'search_servers': {
      if (args.category !== undefined && !categories.includes(String(args.category))) {
        return reply(200, { error: { code: -32602, message: `Unknown category "${args.category}". Use a slug from list_categories, e.g. "databases" or "developer-tools".` } });
      }
      let name = 'mcp-search-empty';
      if (args.auth === 'sign-in') name = 'mcp-search-signin';
      else if (args.query === undefined || /github/i.test(String(args.query))) name = 'mcp-search-github';
      const f = structuredClone(fixture(name));
      const sc = f.message.result && f.message.result.structuredContent;
      if (sc && Number.isInteger(args.limit) && sc.results.length > args.limit) {
        sc.results = sc.results.slice(0, args.limit);
        sc.count = sc.results.length;
      }
      return reply(f.status, f.message);
    }
    case 'get_server': {
      const slug = String(args.slug || '')
        .trim()
        .toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?mcp\.tc/, '')
        .replace(/^\/?i\//, '')
        .replace(/\/+$/, '');
      if (slug === GONE_SLUG) {
        return reply(200, { result: { content: [{ type: 'text', text: `The listing mcp.tc/i/${slug} was removed from the directory.` }], isError: true } });
      }
      if (!GET_SLUGS.includes(slug)) {
        const f = structuredClone(fixture('mcp-get-unknown'));
        f.message.result.content[0].text = `No listing at mcp.tc/i/${slug}. Use search_servers to find the right slug.`;
        return reply(f.status, f.message);
      }
      const f = structuredClone(fixture(`mcp-get-${slug}`));
      if (args.client !== undefined) {
        const sc = f.message.result.structuredContent;
        const known = ['claude-code', 'claude-desktop', 'claude-ai', 'chatgpt', 'cursor', 'vscode', 'devin', 'codex', 'gemini', 'json'];
        if (!known.includes(String(args.client))) {
          return reply(200, { error: { code: -32602, message: `Unknown client "${args.client}". Use one of: ${known.join(', ')}.` } });
        }
        sc.setup = sc.setup.filter((/** @type {any} */ g) => g.client === args.client);
      }
      return reply(f.status, f.message);
    }
    case 'list_categories':
      return recorded('mcp-categories');
    default:
      return reply(200, { error: { code: -32602, message: `Unknown tool: ${params.name}. Tools: search_servers, get_server, list_categories.` } });
  }
}
