// Client for mcp.tc's public, read-only interfaces (documented at https://mcp.tc/docs/api and https://mcp.tc/AGENTS.md):
//   POST /mcp              the directory's MCP server (tools search_servers, get_server, list_categories)
//   GET  /i/{slug}.json    one listing as JSON (404 not listed, 410 removed; ?lang= for labels and links)
//   GET  /api/index.json   every listing in one compact array
//   GET  /directory?q=...  a pasted server URL, repo or package answers 303 to its listing
// Requests are sequential and carry our User-Agent; 429s are handled in http.js.
import { CliError, EXIT, UsageError } from './errors.js';
import { request } from './http.js';
import { clean } from './output.js';

export const DEFAULT_BASE = 'https://mcp.tc';
/** Site languages: English at the root, the others under /{lang}. */
export const LANGS = Object.freeze(['en', 'it', 'fr', 'de', 'es']);
/** Protocol version for /mcp calls: stateless, so one request per call and no initialize. */
export const PROTOCOL_VERSION = '2026-07-28';
const PV_META = 'io.modelcontextprotocol/protocolVersion';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @typedef {object} DirectoryOptions
 * @property {string} [base] mcp.tc base URL without a trailing slash (default: MCPTC_BASE_URL or https://mcp.tc)
 * @property {import('./http.js').RequestOptions['onRetry']} [onRetry]
 * @property {import('./http.js').RequestOptions['sleep']} [sleep]
 * @property {number} [timeout]
 */

/**
 * The base URL from MCPTC_BASE_URL, checked and without a trailing slash.
 * @param {Record<string, string|undefined>} [env]
 */
export function baseUrl(env = process.env) {
  const raw = (env.MCPTC_BASE_URL || '').trim() || DEFAULT_BASE;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`MCPTC_BASE_URL is not a valid URL: ${raw}`, {}, 'invalid_base_url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new UsageError(`MCPTC_BASE_URL must be an http or https URL: ${raw}`, {}, 'invalid_base_url');
  }
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

/**
 * Directory options from a command context: its base URL, and retry notices on stderr.
 * @param {{base: string, out: {info: (t: string) => void}}} ctx
 * @returns {DirectoryOptions}
 */
export function clientOptions(ctx) {
  return {
    base: ctx.base,
    onRetry: ({ host, attempt, maxAttempts, waitMs }) =>
      ctx.out.info(`${host} is limiting requests (HTTP 429). Trying again in ${Math.max(1, Math.round(waitMs / 1000))} s (attempt ${attempt + 1} of ${maxAttempts}).`),
  };
}

/** @param {DirectoryOptions} opts */
function baseOf(opts) {
  return (opts.base || baseUrl()).replace(/\/+$/, '');
}

/** @param {string} base */
function hostOf(base) {
  return new URL(base).host;
}

/** @param {DirectoryOptions} opts */
function httpOptions(opts) {
  /** @type {import('./http.js').RequestOptions} */
  const o = {};
  if (opts.onRetry) o.onRetry = opts.onRetry;
  if (opts.sleep) o.sleep = opts.sleep;
  if (opts.timeout) o.timeout = opts.timeout;
  return o;
}

/**
 * How mcp.tc labels a server's access (the listing badge): it describes the server, not mcp.tc.
 * @param {string|null|undefined} kind 'remote' | 'local'
 * @param {string|null|undefined} auth 'none' | 'oauth' | 'api_key' | 'optional' | 'unknown'
 * @returns {{key: 'ok'|'auth'|'key'|'opt'|'page'|'local', group: 'ok'|'auth'|'local', label: string, long: string}}
 */
export function accessState(kind, auth) {
  if (kind === 'local') return { key: 'local', group: 'local', label: 'Local', long: 'Runs locally' };
  switch (auth) {
    case 'none':
      return { key: 'ok', group: 'ok', label: 'No sign-in', long: 'No sign-in' };
    case 'oauth':
      return { key: 'auth', group: 'auth', label: 'Sign-in', long: 'OAuth sign-in' };
    case 'api_key':
      return { key: 'key', group: 'auth', label: 'API key', long: 'Needs an API key' };
    case 'optional':
      return { key: 'opt', group: 'auth', label: 'Sign-in optional', long: 'Sign-in optional' };
    default:
      return { key: 'page', group: 'auth', label: 'Unconfirmed', long: 'Sign-in not confirmed' };
  }
}

/**
 * Read a slug out of what the person typed: a slug, a name, or a listing link (mcp.tc/i/notion, https://mcp.tc/it/i/notion,
 * also on the configured base URL). Names and other text come back unchanged with link: false.
 * @param {string} input
 * @param {string} [base]
 * @returns {{slug: string, lang: string|null, link: boolean}}
 */
export function parseListingRef(input, base = DEFAULT_BASE) {
  const s = String(input).trim();
  const origins = new Set(['mcp.tc', 'www.mcp.tc']);
  try {
    origins.add(new URL(base).host);
  } catch {
    // ignore a bad base here: baseUrl() reports it
  }
  const m = /^(?:https?:\/\/)?([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(s);
  if (m && origins.has(m[1].toLowerCase()) && m[2]) {
    const p = /^\/(?:(it|fr|de|es)\/)?i\/([^/.]+)(?:\.(?:json|md))?\/?$/i.exec(m[2]);
    if (p) return { slug: p[2].toLowerCase(), lang: p[1] ? p[1].toLowerCase() : null, link: true };
  }
  return { slug: s, lang: null, link: false };
}

/**
 * A listing slug from what the person typed, or a UsageError that says how to find one.
 * @param {string} input
 * @param {string} [base]
 * @returns {{slug: string, lang: string|null}}
 */
export function requireSlug(input, base) {
  const ref = parseListingRef(input, base);
  const slug = ref.slug.toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new UsageError(`"${clean(input, { oneLine: true })}" is not a listing slug. Slugs look like "notion" or "hugging-face"; find one with: mcp-tc search <words>`, {}, 'invalid_slug');
  }
  return { slug, lang: ref.lang };
}

/**
 * Call one of the /mcp tools and return its structuredContent.
 * Unknown listings throw not_found (exit 3); invalid arguments throw a UsageError (exit 2).
 * @param {'search_servers'|'get_server'|'list_categories'} tool
 * @param {Record<string, unknown>} [args]
 * @param {DirectoryOptions} [opts]
 * @returns {Promise<any>}
 */
export async function mcpCall(tool, args = {}, opts = {}) {
  const base = baseOf(opts);
  let msg = await rpc(base, tool, args, true, opts);
  if (msg.error && msg.error.code === -32022) {
    // a newer mcp.tc that no longer speaks this version: the stateless legacy call still works
    msg = await rpc(base, tool, args, false, opts);
  }
  const host = hostOf(base);
  if (msg.error) {
    const text = clean(msg.error.message || 'unknown error', { oneLine: true });
    if (msg.error.code === -32602) {
      throw new UsageError(`${host}: ${text}`, { rpc_code: -32602 }, 'invalid_argument');
    }
    throw new CliError('mcp_error', `${host} answered with an error: ${text}`, EXIT.ERROR, { rpc_code: msg.error.code ?? null });
  }
  const result = msg.result || {};
  if (result.isError) {
    const text = clean(Array.isArray(result.content) ? result.content.map((/** @type {any} */ c) => c && c.text).filter(Boolean).join(' ') : '', { oneLine: true });
    if (/^No listing at /i.test(text)) {
      throw new CliError('not_found', `No listing for "${clean(String(args.slug ?? ''), { oneLine: true })}" on ${host}. Find the slug with: mcp-tc search <words>`, EXIT.NOT_FOUND, { server_message: text });
    }
    if (/was removed from the directory/i.test(text)) {
      throw new CliError('gone', `The listing "${clean(String(args.slug ?? ''), { oneLine: true })}" was removed from ${host}.`, EXIT.NOT_FOUND, { server_message: text });
    }
    throw new CliError('tool_error', `${host}: ${text || `the ${tool} tool reported an error`}`, EXIT.ERROR, { server_message: text });
  }
  if (!result.structuredContent || typeof result.structuredContent !== 'object') {
    throw new CliError('bad_response', `${host} sent a ${tool} answer without structured content.`, EXIT.ERROR);
  }
  return result.structuredContent;
}

let rpcId = 0;

/**
 * One JSON-RPC tools/call. Returns the response message (result or error).
 * @param {string} base
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {boolean} modern
 * @param {DirectoryOptions} opts
 */
async function rpc(base, tool, args, modern, opts) {
  const id = ++rpcId;
  /** @type {Record<string, any>} */
  const params = { name: tool, arguments: args };
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (modern) {
    params._meta = { [PV_META]: PROTOCOL_VERSION };
    headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    headers['Mcp-Method'] = 'tools/call';
    headers['Mcp-Name'] = tool;
  }
  const res = await request(`${base}/mcp`, {
    ...httpOptions(opts),
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }),
  });
  const host = hostOf(base);
  const msg = parseRpcBody(res.text, res.headers.get('content-type') || '', id);
  if (msg) return msg;
  if (res.status >= 500) {
    throw new CliError('server_error', `${host} answered HTTP ${res.status}. Try again later.`, EXIT.ERROR, { status: res.status });
  }
  throw new CliError('bad_response', `${host} sent an answer that is not a JSON-RPC message (HTTP ${res.status}).`, EXIT.ERROR, { status: res.status });
}

/**
 * The JSON-RPC response in a JSON or SSE body, or null.
 * @param {string} text
 * @param {string} contentType
 * @param {number} id
 */
export function parseRpcBody(text, contentType, id) {
  /** @type {string[]} */
  const candidates = [];
  if (/text\/event-stream/i.test(contentType)) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) candidates.push(data);
    }
  } else {
    candidates.push(text);
  }
  for (const c of candidates) {
    let m;
    try {
      m = JSON.parse(c);
    } catch {
      continue;
    }
    if (m && typeof m === 'object' && !Array.isArray(m) && m.jsonrpc === '2.0' && ('result' in m || 'error' in m)) {
      if (m.id === id || m.id === undefined || m.id === null) return m;
    }
  }
  return null;
}

/**
 * One listing from /i/{slug}.json. lang (it, fr, de, es) switches labels and links as /embed documents.
 * @param {string} slug
 * @param {DirectoryOptions & {lang?: string|null}} [opts]
 */
export async function listingJson(slug, opts = {}) {
  const base = baseOf(opts);
  const host = hostOf(base);
  const s = String(slug).toLowerCase();
  if (!SLUG_RE.test(s)) {
    throw new UsageError(`"${clean(slug, { oneLine: true })}" is not a listing slug.`, {}, 'invalid_slug');
  }
  const q = opts.lang && opts.lang !== 'en' ? `?lang=${encodeURIComponent(opts.lang)}` : '';
  const res = await request(`${base}/i/${encodeURIComponent(s)}.json${q}`, { ...httpOptions(opts), headers: { Accept: 'application/json' } });
  if (res.status === 404) {
    throw new CliError('not_found', `No listing "${s}" on ${host}. Find the slug with: mcp-tc search <words>`, EXIT.NOT_FOUND, { slug: s });
  }
  if (res.status === 410) {
    throw new CliError('gone', `The listing "${s}" was removed from ${host}.`, EXIT.NOT_FOUND, { slug: s });
  }
  if (res.status !== 200) {
    throw new CliError('server_error', `${host} answered HTTP ${res.status} for the listing "${s}".`, EXIT.ERROR, { status: res.status });
  }
  const data = res.json();
  if (!data || typeof data !== 'object' || typeof data.slug !== 'string') {
    throw new CliError('bad_response', `${host} sent listing data in an unexpected shape.`, EXIT.ERROR);
  }
  return data;
}

/**
 * Check that a listing exists without downloading it (HEAD /i/{slug}.json). Throws not_found or gone.
 * @param {string} slug
 * @param {DirectoryOptions} [opts]
 */
export async function listingExists(slug, opts = {}) {
  const base = baseOf(opts);
  const host = hostOf(base);
  const res = await request(`${base}/i/${encodeURIComponent(slug)}.json`, { ...httpOptions(opts), method: 'HEAD' });
  if (res.status === 404) {
    throw new CliError('not_found', `No listing "${slug}" on ${host}. Find the slug with: mcp-tc search <words>`, EXIT.NOT_FOUND, { slug });
  }
  if (res.status === 410) {
    throw new CliError('gone', `The listing "${slug}" was removed from ${host}.`, EXIT.NOT_FOUND, { slug });
  }
  if (res.status >= 400) {
    throw new CliError('server_error', `${host} answered HTTP ${res.status} for the listing "${slug}".`, EXIT.ERROR, { status: res.status });
  }
  return true;
}

/**
 * What to send to /directory?q= for an address: a URL without credentials, query or fragment, or a package name
 * without its version. Never headers, environment values or keys. Returns null when there is nothing to look up.
 * @param {string} input a server URL, a repository URL, an npm or PyPI page, or a package name
 * @param {{registry?: 'npm'|'pypi'|null}} [opts] for a plain package name (no "/" or "@"): which registry page to send
 */
export function addressForLookup(input, opts = {}) {
  const s = String(input || '').trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  const looksLikeHost = /^(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?(?:[/?#].*)?$/i.test(s);
  if (hasScheme || (looksLikeHost && !s.startsWith('@'))) {
    let u;
    try {
      u = new URL(hasScheme ? s : `https://${s}`);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.pathname === '/' ? u.origin : `${u.origin}${u.pathname}`;
  }
  // package name: drop a version ("@scope/pkg@1.2.3", "pkg@latest", "pkg==1.0")
  let name = s.replace(/==.*$/, '');
  name = name.startsWith('@') ? name.replace(/^(@[^/@]+\/[^@]+)@.*$/, '$1') : name.replace(/@.*$/, '');
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  if (name.includes('/') || name.startsWith('@')) return name;
  if (opts.registry === 'npm') return `https://www.npmjs.com/package/${name}`;
  if (opts.registry === 'pypi') return `https://pypi.org/project/${name}`;
  return null; // a bare word is a search on mcp.tc, not an address
}

/**
 * Find the listing for a server address (GET /directory?q=, which answers 303 to the listing). Only what
 * addressForLookup() keeps is sent. Returns the slug, or null when mcp.tc has no listing for it.
 *   303 to /i/{slug}               listed
 *   303 to the suggest form, or to the directory, on mcp.tc itself; 200 (a search page)   not listed
 *   403 (a Cloudflare refusal or another)          throws "blocked": never read as "not listed"
 *   anything else (404, 5xx, a redirect elsewhere) throws, so a wrong MCPTC_BASE_URL or an outage is never read as
 *   "not listed" either. 429 is retried in http.js, then throws "rate_limited".
 * @param {string} input
 * @param {DirectoryOptions & {registry?: 'npm'|'pypi'|null}} [opts]
 * @returns {Promise<string|null>}
 */
export async function lookupAddress(input, opts = {}) {
  const q = addressForLookup(input, opts);
  if (q === null) return null;
  const base = baseOf(opts);
  const host = hostOf(base);
  const res = await request(`${base}/directory?q=${encodeURIComponent(q)}`, {
    ...httpOptions(opts),
    redirect: 'manual',
    readBody: false,
    headers: { Accept: 'text/html' },
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    let u = null;
    try {
      u = loc ? new URL(loc, `${base}/`) : null;
    } catch {
      u = null;
    }
    const same = u !== null && u.origin === new URL(base).origin;
    if (u && same) {
      const m = /^\/(?:(?:it|fr|de|es)\/)?i\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(u.pathname);
      if (m) return m[1];
      // the suggest form (or a search page): not listed
      if (/^\/(?:(?:it|fr|de|es)\/)?(?:submit|directory)\/?$/.test(u.pathname)) return null;
    }
    const to = !u ? ' without a location' : ` to ${clean(same ? u.pathname : u.origin, { oneLine: true }).slice(0, 120)}`;
    throw new CliError(
      'unexpected_status',
      `${host} answered an address lookup with a redirect (HTTP ${res.status})${to} that is neither a listing nor the suggest form. Check MCPTC_BASE_URL, or try again later.`,
      EXIT.ERROR,
      { status: res.status },
    );
  }
  if (res.status === 200) return null; // a search page: nothing listed at that address
  if (res.status === 403) {
    const cloudflare = res.headers.get('cf-ray') !== null || /cloudflare/i.test(res.headers.get('server') || '');
    throw new CliError(
      'blocked',
      `${host} refused the address lookup (HTTP 403${cloudflare ? ', Cloudflare' : ''}). mcp-tc does not try to get around this. Try again later, and if it keeps happening, open an issue at https://github.com/mcptc/mcp-tc/issues.`,
      EXIT.ERROR,
      { host, status: 403, ray: res.headers.get('cf-ray') },
    );
  }
  if (res.status >= 500) {
    throw new CliError('server_error', `${host} answered HTTP ${res.status} to an address lookup. Try again later.`, EXIT.ERROR, { status: res.status });
  }
  throw new CliError('unexpected_status', `${host} answered HTTP ${res.status} to an address lookup. Check MCPTC_BASE_URL, or try again later.`, EXIT.ERROR, { status: res.status });
}

/** @type {Map<string, Promise<any[]>>} */
const indexCache = new Map();

/**
 * Every listing in one compact array (GET /api/index.json), fetched once per process and base URL.
 * Fields: s slug, n name, v vendor, t tagline, c category, k kind, a auth, g tags, i icon path, f verified.
 * @param {DirectoryOptions} [opts]
 * @returns {Promise<any[]>}
 */
export function index(opts = {}) {
  const base = baseOf(opts);
  let p = indexCache.get(base);
  if (!p) {
    p = (async () => {
      const res = await request(`${base}/api/index.json`, { ...httpOptions(opts), headers: { Accept: 'application/json' } });
      if (res.status !== 200) {
        throw new CliError('server_error', `${hostOf(base)} answered HTTP ${res.status} for the directory index.`, EXIT.ERROR, { status: res.status });
      }
      const data = res.json();
      if (!Array.isArray(data)) throw new CliError('bad_response', `${hostOf(base)} sent the directory index in an unexpected shape.`, EXIT.ERROR);
      return data;
    })();
    indexCache.set(base, p);
    p.catch(() => indexCache.delete(base));
  }
  return p;
}

/** Forget the cached index (tests). */
export function clearIndexCache() {
  indexCache.clear();
}
