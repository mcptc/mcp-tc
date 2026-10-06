// A small MCP client for doctor, check and card. It talks to one server the way an MCP client would and reports what it
// saw: Streamable HTTP in the 2026-07-28 style first (server/discover, no handshake), then the initialize handshake of
// 2025-11-25 and older, then the old HTTP+SSE transport of 2024-11-05. It lists tools (and prompts and resources when
// the server offers them) and never calls a tool. probeStdio() does the same for a local server it starts, over
// stdin and stdout.
//
// Credentials: none, unless the person passes --header. Those headers go only to MCP requests on the server's own
// origin (never to a redirect on another origin, the server card, or OAuth metadata hosts) and their values are never
// printed: redact() removes them from anything shown.
// Everything a server sends is untrusted text: strings are cleaned (no escape sequences, controls or bidi marks) and capped.
import { spawn as nodeSpawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { UsageError } from './errors.js';
import { networkError } from './http.js';
import { clean } from './output.js';
import { REPO_URL, USER_AGENT, VERSION } from '../version.js';

/** The stateless protocol version: server/discover, version and client info in every request's _meta. */
export const MODERN_VERSION = '2026-07-28';
/** Versions that use the initialize handshake, newest first. */
export const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
/** The version of the old HTTP+SSE transport. */
export const SSE_VERSION = '2024-11-05';
export const KNOWN_VERSIONS = Object.freeze([MODERN_VERSION, ...LEGACY_VERSIONS, SSE_VERSION]);
/** What we tell servers about ourselves. */
export const CLIENT_INFO = Object.freeze({ name: 'mcp-tc-cli', title: 'mcp-tc command-line tool', version: VERSION, websiteUrl: REPO_URL });
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_PAGES = 20;
export const MAX_TOOLS = 1000;
const MAX_LIST_PAGES = 5; // prompts and resources
const MAX_LIST_ITEMS = 500;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const PV_META = 'io.modelcontextprotocol/protocolVersion';
const SI_META = 'io.modelcontextprotocol/serverInfo';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Headers people may not set with --header: the transport and the protocol own them. */
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'accept', 'user-agent',
  'mcp-protocol-version', 'mcp-session-id', 'mcp-method', 'mcp-name', 'origin', 'keep-alive', 'upgrade', 'te', 'trailer',
]);
/** A made-up origin for the DNS rebinding test (.invalid never resolves). */
export const FOREIGN_ORIGIN = 'http://mcp-tc-check.invalid';

/**
 * @typedef {object} ProbeOptions
 * @property {Record<string, string>} [headers] from --header; sent only on MCP requests to the server's own origin
 * @property {number} [timeout] ms per request (default 15 s)
 * @property {boolean} [bothEras] also try the other era after one worked (check, card)
 * @property {boolean} [legacyVersions] after initialize worked, ask for each legacy version to learn which it speaks (card)
 * @property {boolean} [lists] list prompts and resources when offered (default true)
 * @property {boolean} [cards] fetch the server card at <endpoint>/server-card and /.well-known/mcp/server-card.json
 */

/**
 * Parse --header values ("Name: value"). Returns the headers and their names; values are never shown again.
 * @param {string[]|string|undefined} list
 * @returns {{headers: Record<string, string>, names: string[]}}
 */
export function parseHeaderOptions(list) {
  /** @type {Record<string, string>} */
  const headers = {};
  const items = list === undefined ? [] : Array.isArray(list) ? list : [list];
  for (const item of items) {
    const i = item.indexOf(':');
    const name = i > 0 ? item.slice(0, i).trim() : '';
    const value = i > 0 ? item.slice(i + 1).trim() : '';
    if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new UsageError('--header takes "Name: value", for example --header "Authorization: Bearer YOUR_TOKEN".', {}, 'invalid_header');
    }
    if (!value || /[\r\n\0]/.test(value)) {
      throw new UsageError(`--header ${name} needs a value on the same line.`, { header: name }, 'invalid_header');
    }
    if (!/^[\x20-\x7e\t]+$/.test(value)) {
      throw new UsageError(`--header ${name}: the value can only use plain ASCII characters.`, { header: name }, 'invalid_header');
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new UsageError(`--header can't set ${name}: mcp-tc sets it for the protocol.`, { header: name }, 'invalid_header');
    }
    headers[name] = value;
  }
  return { headers, names: Object.keys(headers) };
}

/** Pieces of a --header value this long or longer are hidden wherever they appear, in any letter case. */
const SECRET_PIECE = 8;

/**
 * Replace every --header value inside a value (strings, arrays, objects) with "[hidden]", so a server that echoes a
 * token back can't get it printed. Servers often quote only part of a value: the token without "Bearer ", the base64
 * part of a Basic credential, or the first few characters of a token. So the whole value is hidden, and so is any run
 * of 8 or more characters taken from one of its parts (the value split at spaces, commas, semicolons, colons and
 * equals signs), ignoring letter case.
 * @template T
 * @param {T} value
 * @param {string[]} secrets
 * @returns {T}
 */
export function redact(value, secrets) {
  const whole = secrets.filter((s) => typeof s === 'string' && s.length >= 4).map(asciiLower);
  if (!whole.length) return value;
  /** @type {Set<string>} */
  const pieces = new Set();
  for (const v of whole) {
    // pieces from each part only, so "Bearer " and the spaces around a token stay readable
    for (const part of v.split(/[\s,;:=]+/)) {
      for (let i = 0; i + SECRET_PIECE <= part.length; i++) pieces.add(part.slice(i, i + SECRET_PIECE));
    }
  }
  /** @param {string} str */
  const scrub = (str) => {
    const low = asciiLower(str);
    const hide = new Uint8Array(str.length);
    let any = false;
    for (const w of whole) {
      for (let i = low.indexOf(w); i !== -1; i = low.indexOf(w, i + 1)) {
        hide.fill(1, i, i + w.length);
        any = true;
      }
    }
    for (let i = 0; i + SECRET_PIECE <= low.length; i++) {
      if (pieces.has(low.slice(i, i + SECRET_PIECE))) {
        hide.fill(1, i, i + SECRET_PIECE);
        any = true;
      }
    }
    if (!any) return str;
    // base64 padding right after a hidden run goes with it
    for (let i = 1; i < str.length; i++) if (!hide[i] && hide[i - 1] && str[i] === '=') hide[i] = 1;
    let out = '';
    for (let i = 0; i < str.length; i++) {
      if (!hide[i]) out += str[i];
      else if (i === 0 || !hide[i - 1]) out += '[hidden]';
    }
    return out;
  };
  /** @param {any} v @returns {any} */
  const walk = (v) => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      /** @type {Record<string, any>} */
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(value);
}

/**
 * Lowercase ASCII letters only, so the string keeps its length (header values are plain ASCII).
 * @param {string} s
 */
function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Untrusted text cleaned and capped.
 * @param {unknown} v
 * @param {number} [max]
 * @param {boolean} [multiline]
 */
export function txt(v, max = 300, multiline = false) {
  if (typeof v !== 'string') return '';
  let s = clean(v, { oneLine: !multiline }).trim();
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}\u2026`;
  return s;
}

/** @param {string} host */
export function isLoopback(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0';
}

/**
 * The endpoint URL from what the person typed, or a UsageError. Adds https:// to a bare host; drops the fragment.
 * @param {string} input
 */
export function normalizeEndpoint(input) {
  const s = String(input || '').trim();
  if (!s) throw new UsageError('Missing the server URL.', {}, 'invalid_url');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new UsageError(`Not a valid URL: ${txt(s, 200)}`, {}, 'invalid_url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new UsageError(`Only http and https endpoints can be checked, not ${u.protocol}`, {}, 'invalid_url');
  }
  if (u.username || u.password) {
    throw new UsageError('Take the user name and password out of the URL. To send a credential for testing, use --header "Authorization: ...".', {}, 'invalid_url');
  }
  u.hash = '';
  return u.href;
}

// ------------------------------------------------------------------ secrets in a URL (generic patterns only)

const KEY_PARAM = /(^|[_-])(api[_-]?key|apikey|key|token|access[_-]?token|auth|secret|client[_-]?secret|password|passwd|pwd|signature|sig|session)($|[_-])/i;
const TOKEN_PREFIX = /^(sk|pk|rk)[-_][A-Za-z0-9_-]{12,}$|^(ghp|gho|ghu|ghs|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{10,}$|^AKIA[0-9A-Z]{12,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does a path segment look like a secret (a token) or a personal id (a UUID)?
 * @param {string} seg
 * @returns {'key'|'id'|null}
 */
function segmentKind(seg) {
  let s;
  try {
    s = decodeURIComponent(seg);
  } catch {
    s = seg;
  }
  if (TOKEN_PREFIX.test(s)) return 'key';
  if (UUID.test(s)) return 'id';
  // a run of 20 or more letters and digits, with both in it, looks generated (words joined by hyphens don't)
  for (const run of s.match(/[A-Za-z0-9]{20,}/g) || []) if (/[A-Za-z]/.test(run) && /\d/.test(run)) return 'key';
  return null;
}

/**
 * Parts of a URL that look like a key, a token or a personal id: query parameters with a credential-like name, and
 * path segments that look like tokens.
 * @param {string} url
 * @returns {{where: 'query'|'path', name: string, kind: 'key'|'id'}[]}
 */
export function secretsInUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  /** @type {{where: 'query'|'path', name: string, kind: 'key'|'id'}[]} */
  const found = [];
  for (const [name, value] of u.searchParams) {
    if (value.length >= 6 && KEY_PARAM.test(name)) found.push({ where: 'query', name, kind: 'key' });
    else if (value.length >= 6 && segmentKind(value) === 'key') found.push({ where: 'query', name, kind: 'key' });
  }
  u.pathname.split('/').forEach((seg, i) => {
    const kind = seg ? segmentKind(seg) : null;
    if (kind) found.push({ where: 'path', name: `segment ${i}`, kind });
  });
  return found;
}

/**
 * The URL for display, with key-like query values and path segments replaced by ***.
 * @param {string} url
 */
export function maskUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return txt(url, 500);
  }
  const path = u.pathname
    .split('/')
    .map((seg) => (seg && segmentKind(seg) ? '***' : seg))
    .join('/');
  const params = [...u.searchParams].map(([k, v]) => {
    const hide = v.length >= 6 && (KEY_PARAM.test(k) || segmentKind(v) === 'key');
    return `${encodeURIComponent(k)}=${hide ? '***' : encodeURIComponent(v)}`;
  });
  return `${u.origin}${path}${params.length ? `?${params.join('&')}` : ''}`;
}

// ------------------------------------------------------------------ JSON-RPC bodies (JSON or SSE)

/**
 * Complete SSE events in buf from pos on.
 * @param {string} buf
 * @param {number} [pos]
 * @param {boolean} [final] treat the rest as a complete event (the stream ended)
 * @returns {{events: {event: string, data: string}[], pos: number}}
 */
export function parseSse(buf, pos = 0, final = false) {
  /** @type {{event: string, data: string}[]} */
  const events = [];
  const re = /\r\n\r\n|\n\n|\r\r/g;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(buf);
    let chunk;
    if (m) {
      chunk = buf.slice(pos, m.index);
      pos = m.index + m[0].length;
    } else if (final && pos < buf.length) {
      chunk = buf.slice(pos);
      pos = buf.length;
    } else {
      break;
    }
    let event = '';
    /** @type {string[]} */
    const data = [];
    for (const line of chunk.split(/\r\n|\n|\r/)) {
      if (line === '' || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      let value = i === -1 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value.trim();
      else if (field === 'data') data.push(value);
    }
    if (data.length || event) events.push({ event, data: data.join('\n') });
  }
  return { events, pos };
}

/** @param {unknown} a @param {unknown} b */
function sameId(a, b) {
  const ok = (/** @type {unknown} */ x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));
  return ok(a) && ok(b) && String(a) === String(b);
}

/**
 * Every JSON-RPC message in a body (one object, a batch array, or SSE events).
 * @param {string} text
 * @param {string} contentType
 * @returns {any[]}
 */
export function messagesIn(text, contentType = '') {
  /** @type {string[]} */
  const parts = [];
  if (/event-stream/i.test(contentType) || /^\s*(event|data|id|retry):/m.test(text.slice(0, 200))) {
    for (const ev of parseSse(text, 0, true).events) if (ev.data) parts.push(ev.data);
  } else if (text.trim()) {
    parts.push(text);
  }
  const out = [];
  for (const p of parts) {
    let j;
    try {
      j = JSON.parse(p);
    } catch {
      continue;
    }
    for (const m of Array.isArray(j) ? j : [j]) if (m && typeof m === 'object' && !Array.isArray(m)) out.push(m);
  }
  return out;
}

/**
 * The JSON-RPC response to `id` in a body. An error without a usable id counts too (servers answer parse errors that way).
 * @param {string} text
 * @param {string} contentType
 * @param {string|number} id
 */
export function replyTo(text, contentType, id) {
  let fallback = null;
  for (const m of messagesIn(text, contentType)) {
    const isResponse = 'result' in m || 'error' in m;
    if (!isResponse || typeof m.method === 'string') continue;
    if (sameId(m.id, id)) return m;
    if (fallback === null && m.error && (m.id === null || m.id === undefined)) fallback = m;
  }
  return fallback;
}

// ------------------------------------------------------------------ HTTP exchange

/**
 * @typedef {object} Exchange
 * @property {number} status 0 when no HTTP answer arrived
 * @property {Record<string, string>} headers lowercase names
 * @property {string} contentType
 * @property {string} body
 * @property {string} url the URL that answered (after redirects)
 * @property {number} ms
 * @property {string|null} error why no answer arrived, or why reading stopped
 * @property {boolean} timedOut
 * @property {any} reply the JSON-RPC message answering the request's id, or null
 */

/**
 * @typedef {object} Ctx
 * @property {string} origin the endpoint's origin
 * @property {Record<string, string>} userHeaders
 * @property {number} timeout
 * @property {number} requests
 * @property {{from: string, to: string, status: number, cross_origin: boolean}[]} redirects
 */

/**
 * @param {string} url
 * @param {ProbeOptions} opts
 * @returns {Ctx}
 */
function makeCtx(url, opts) {
  return {
    origin: new URL(url).origin,
    userHeaders: { ...(opts.headers || {}) },
    timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
    requests: 0,
    redirects: [],
  };
}

/**
 * One HTTP exchange that never throws: network trouble comes back as status 0 with an error. An SSE body is read only
 * until the reply to `id` arrives (servers may keep the stream open). Redirects: 307/308 are followed (3 at most),
 * 301/302/303 only for GET; the person's headers are dropped when a redirect leaves the server's origin.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {{method?: string, headers?: Record<string, string>, body?: string, id?: string|number, user?: boolean, timeout?: number, maxBytes?: number}} [o]
 * @returns {Promise<Exchange>}
 */
export async function exchange(ctx, url, o = {}) {
  const method = o.method || 'GET';
  const timeout = o.timeout || ctx.timeout;
  const maxBytes = o.maxBytes || MAX_BYTES;
  const t0 = Date.now();
  let target = url;
  let user = Boolean(o.user);
  /** @type {Exchange} */
  const out = { status: 0, headers: {}, contentType: '', body: '', url, ms: 0, error: null, timedOut: false, reply: null };
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeout);
  try {
    let res;
    for (let hop = 0; ; hop++) {
      /** @type {Record<string, string>} */
      const headers = { ...(o.headers || {}) };
      if (user && new URL(target).origin === ctx.origin) Object.assign(headers, ctx.userHeaders);
      headers['User-Agent'] = USER_AGENT;
      ctx.requests++;
      try {
        res = await fetch(target, { method, headers, body: o.body, redirect: 'manual', signal: ctl.signal });
      } catch (err) {
        out.url = target;
        out.timedOut = timedOut;
        out.error = timedOut ? `no answer within ${Math.round(timeout / 1000)} s` : describeNetworkError(err, new URL(target).host);
        return out;
      }
      const loc = res.headers.get('location');
      const redirect = [301, 302, 303, 307, 308].includes(res.status) && loc;
      const follow = redirect && hop < MAX_REDIRECTS && ([307, 308].includes(res.status) || method === 'GET' || method === 'HEAD');
      if (!follow) break;
      let next;
      try {
        next = new URL(/** @type {string} */ (loc), target).href;
      } catch {
        break;
      }
      if (!/^https?:$/.test(new URL(next).protocol)) break;
      const cross = new URL(next).origin !== ctx.origin;
      ctx.redirects.push({ from: target, to: next, status: res.status, cross_origin: cross });
      if (cross) user = false;
      await res.body?.cancel().catch(() => {});
      target = next;
    }
    out.status = res.status;
    out.url = target;
    res.headers.forEach((v, k) => {
      out.headers[k.toLowerCase()] = v;
    });
    out.contentType = out.headers['content-type'] || '';
    const sse = /event-stream/i.test(out.contentType);
    if (method === 'HEAD' || !res.body) return out;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let size = 0;
    let pos = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          out.error = `the answer was larger than ${Math.round(maxBytes / 1024)} KB; stopped reading`;
          await reader.cancel().catch(() => {});
          break;
        }
        out.body += dec.decode(value, { stream: true });
        if (sse && o.id !== undefined) {
          const parsed = parseSse(out.body, pos);
          pos = parsed.pos;
          const hit = parsed.events.map((e) => replyTo(e.data, 'application/json', /** @type {string|number} */ (o.id))).find((m) => m && sameId(m.id, o.id));
          if (hit) {
            out.reply = hit;
            ctl.abort(); // the stream may stay open: we have what we came for
            break;
          }
        }
      }
    } catch (err) {
      if (timedOut) {
        out.timedOut = true;
        out.error = `the answer did not finish within ${Math.round(timeout / 1000)} s`;
      } else if (!out.reply) {
        out.error = describeNetworkError(err, new URL(target).host);
      }
    }
    out.body += dec.decode();
    if (!out.reply && o.id !== undefined) out.reply = replyTo(out.body, out.contentType, o.id);
    return out;
  } finally {
    clearTimeout(timer);
    out.ms = Date.now() - t0;
  }
}

/**
 * @param {unknown} err
 * @param {string} host
 */
function describeNetworkError(err, host) {
  const msg = networkError(err, host).message;
  return msg.replace(/\.$/, '');
}

/** @param {Exchange} x */
function isHtml(x) {
  if (/html/i.test(x.contentType)) return true;
  const head = x.body.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/** @param {Exchange} x */
function authBlocked(x) {
  return x.status === 401 || x.status === 403;
}

/** @param {Exchange} x */
function looksWaf(x) {
  if (x.headers['cf-mitigated']) return true;
  return isHtml(x) || /Just a moment|Attention Required|captcha|Access Denied/i.test(x.body.slice(0, 4000));
}

/** @param {string} url */
function pathLooksSse(url) {
  return /\/sse\/?$/i.test(new URL(url).pathname);
}

// ------------------------------------------------------------------ the report

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {string|null} title
 * @property {string} description
 * @property {boolean|null} read_only
 * @property {boolean|null} destructive
 * @property {boolean|null} idempotent
 * @property {boolean|null} open_world
 * @property {'object'|'missing'|'invalid'} input_schema
 */

/**
 * @param {string} url
 * @param {string[]} headerNames
 */
function emptyReport(url, headerNames) {
  return {
    url,
    endpoint: url,
    reachable: false,
    mcp: false,
    status: /** @type {number|null} */ (null),
    error: /** @type {string|null} */ (null),
    era: /** @type {'modern'|'legacy'|null} */ (null),
    protocol_version: /** @type {string|null} */ (null),
    supported_versions: /** @type {string[]} */ ([]),
    transport: /** @type {'streamable-http'|'sse'|null} */ (null),
    reply_format: /** @type {'json'|'sse'|null} */ (null),
    session: { issued: false, ended: /** @type {boolean|null} */ (null), delete_status: /** @type {number|null} */ (null) },
    server: /** @type {null|{name: string, title: string, version: string, description: string, websiteUrl: string, icons: {src: string, mimeType: string, sizes: string[]}[]}} */ (null),
    instructions: '',
    capabilities: /** @type {string[]|null} */ (null),
    auth: {
      kind: /** @type {'none'|'optional'|'oauth'|'api_key'|'unknown'|null} */ (null),
      www_authenticate: /** @type {string|null} */ (null),
      challenge: /** @type {null|{scheme: string, params: Record<string, string>}} */ (null),
      prm: /** @type {any} */ (null),
      prm_attempts: /** @type {any[]} */ ([]),
      as: /** @type {any} */ (null),
      with_your_headers: headerNames.length > 0,
    },
    blocked: false,
    html: false,
    tools: /** @type {Tool[]} */ ([]),
    tools_count: /** @type {number|null} */ (null),
    tools_listed: false,
    tools_truncated: false,
    tools_invalid: 0,
    tools_pages: 0,
    tools_error: /** @type {string|null} */ (null),
    prompts_count: /** @type {number|null} */ (null),
    resources_count: /** @type {number|null} */ (null),
    list_errors: /** @type {string[]} */ ([]),
    eras: {
      modern: /** @type {null|{ok: boolean, status: number|null, error: string|null, protocol_version?: string|null}} */ (null),
      legacy: /** @type {null|{ok: boolean, status: number|null, error: string|null, protocol_version?: string|null}} */ (null),
      sse: /** @type {null|{ok: boolean, status: number|null, error: string|null, protocol_version?: string|null}} */ (null),
    },
    legacy_versions: /** @type {string[]|null} */ (null),
    points_to: /** @type {null|{endpoint: string|null, command: string|null, listing: string|null, message: string}} */ (null),
    moved_to: /** @type {string|null} */ (null),
    retry_after: /** @type {number|null} */ (null),
    cards: /** @type {any[]} */ ([]),
    redirects: /** @type {{from: string, to: string, status: number, cross_origin: boolean}[]} */ ([]),
    headers_sent: headerNames,
    stdio: /** @type {null|{exit: {code: number|null, signal: string|null}|null, stderr_tail: string|null, stdout_noise: number}} */ (null),
    handshake_ms: /** @type {number|null} */ (null),
    requests: 0,
    ms: 0,
  };
}

/** @typedef {ReturnType<typeof emptyReport>} Report */

/**
 * Connect to an MCP endpoint and describe it. Never throws for what the server does; throws UsageError for a bad URL.
 * @param {string} input endpoint URL
 * @param {ProbeOptions} [opts]
 * @returns {Promise<Report>}
 */
export async function probe(input, opts = {}) {
  const url = normalizeEndpoint(input);
  const ctx = makeCtx(url, opts);
  const r = emptyReport(url, Object.keys(ctx.userHeaders));
  const t0 = Date.now();
  await handshake(r, ctx, url, opts);
  if (opts.cards) r.cards = await fetchCards(r, ctx);
  r.redirects = ctx.redirects;
  r.requests = ctx.requests;
  r.ms = Date.now() - t0;
  return redact(r, Object.values(ctx.userHeaders));
}

/**
 * @param {string} pv
 */
function modernMeta(pv) {
  return {
    [PV_META]: pv,
    'io.modelcontextprotocol/clientInfo': { name: CLIENT_INFO.name, version: CLIENT_INFO.version },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

let nextId = 0;

/**
 * One JSON-RPC request by POST.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {Record<string, string>} headers
 * @param {{origin?: string}} [extra]
 */
function rpc(ctx, url, method, params, headers, extra = {}) {
  const id = ++nextId;
  /** @type {Record<string, string>} */
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  if (extra.origin) h.Origin = extra.origin;
  return exchange(ctx, url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), id, user: true });
}

/**
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} method
 * @param {{era: 'modern'|'legacy', pv: string, sid: string|null}} s
 */
function notify(ctx, url, method, s) {
  return exchange(ctx, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...sessionHeaders(s, method) },
    body: JSON.stringify({ jsonrpc: '2.0', method }),
    user: true,
    timeout: Math.min(ctx.timeout, 8000),
    maxBytes: 65536,
  });
}

/**
 * @param {{era: 'modern'|'legacy', pv: string, sid: string|null}} s
 * @param {string} method
 * @returns {Record<string, string>}
 */
function sessionHeaders(s, method) {
  if (s.era === 'modern') return { 'MCP-Protocol-Version': s.pv, 'Mcp-Method': method };
  /** @type {Record<string, string>} */
  const h = { 'MCP-Protocol-Version': s.pv };
  if (s.sid) h['Mcp-Session-Id'] = s.sid;
  return h;
}

/**
 * A request inside a session (or the stateless modern style).
 * @param {Ctx} ctx
 * @param {string} url
 * @param {{era: 'modern'|'legacy', pv: string, sid: string|null}} s
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
function call(ctx, url, s, method, params) {
  const p = s.era === 'modern' ? { ...params, _meta: modernMeta(s.pv) } : params;
  return rpc(ctx, url, method, p, sessionHeaders(s, method));
}

/**
 * Note what a JSON-RPC error answer says about the address (a directory page pointing at the real endpoint, say).
 * @param {Report} r
 * @param {Exchange} x
 */
function notePointer(r, x) {
  const e = x.reply && x.reply.error;
  if (!e || !e.data || typeof e.data !== 'object') return;
  const d = e.data;
  const endpoint = typeof d.endpoint === 'string' && /^https?:\/\//.test(d.endpoint) ? txt(d.endpoint, 500) : null;
  const command = typeof d.command === 'string' ? txt(d.command, 300) : null;
  if (!endpoint && !command) return;
  r.points_to = { endpoint, command, listing: typeof d.listing === 'string' ? txt(d.listing, 300) : null, message: txt(e.message, 400) };
}

/**
 * A short reason for a failed request.
 * @param {Exchange} x
 */
function failure(x) {
  if (x.status === 0) return x.error || 'no answer';
  if (x.reply && x.reply.error) {
    const code = typeof x.reply.error.code === 'number' ? ` ${x.reply.error.code}` : '';
    return `HTTP ${x.status}, JSON-RPC error${code}: ${txt(x.reply.error.message, 160) || 'no message'}`;
  }
  if (x.error) return `HTTP ${x.status}, ${x.error}`;
  if (isHtml(x)) return `HTTP ${x.status}, a web page`;
  if (x.body.trim() && !messagesIn(x.body, x.contentType).length) return `HTTP ${x.status}, not valid JSON-RPC`;
  return `HTTP ${x.status}, no JSON-RPC reply`;
}

/**
 * modern, then legacy, then the old HTTP+SSE transport.
 * @param {Report} r
 * @param {Ctx} ctx
 * @param {string} url
 * @param {ProbeOptions} opts
 */
async function handshake(r, ctx, url, opts) {
  // 1. 2026-07-28: server/discover, no handshake
  let pv = MODERN_VERSION;
  let x = await rpc(ctx, url, 'server/discover', { _meta: modernMeta(pv) }, { 'MCP-Protocol-Version': pv, 'Mcp-Method': 'server/discover' });
  if (x.status === 0) {
    r.error = x.error;
    r.eras.modern = { ok: false, status: null, error: x.error };
    return;
  }
  r.status = x.status;
  r.endpoint = x.url;
  r.reachable = true;
  if (authBlocked(x)) {
    r.eras.modern = { ok: false, status: x.status, error: `HTTP ${x.status}: sign-in needed` };
    await classifyAuth(r, ctx, x);
    return;
  }
  if (x.status === 429) {
    r.retry_after = retryAfterSeconds(x.headers['retry-after']);
    r.error = 'the server is limiting requests (HTTP 429)';
    return;
  }
  if (x.status === 410) {
    r.moved_to = goneHint(x, url);
    r.error = `the server says this URL is gone (HTTP 410)${r.moved_to ? `; it points to ${r.moved_to}` : ''}`;
    return;
  }
  notePointer(r, x);
  if (x.reply && x.reply.error && x.reply.error.code === -32022) {
    const data = x.reply.error.data || {};
    const sup = (Array.isArray(data.supported) ? data.supported : []).filter((/** @type {unknown} */ v) => typeof v === 'string' && DATE_RE.test(v) && v >= '2026-' && v !== pv);
    if (sup.length) {
      pv = sup.sort().reverse()[0];
      x = await rpc(ctx, url, 'server/discover', { _meta: modernMeta(pv) }, { 'MCP-Protocol-Version': pv, 'Mcp-Method': 'server/discover' });
    }
  }
  const dr = x.reply && x.reply.result;
  if (dr && Array.isArray(dr.supportedVersions)) {
    const sv = dr.supportedVersions.filter((/** @type {unknown} */ v) => typeof v === 'string').map((/** @type {string} */ v) => txt(v, 20));
    r.mcp = true;
    r.era = 'modern';
    r.protocol_version = sv.includes(pv) ? pv : sv[0] || pv;
    r.supported_versions = sv;
    r.transport = 'streamable-http';
    r.reply_format = /event-stream/i.test(x.contentType) ? 'sse' : 'json';
    r.server = normServerInfo((dr._meta && dr._meta[SI_META]) || dr.serverInfo);
    r.instructions = txt(dr.instructions, 4000, true);
    r.capabilities = capabilityNames(dr.capabilities);
    r.handshake_ms = x.ms;
    r.eras.modern = { ok: true, status: x.status, error: null, protocol_version: r.protocol_version };
    authFromSuccess(r, ctx, x);
    if (x.status !== 200) r.list_errors.push(`server/discover answered HTTP ${x.status} instead of 200`);
    await listEverything(r, ctx, x.url, { era: 'modern', pv: r.protocol_version, sid: null }, dr.capabilities, opts);
    if (opts.bothEras) await tryLegacy(r, ctx, x.url, opts, true);
    if (r.auth.kind === null) r.auth.kind = 'none';
    return;
  }
  r.eras.modern = { ok: false, status: x.status, error: failure(x) };

  const sseLike = pathLooksSse(url);
  const html = isHtml(x);
  if (html && !sseLike) {
    r.html = true;
    r.error = 'a web page, not an MCP endpoint';
    return;
  }

  // 2. 2025-11-25 and older: initialize, notifications/initialized, lists, DELETE
  if (!html) {
    const done = await tryLegacy(r, ctx, url, opts, false);
    if (done) return;
  }

  // 3. the HTTP+SSE transport of 2024-11-05: a GET stream whose first event names the URL for POSTs
  const last = r.eras.legacy ? r.eras.legacy.status : x.status;
  if (sseLike || (last !== null && [400, 404, 405, 406].includes(last))) {
    await legacySse(r, ctx, url, opts);
  } else if (html) {
    r.html = true;
  }
  if (!r.mcp && r.auth.kind === null && r.error === null) {
    r.error = r.html ? 'a web page, not an MCP endpoint' : `no MCP reply (${r.eras.legacy ? r.eras.legacy.error : failure(x)})`;
  }
}

/**
 * The initialize handshake. Returns true when the probe is finished (success, or a sign-in wall).
 * @param {Report} r
 * @param {Ctx} ctx
 * @param {string} url
 * @param {ProbeOptions} opts
 * @param {boolean} secondary the modern era already worked: only record whether legacy clients get in too
 */
async function tryLegacy(r, ctx, url, opts, secondary) {
  const x = await rpc(ctx, url, 'initialize', { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO }, {});
  if (x.status === 0) {
    r.eras.legacy = { ok: false, status: null, error: x.error };
    if (!secondary) r.error = x.error;
    return !secondary;
  }
  if (!secondary) r.status = x.status;
  if (authBlocked(x)) {
    r.eras.legacy = { ok: false, status: x.status, error: `HTTP ${x.status}: sign-in needed` };
    if (!secondary) {
      await classifyAuth(r, ctx, x);
      return true;
    }
    return false;
  }
  const res = x.reply && x.reply.result;
  if (!res || typeof res !== 'object' || (!res.serverInfo && !res.protocolVersion)) {
    r.eras.legacy = { ok: false, status: x.status, error: failure(x) };
    if (!secondary) {
      notePointer(r, x);
      if (isHtml(x)) r.html = true;
    }
    return false;
  }
  const pv = typeof res.protocolVersion === 'string' && DATE_RE.test(res.protocolVersion) ? res.protocolVersion : LEGACY_VERSIONS[0];
  const rawSid = x.headers['mcp-session-id'];
  const sid = typeof rawSid === 'string' && /^[\x21-\x7e]{1,512}$/.test(rawSid) ? rawSid : null;
  const s = { era: /** @type {'legacy'} */ ('legacy'), pv, sid };
  r.eras.legacy = { ok: true, status: x.status, error: null, protocol_version: pv };
  if (secondary) {
    await notify(ctx, x.url, 'notifications/initialized', s);
    if (sid) await endSession(ctx, x.url, s);
    if (opts.legacyVersions) r.legacy_versions = await legacyVersions(ctx, x.url, pv);
    return false;
  }
  r.mcp = true;
  r.era = 'legacy';
  r.protocol_version = pv;
  r.supported_versions = [pv];
  r.transport = 'streamable-http';
  r.reply_format = /event-stream/i.test(x.contentType) ? 'sse' : 'json';
  r.endpoint = x.url;
  r.server = normServerInfo(res.serverInfo);
  r.instructions = txt(res.instructions, 4000, true);
  r.capabilities = capabilityNames(res.capabilities);
  r.handshake_ms = x.ms;
  r.session.issued = sid !== null;
  await notify(ctx, x.url, 'notifications/initialized', s);
  authFromSuccess(r, ctx, x);
  await listEverything(r, ctx, x.url, s, res.capabilities, opts);
  if (sid) {
    const d = await endSession(ctx, x.url, s);
    r.session.delete_status = d.status || null;
    r.session.ended = d.status >= 200 && d.status < 300;
  }
  if (opts.legacyVersions) r.legacy_versions = await legacyVersions(ctx, x.url, pv);
  if (r.auth.kind === null) r.auth.kind = 'none';
  return true;
}

/**
 * Which legacy versions the server agrees to: initialize once per version and keep the ones it echoes.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} first the version it already answered with
 */
async function legacyVersions(ctx, url, first) {
  const agreed = new Set([first]);
  for (const v of LEGACY_VERSIONS) {
    if (agreed.has(v)) continue;
    const x = await rpc(ctx, url, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: CLIENT_INFO }, {});
    const res = x.reply && x.reply.result;
    if (res && res.protocolVersion === v) agreed.add(v);
    const sid = x.headers['mcp-session-id'];
    if (res && typeof sid === 'string' && /^[\x21-\x7e]{1,512}$/.test(sid)) await endSession(ctx, x.url, { era: 'legacy', pv: v, sid });
  }
  return KNOWN_VERSIONS.filter((v) => agreed.has(v));
}

/**
 * @param {Ctx} ctx
 * @param {string} url
 * @param {{era: 'modern'|'legacy', pv: string, sid: string|null}} s
 */
function endSession(ctx, url, s) {
  return exchange(ctx, url, { method: 'DELETE', headers: sessionHeaders(s, 'DELETE'), user: true, timeout: Math.min(ctx.timeout, 8000), maxBytes: 65536 });
}

/** @param {unknown} caps */
function capabilityNames(caps) {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return [];
  return Object.keys(caps).map((k) => txt(k, 60)).filter(Boolean).slice(0, 30);
}

/**
 * tools/list always (unless the capabilities leave tools out), prompts/list and resources/list when offered.
 * @param {Report} r
 * @param {Ctx} ctx
 * @param {string} url
 * @param {{era: 'modern'|'legacy', pv: string, sid: string|null}} s
 * @param {unknown} rawCaps
 * @param {ProbeOptions} opts
 */
async function listEverything(r, ctx, url, s, rawCaps, opts) {
  const caps = rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps) ? /** @type {Record<string, unknown>} */ (rawCaps) : {};
  const none = Object.keys(caps).length === 0;
  if (none || 'tools' in caps) {
    const t = await listAll(ctx, url, s, 'tools/list', 'tools', MAX_PAGES, MAX_TOOLS);
    r.tools_listed = t.ok;
    r.tools_pages = t.pages;
    r.tools_truncated = t.truncated;
    if (!t.ok) {
      r.tools_error = t.error;
      if (t.last && authBlocked(t.last)) {
        r.tools_error = `tools/list needs sign-in (HTTP ${t.last.status})`;
        await classifyAuth(r, ctx, t.last, true);
      }
    }
    for (const item of t.items) {
      const tool = normTool(item);
      if (tool) r.tools.push(tool);
      else r.tools_invalid++;
    }
    r.tools_count = t.ok ? r.tools.length + r.tools_invalid : null;
  }
  if (opts.lists === false) return;
  if ('prompts' in caps) {
    const p = await listAll(ctx, url, s, 'prompts/list', 'prompts', MAX_LIST_PAGES, MAX_LIST_ITEMS);
    r.prompts_count = p.ok ? p.items.length : null;
    if (!p.ok && p.error) r.list_errors.push(`prompts/list: ${p.error}`);
  }
  if ('resources' in caps) {
    const p = await listAll(ctx, url, s, 'resources/list', 'resources', MAX_LIST_PAGES, MAX_LIST_ITEMS);
    r.resources_count = p.ok ? p.items.length : null;
    if (!p.ok && p.error) r.list_errors.push(`resources/list: ${p.error}`);
  }
}

/**
 * Follow nextCursor through the pages of one list.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {{era: 'modern'|'legacy', pv: string, sid: string|null}} s
 * @param {string} method
 * @param {string} key
 * @param {number} maxPages
 * @param {number} maxItems
 */
async function listAll(ctx, url, s, method, key, maxPages, maxItems) {
  /** @type {unknown[]} */
  const items = [];
  /** @type {string|null} */
  let cursor = null;
  let ok = false;
  let pages = 0;
  let truncated = false;
  /** @type {string|null} */
  let error = null;
  /** @type {Exchange|null} */
  let last = null;
  const seen = new Set();
  for (;;) {
    if (pages >= maxPages || items.length >= maxItems) {
      truncated = cursor !== null || items.length > maxItems;
      break;
    }
    const x = await call(ctx, url, s, method, cursor !== null ? { cursor } : {});
    last = x;
    pages++;
    const res = x.reply && x.reply.result;
    if (!res || typeof res !== 'object' || !Array.isArray(res[key])) {
      error = failure(x);
      break;
    }
    ok = true;
    for (const it of res[key]) items.push(it);
    cursor = typeof res.nextCursor === 'string' && res.nextCursor !== '' ? res.nextCursor : null;
    if (cursor === null) break;
    if (seen.has(cursor)) {
      error = `${method} sent the same nextCursor twice; stopped`;
      break;
    }
    seen.add(cursor);
  }
  if (items.length > maxItems) {
    items.length = maxItems;
    truncated = true;
  }
  return { items, ok, pages, truncated, error, last };
}

/**
 * @param {unknown} t
 * @returns {Tool|null}
 */
export function normTool(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const o = /** @type {Record<string, any>} */ (t);
  const name = typeof o.name === 'string' ? txt(o.name, 200) : '';
  if (!name) return null;
  const ann = o.annotations && typeof o.annotations === 'object' && !Array.isArray(o.annotations) ? o.annotations : {};
  const hint = (/** @type {string} */ k) => (typeof ann[k] === 'boolean' ? ann[k] : null);
  const title = txt(typeof o.title === 'string' ? o.title : typeof ann.title === 'string' ? ann.title : '', 200);
  const schema = o.inputSchema;
  const inputSchema = schema === undefined || schema === null ? 'missing' : typeof schema === 'object' && !Array.isArray(schema) && schema.type === 'object' ? 'object' : 'invalid';
  return {
    name,
    title: title || null,
    description: txt(o.description, 2000, true),
    read_only: hint('readOnlyHint'),
    destructive: hint('destructiveHint'),
    idempotent: hint('idempotentHint'),
    open_world: hint('openWorldHint'),
    input_schema: inputSchema,
  };
}

/** @param {unknown} si */
function normServerInfo(si) {
  if (!si || typeof si !== 'object' || Array.isArray(si)) return null;
  const o = /** @type {Record<string, any>} */ (si);
  return {
    name: txt(o.name, 200),
    title: txt(o.title, 200),
    version: txt(o.version, 100),
    description: txt(o.description, 1000, true),
    websiteUrl: typeof o.websiteUrl === 'string' && /^https?:\/\//i.test(o.websiteUrl) ? txt(o.websiteUrl, 500) : '',
    icons: normIcons(o.icons),
  };
}

/** @param {unknown} icons */
function normIcons(icons) {
  if (!Array.isArray(icons)) return [];
  /** @type {{src: string, mimeType: string, sizes: string[]}[]} */
  const out = [];
  for (const i of icons) {
    if (!i || typeof i !== 'object' || typeof i.src !== 'string') continue;
    let src = i.src.trim();
    if (src.startsWith('data:')) {
      const m = /^data:([^;,]+)/.exec(src);
      src = `data:${m ? txt(m[1], 40) : ''} (${src.length} characters)`;
    } else {
      src = txt(src, 500);
    }
    const sizes = Array.isArray(i.sizes) ? i.sizes.filter((/** @type {unknown} */ x) => typeof x === 'string').map((/** @type {string} */ x) => txt(x, 20)).slice(0, 6) : [];
    out.push({ src, mimeType: txt(i.mimeType, 60), sizes });
    if (out.length >= 10) break;
  }
  return out;
}

// ------------------------------------------------------------------ sign-in (RFC 9728 and RFC 8414 metadata; reported, never used)

/**
 * The Bearer challenge in a WWW-Authenticate header, or null.
 * @param {string} wa
 * @returns {{scheme: string, params: Record<string, string>}|null}
 */
export function parseChallenge(wa) {
  const m = /(?:^|,)\s*Bearer\b(.*)$/is.exec(wa || '');
  if (!m) return null;
  /** @type {Record<string, string>} */
  const params = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g;
  let p;
  while ((p = re.exec(m[1]))) {
    const k = p[1].toLowerCase();
    if (!(k in params)) params[k] = txt((p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3]) || '', 500);
  }
  return { scheme: 'Bearer', params };
}

/**
 * May a metadata URL be fetched for this endpoint? https always; http only when the endpoint itself is http on this
 * computer (a server under development).
 * @param {string} url
 * @param {string} endpoint
 */
function metadataUrlOk(url, endpoint) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  const e = new URL(endpoint);
  return u.protocol === 'http:' && e.protocol === 'http:' && isLoopback(u.hostname) && isLoopback(e.hostname);
}

/**
 * Does a protected resource's `resource` cover this endpoint? Same scheme, host and port, and the endpoint's path at or
 * below the resource's path.
 * @param {string} resource
 * @param {string} endpoint
 */
export function resourceCovers(resource, endpoint) {
  let r;
  let e;
  try {
    r = new URL(resource);
    e = new URL(endpoint);
  } catch {
    return false;
  }
  if (r.protocol !== e.protocol || r.hostname.replace(/\.$/, '').toLowerCase() !== e.hostname.replace(/\.$/, '').toLowerCase() || r.port !== e.port) return false;
  const rp = r.pathname.replace(/\/+$/, '');
  const ep = e.pathname.replace(/\/+$/, '');
  return rp === '' || ep === rp || ep.startsWith(`${rp}/`);
}

/** @param {string} url */
function prmWellKnowns(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  const out = [];
  if (path) out.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/**
 * GET a JSON document (metadata, cards). Never sends the person's headers.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} accept
 */
async function getJson(ctx, url, accept = 'application/json') {
  const x = await exchange(ctx, url, { method: 'GET', headers: { Accept: accept }, timeout: Math.min(ctx.timeout, 10_000), maxBytes: 512 * 1024 });
  let data = null;
  if (x.status >= 200 && x.status < 300 && x.body.trim()) {
    try {
      data = JSON.parse(x.body);
    } catch {
      data = null;
    }
  }
  return { x, data: data && typeof data === 'object' && !Array.isArray(data) ? data : null };
}

/**
 * RFC 9728 protected resource metadata.
 * @param {Ctx} ctx
 * @param {string} url
 * @param {string} endpoint
 * @param {'header'|'well-known'} source
 */
async function fetchPrm(ctx, url, endpoint, source) {
  if (!metadataUrlOk(url, endpoint)) return { ok: false, url: txt(url, 500), source, status: null, problem: 'not_https' };
  const { x, data } = await getJson(ctx, url);
  if (!data) return { ok: false, url: txt(url, 500), source, status: x.status || null, problem: x.status === 0 ? 'unreachable' : x.status === 200 ? 'not_json' : 'not_found' };
  if (typeof data.resource !== 'string' || !data.resource.trim()) {
    return { ok: false, url: txt(url, 500), source, status: x.status, problem: 'no_resource' };
  }
  const resource = data.resource.trim();
  const list = (/** @type {unknown} */ v, /** @type {number} */ n) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').map((s) => txt(s, 200)).slice(0, n) : []);
  const servers = list(data.authorization_servers, 10).filter((s) => metadataUrlOk(s, endpoint));
  return {
    ok: resourceCovers(resource, endpoint),
    url: txt(url, 500),
    source,
    status: x.status,
    problem: resourceCovers(resource, endpoint) ? null : 'resource_mismatch',
    resource: txt(resource, 500),
    authorization_servers: servers,
    scopes_supported: list(data.scopes_supported, 40),
    bearer_methods_supported: list(data.bearer_methods_supported, 5),
    resource_name: txt(data.resource_name, 200),
    resource_documentation: typeof data.resource_documentation === 'string' ? txt(data.resource_documentation, 500) : '',
  };
}

/**
 * RFC 8414 / OpenID Connect discovery for an issuer. The issuer in the document must match.
 * @param {Ctx} ctx
 * @param {string} issuer
 * @param {string} endpoint
 */
async function fetchAs(ctx, issuer, endpoint) {
  if (!metadataUrlOk(issuer, endpoint)) return { ok: false, issuer: txt(issuer, 500), tried: [], problem: 'not_https' };
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  const urls = path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  const tried = [];
  let mismatch = false;
  for (const url of urls) {
    const { x, data } = await getJson(ctx, url);
    tried.push({ url, status: x.status || null });
    if (!data || typeof data.issuer !== 'string') continue;
    if (data.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
      mismatch = true;
      continue;
    }
    const s = (/** @type {unknown} */ v) => (typeof v === 'string' ? txt(v, 500) : '');
    const list = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => txt(x, 100)).slice(0, 40) : []);
    return {
      ok: true,
      url,
      issuer: txt(data.issuer, 500),
      authorization_endpoint: s(data.authorization_endpoint),
      token_endpoint: s(data.token_endpoint),
      registration_endpoint: s(data.registration_endpoint),
      client_id_metadata_document_supported: data.client_id_metadata_document_supported === true,
      code_challenge_methods_supported: list(data.code_challenge_methods_supported),
      scopes_supported: list(data.scopes_supported),
      tried,
    };
  }
  return { ok: false, issuer: txt(issuer, 500), tried, problem: mismatch ? 'issuer_mismatch' : 'not_found' };
}

/**
 * 401 or 403: OAuth (protected resource metadata), an API key, or a firewall page.
 * @param {Report} r
 * @param {Ctx} ctx
 * @param {Exchange} x
 * @param {boolean} [afterHandshake] the handshake worked and a list asked for sign-in
 */
async function classifyAuth(r, ctx, x, afterHandshake = false) {
  r.reachable = true;
  if (!afterHandshake) {
    r.status = x.status;
    r.endpoint = x.url;
    r.transport = r.transport || 'streamable-http';
  }
  const wa = x.headers['www-authenticate'] || '';
  r.auth.www_authenticate = wa ? txt(wa, 500) : null;
  const c = parseChallenge(wa);
  r.auth.challenge = c;
  if (!c) {
    if (looksWaf(x)) {
      r.auth.kind = 'unknown';
      r.blocked = true;
      r.html = isHtml(x);
      if (!afterHandshake) r.error = `blocked by a firewall or bot check (HTTP ${x.status})`;
      return;
    }
    r.auth.kind = 'api_key';
    return;
  }
  const endpoint = x.url;
  const rm = c.params.resource_metadata || '';
  let prm = null;
  if (rm) {
    prm = await fetchPrm(ctx, rm, endpoint, 'header');
    r.auth.prm_attempts.push(prm);
  }
  if (!prm || !prm.ok) {
    for (const wk of prmWellKnowns(endpoint)) {
      if (wk === rm) continue;
      const p = await fetchPrm(ctx, wk, endpoint, 'well-known');
      r.auth.prm_attempts.push(p);
      if (p.ok) {
        prm = p;
        break;
      }
    }
  }
  if (prm && prm.ok) {
    r.auth.kind = 'oauth';
    r.auth.prm = prm;
    if (prm.authorization_servers && prm.authorization_servers[0]) r.auth.as = await fetchAs(ctx, prm.authorization_servers[0], endpoint);
    return;
  }
  // servers from before protected resource metadata publish authorization server metadata on their own origin
  const as = await fetchAs(ctx, new URL(endpoint).origin, endpoint);
  if (as.ok) {
    r.auth.kind = 'oauth';
    r.auth.as = as;
    return;
  }
  r.auth.kind = /oauth/i.test(c.params.realm || '') ? 'oauth' : 'api_key';
}

/**
 * A 2xx answer that still carries WWW-Authenticate: sign-in is optional.
 * @param {Report} r
 * @param {Ctx} ctx
 * @param {Exchange} x
 */
function authFromSuccess(r, ctx, x) {
  const wa = x.headers['www-authenticate'] || '';
  if (!wa) {
    if (r.auth.kind === null) r.auth.kind = 'none';
    return;
  }
  r.auth.kind = 'optional';
  r.auth.www_authenticate = txt(wa, 500);
  r.auth.challenge = parseChallenge(wa);
}

/**
 * Seconds from a Retry-After value.
 * @param {string|undefined} v
 */
function retryAfterSeconds(v) {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * A 410 on a retired URL often names the new one (JSON endpoint or options[].url, or a Link rel=alternate).
 * @param {Exchange} x
 * @param {string} url
 */
function goneHint(x, url) {
  /** @type {string[]} */
  const cands = [];
  try {
    const j = JSON.parse(x.body);
    if (j && typeof j.endpoint === 'string') cands.push(j.endpoint);
    if (j && Array.isArray(j.options)) for (const o of j.options) if (o && typeof o.url === 'string') cands.push(o.url);
  } catch {
    // not JSON
  }
  const link = x.headers.link || '';
  for (const m of link.matchAll(/<([^>]+)>\s*;[^,]*rel="?alternate"?/gi)) cands.push(m[1]);
  for (const c of cands) {
    try {
      const abs = new URL(c.trim(), url).href;
      if (/^https?:\/\//.test(abs) && abs !== url) return txt(abs, 500);
    } catch {
      // ignore
    }
  }
  return null;
}

// ------------------------------------------------------------------ the HTTP+SSE transport (2024-11-05)

/**
 * The first `max` bytes of a response body as text; the rest is not read.
 * @param {Response} res
 * @param {number} max
 */
async function readStart(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    while (text.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  } catch {
    // cut off: keep what arrived
  }
  await reader.cancel().catch(() => {});
  return text.slice(0, max);
}

/**
 * GET the stream, wait for the "endpoint" event, then POST initialize, notifications/initialized and the lists to
 * the URL it names. Replies arrive on the stream.
 * @param {Report} r
 * @param {Ctx} ctx
 * @param {string} url
 * @param {ProbeOptions} opts
 */
async function legacySse(r, ctx, url, opts) {
  const ctl = new AbortController();
  const overall = setTimeout(() => ctl.abort(), ctx.timeout * 3);
  /** @type {Map<string, (m: any) => void>} */
  const waiters = new Map();
  /** @type {(v: string|null) => void} */
  let gotEndpoint = () => {};
  const endpointP = /** @type {Promise<string|null>} */ (new Promise((resolve) => (gotEndpoint = resolve)));
  /** @type {Response|null} */
  let res = null;
  try {
    /** @type {Record<string, string>} */
    const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...ctx.userHeaders, 'User-Agent': USER_AGENT };
    ctx.requests++;
    try {
      res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: ctl.signal });
    } catch (err) {
      r.eras.sse = { ok: false, status: null, error: describeNetworkError(err, new URL(url).host) };
      return;
    }
    /** @type {Record<string, string>} */
    const h = {};
    res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
    const ct = h['content-type'] || '';
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      await classifyAuth(r, ctx, { status: res.status, headers: h, contentType: ct, body: body.slice(0, 4000), url, ms: 0, error: null, timedOut: false, reply: null });
      r.eras.sse = { ok: false, status: res.status, error: 'sign-in needed' };
      return;
    }
    if (res.status === 410) {
      // a retired HTTP+SSE URL: the answer often names the new endpoint, as a 410 on the first POST does
      const body = await readStart(res, 4096);
      r.moved_to = goneHint({ status: 410, headers: h, contentType: ct, body, url, ms: 0, error: null, timedOut: false, reply: null }, url);
      r.status = 410;
      r.error = `the server says this URL is gone (HTTP 410)${r.moved_to ? `; it points to ${r.moved_to}` : ''}`;
      r.eras.sse = { ok: false, status: 410, error: r.error };
      return;
    }
    if (res.status !== 200 || !/event-stream/i.test(ct) || !res.body) {
      r.eras.sse = { ok: false, status: res.status, error: `GET answered HTTP ${res.status}${ct ? ` (${txt(ct, 60)})` : ''}, not an SSE stream` };
      await res.body?.cancel().catch(() => {});
      return;
    }
    const reader = res.body.getReader();
    // read the stream in the background; the steps below wait on it
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      let pos = 0;
      let first = true;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parsed = parseSse(buf, pos);
          pos = parsed.pos;
          if (pos > 65536) {
            buf = buf.slice(pos);
            pos = 0;
          }
          for (const ev of parsed.events) {
            if (first) {
              first = false;
              gotEndpoint(ev.event === 'endpoint' && ev.data.trim() ? ev.data.trim() : null);
              continue;
            }
            for (const m of messagesIn(ev.data, 'application/json')) {
              if (typeof m.method === 'string' || !('result' in m || 'error' in m)) continue;
              const w = waiters.get(String(m.id));
              if (w) w(m);
            }
          }
        }
      } catch {
        // aborted or closed
      }
      gotEndpoint(null);
      for (const w of waiters.values()) w(null);
    })();

    const endpointRaw = await withTimeout(endpointP, ctx.timeout);
    if (!endpointRaw) {
      r.eras.sse = { ok: false, status: 200, error: 'the SSE stream did not start with an "endpoint" event' };
      return;
    }
    let post;
    try {
      post = new URL(endpointRaw, url).href;
    } catch {
      post = '';
    }
    if (!post || new URL(post).host !== new URL(url).host) {
      r.eras.sse = { ok: false, status: 200, error: 'the "endpoint" event names another host' };
      return;
    }
    r.reachable = true;
    r.status = 200;
    r.transport = 'sse';
    r.reply_format = 'sse';
    /**
     * @param {string} method
     * @param {Record<string, unknown>} params
     */
    const ask = async (method, params) => {
      const id = ++nextId;
      const p = /** @type {Promise<any>} */ (new Promise((resolve) => waiters.set(String(id), resolve)));
      const x = await exchange(ctx, post, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        user: true,
        maxBytes: 65536,
      });
      if (x.status === 0 || x.status >= 300) {
        waiters.delete(String(id));
        return { reply: x.reply, error: failure(x) };
      }
      const m = x.reply || (await withTimeout(p, ctx.timeout));
      waiters.delete(String(id));
      return { reply: m, error: m ? null : `no reply to ${method} on the SSE stream` };
    };
    const init = await ask('initialize', { protocolVersion: SSE_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    const res0 = init.reply && init.reply.result;
    if (!res0 || typeof res0 !== 'object') {
      r.eras.sse = { ok: false, status: 200, error: init.error || 'initialize failed on the SSE transport' };
      r.error = `the SSE stream opened, but initialize failed: ${init.error || 'no result'}`;
      return;
    }
    r.mcp = true;
    r.era = 'legacy';
    r.protocol_version = typeof res0.protocolVersion === 'string' ? txt(res0.protocolVersion, 20) : SSE_VERSION;
    r.supported_versions = [r.protocol_version];
    r.server = normServerInfo(res0.serverInfo);
    r.instructions = txt(res0.instructions, 4000, true);
    r.capabilities = capabilityNames(res0.capabilities);
    r.eras.sse = { ok: true, status: 200, error: null, protocol_version: r.protocol_version };
    r.error = null;
    if (r.auth.kind === null) r.auth.kind = 'none';
    await exchange(ctx, post, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      user: true,
      maxBytes: 65536,
    });
    await collectLists(r, ask, res0.capabilities, opts);
    ctl.abort();
    await pump;
  } finally {
    clearTimeout(overall);
    ctl.abort();
  }
}

/**
 * @typedef {(method: string, params: Record<string, unknown>) => Promise<{reply: any, error: string|null}>} Ask
 */

/**
 * Follow nextCursor through one list over any transport.
 * @param {Ask} ask
 * @param {string} method
 * @param {string} key
 * @param {number} maxPages
 * @param {number} maxItems
 */
async function collect(ask, method, key, maxPages, maxItems) {
  /** @type {unknown[]} */
  const items = [];
  /** @type {string|null} */
  let cursor = null;
  let pages = 0;
  let ok = false;
  /** @type {string|null} */
  let error = null;
  const seen = new Set();
  while (pages < maxPages && items.length < maxItems) {
    const a = await ask(method, cursor ? { cursor } : {});
    pages++;
    const res = a.reply && a.reply.result;
    if (!res || typeof res !== 'object' || !Array.isArray(res[key])) {
      error = a.error || (a.reply && a.reply.error ? `JSON-RPC error: ${txt(a.reply.error.message, 160) || 'no message'}` : 'no list in the reply');
      break;
    }
    ok = true;
    items.push(...res[key]);
    cursor = typeof res.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null;
    if (!cursor) break;
    if (seen.has(cursor)) {
      error = `${method} sent the same nextCursor twice; stopped`;
      cursor = null;
      break;
    }
    seen.add(cursor);
  }
  const truncated = cursor !== null || items.length > maxItems;
  return { items: items.slice(0, maxItems), ok, pages, error, truncated };
}

/**
 * tools/list (unless the capabilities leave tools out), then prompts/list and resources/list when offered, over any
 * transport; fills the report.
 * @param {Report} r
 * @param {Ask} ask
 * @param {unknown} rawCaps
 * @param {ProbeOptions} opts
 */
async function collectLists(r, ask, rawCaps, opts) {
  const caps = rawCaps && typeof rawCaps === 'object' && !Array.isArray(rawCaps) ? /** @type {Record<string, unknown>} */ (rawCaps) : {};
  if (Object.keys(caps).length === 0 || 'tools' in caps) {
    const t = await collect(ask, 'tools/list', 'tools', MAX_PAGES, MAX_TOOLS);
    r.tools_listed = t.ok;
    r.tools_pages = t.pages;
    r.tools_truncated = t.truncated;
    r.tools_error = t.ok ? null : t.error;
    for (const item of t.items) {
      const tool = normTool(item);
      if (tool) r.tools.push(tool);
      else r.tools_invalid++;
    }
    r.tools_count = t.ok ? r.tools.length + r.tools_invalid : null;
  }
  if (opts.lists === false) return;
  for (const key of ['prompts', 'resources']) {
    if (!(key in caps)) continue;
    const p = await collect(ask, `${key}/list`, key, MAX_LIST_PAGES, MAX_LIST_ITEMS);
    if (key === 'prompts') r.prompts_count = p.ok ? p.items.length : null;
    else r.resources_count = p.ok ? p.items.length : null;
    if (!p.ok && p.error) r.list_errors.push(`${key}/list: ${p.error}`);
  }
}

/**
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @returns {Promise<T|null>}
 */
function withTimeout(p, ms) {
  /** @type {NodeJS.Timeout|undefined} */
  let t;
  return Promise.race([p, new Promise((resolve) => (t = setTimeout(() => resolve(null), ms)))]).finally(() => clearTimeout(t));
}

// ------------------------------------------------------------------ server cards

/**
 * Where a server card can be: <endpoint>/server-card (the location the server card extension recommends, and the one
 * mcp.tc reads) and /.well-known/mcp/server-card.json (which some scanners look at).
 * @param {string} endpoint
 */
export function cardUrls(endpoint) {
  const u = new URL(endpoint);
  u.search = '';
  return [`${u.href.replace(/\/+$/, '')}/server-card`, `${u.origin}/.well-known/mcp/server-card.json`];
}

/**
 * @param {Report} r
 * @param {Ctx} ctx
 */
async function fetchCards(r, ctx) {
  if (r.transport === 'sse' || !r.reachable) return [];
  const out = [];
  for (const url of cardUrls(r.endpoint)) {
    const { x, data } = await getJson(ctx, url, 'application/mcp-server-card+json, application/json;q=0.9');
    out.push({
      url,
      status: x.status || null,
      found: Boolean(data),
      content_type: txt(x.contentType, 100),
      cors: x.headers['access-control-allow-origin'] ? txt(x.headers['access-control-allow-origin'], 100) : null,
      json: x.status === 200 ? Boolean(data) : null,
      card: data,
      error: x.status === 0 ? x.error : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ DNS rebinding (servers on this computer)

/**
 * Send the handshake that worked with a foreign Origin, then with a foreign Host. A server on this computer should
 * refuse both (403), so a web page can't reach it through DNS rebinding.
 * @param {Report} r a report where r.mcp is true
 * @param {ProbeOptions} [opts]
 * @returns {Promise<{origin: {accepted: boolean|null, status: number|null, error: string|null}, host: {accepted: boolean|null, status: number|null, error: string|null}}>}
 */
export async function rebindingTest(r, opts = {}) {
  const ctx = makeCtx(r.endpoint, opts);
  const modern = r.era === 'modern';
  const method = modern ? 'server/discover' : 'initialize';
  const params = modern ? { _meta: modernMeta(r.protocol_version || MODERN_VERSION) } : { protocolVersion: r.protocol_version || LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO };
  /** @type {Record<string, string>} */
  const pvHeaders = modern ? { 'MCP-Protocol-Version': r.protocol_version || MODERN_VERSION, 'Mcp-Method': method } : {};
  /** @param {{status: number, headers: Record<string, string>, body: string, contentType: string, id: number}} x */
  const verdict = (x) => {
    const reply = replyTo(x.body, x.contentType, x.id);
    const accepted = x.status >= 200 && x.status < 300 && Boolean(reply && reply.result);
    return accepted;
  };
  /** @param {string|undefined} sid @param {string} pv */
  const cleanup = async (sid, pv) => {
    if (sid && !modern) await endSession(ctx, r.endpoint, { era: 'legacy', pv, sid });
  };

  // 1. foreign Origin, through fetch
  const o = await rpc(ctx, r.endpoint, method, params, pvHeaders, { origin: FOREIGN_ORIGIN });
  const originRes = o.status === 0 ? { accepted: null, status: null, error: o.error } : { accepted: Boolean(o.reply && o.reply.result && o.status < 300), status: o.status, error: null };
  if (originRes.accepted) await cleanup(o.headers['mcp-session-id'], r.protocol_version || LEGACY_VERSIONS[0]);

  // 2. foreign Host: fetch won't send another Host, so node:http does it
  const id = ++nextId;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const u = new URL(r.endpoint);
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const hostRes = await new Promise((resolve) => {
    const req = send(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          Host: `mcp-tc-check.invalid${u.port ? `:${u.port}` : ''}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'User-Agent': USER_AGENT,
          'Content-Length': Buffer.byteLength(body),
          ...pvHeaders,
          ...ctx.userHeaders,
        },
        timeout: ctx.timeout,
        rejectUnauthorized: !isLoopback(u.hostname),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (text.length < 65536) text += c;
          const reply = replyTo(text, String(res.headers['content-type'] || ''), id);
          if (reply) res.destroy();
        });
        const finish = () => {
          const headers = /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)])));
          const accepted = verdict({ status: res.statusCode || 0, headers, body: text, contentType: headers['content-type'] || '', id });
          resolve({ accepted, status: res.statusCode || null, error: null, sid: headers['mcp-session-id'] });
        };
        res.on('end', finish);
        res.on('close', finish);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ accepted: null, status: null, error: txt(err.message, 200), sid: undefined }));
    req.end(body);
  });
  const hr = /** @type {{accepted: boolean|null, status: number|null, error: string|null, sid?: string}} */ (hostRes);
  if (hr.accepted) await cleanup(hr.sid, r.protocol_version || LEGACY_VERSIONS[0]);
  return redact({ origin: originRes, host: { accepted: hr.accepted, status: hr.status, error: hr.error } }, Object.values(ctx.userHeaders));
}

// ------------------------------------------------------------------ stdio (a local server, started the way a client starts it)

/**
 * Split a command line into words. Spaces separate words; single and double quotes group them; outside single quotes
 * a backslash escapes a quote, a backslash or a space (other backslashes stay, so Windows paths work). No shell runs
 * it, so pipes, redirects and variables mean nothing here.
 * @param {string} line
 * @returns {string[]}
 */
export function splitCommand(line) {
  /** @type {string[]} */
  const words = [];
  let cur = '';
  let has = false;
  /** @type {string|null} */
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (ch === '\\' && i + 1 < line.length && /["'\\\s]/.test(line[i + 1])) {
      cur += line[++i];
      has = true;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) words.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (quote) throw new UsageError('The command has an unclosed quote.', {}, 'invalid_command');
  if (cur || has) words.push(cur);
  return words;
}

/**
 * A command for display, quoted where a shell would need it.
 * @param {string[]} argv
 */
export function showCommand(argv) {
  return argv.map(shellWord).join(' ');
}

/** @param {string} w */
function shellWord(w) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/**
 * @typedef {object} StdioSession
 * @property {(method: string, params: Record<string, unknown>, ms?: number) => Promise<{reply: any, error: string|null}>} ask
 * @property {(obj: unknown) => void} write
 * @property {() => Promise<void>} stop close stdin; SIGTERM after 2 s, SIGKILL 2 s later
 * @property {() => {code: number|null, signal: string|null}|null} exited
 * @property {() => string} stderr the last 4,000 characters it wrote to stderr
 * @property {() => number} noise lines on stdout that were not JSON
 * @property {() => number} requests
 * @property {string|null} failed why it could not be started, or null
 */

/**
 * Start a local server and read its stdout as one JSON-RPC message per line. Requests the server sends are answered
 * (ping) or refused (anything else).
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string|undefined>, spawn?: typeof nodeSpawn, timeout: number, onReply?: () => void}} o
 * @returns {StdioSession}
 */
function startStdio(command, args, o) {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */
  let child = null;
  /** @type {string|null} */
  let failed = null;
  try {
    child = /** @type {any} */ ((o.spawn || nodeSpawn)(command, args, { cwd: o.cwd, env: { ...(o.env || process.env) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  } catch (err) {
    failed = `could not start ${txt(command, 200)}: ${txt(err instanceof Error ? err.message : String(err), 200)}`;
  }
  /** @type {Map<string, (m: any) => void>} */
  const waiters = new Map();
  /** @type {{code: number|null, signal: string|null}|null} */
  let exited = null;
  /** @type {Error|null} */
  let startError = null;
  let stderr = '';
  let buf = '';
  let noise = 0;
  let requests = 0;
  const wakeAll = () => {
    for (const w of waiters.values()) w(null);
  };
  /** @param {unknown} obj */
  const write = (obj) => {
    if (child && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify(obj)}\n`);
  };
  const exitP = new Promise((resolve) => {
    if (!child) return resolve(undefined);
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      wakeAll();
      resolve(undefined);
    });
  });
  if (child) {
    const c = child;
    c.on('error', (err) => {
      startError = err;
      wakeAll();
    });
    c.stdin.on('error', () => {}); // EPIPE when the process is gone
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          noise++;
          continue;
        }
        for (const msg of Array.isArray(m) ? m : [m]) {
          if (!msg || typeof msg !== 'object') continue;
          if (typeof msg.method === 'string') {
            // a request from the server: answer ping, refuse the rest (we offer no client features)
            if ('id' in msg) write({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }) });
            continue;
          }
          const w = waiters.get(String(msg.id));
          if (w) w(msg);
        }
      }
      if (buf.length > MAX_BYTES) buf = '';
    });
  }
  const gone = () => {
    if (failed) return failed;
    if (startError) {
      const code = /** @type {any} */ (startError).code;
      return code === 'ENOENT' ? `could not start ${txt(command, 200)}: command not found` : `could not start ${txt(command, 200)}: ${txt(startError.message, 200)}`;
    }
    if (exited) return `the process exited (${exited.signal ? `signal ${exited.signal}` : `code ${exited.code}`}) before answering`;
    return null;
  };
  return {
    failed,
    async ask(method, params, ms = o.timeout) {
      const stopped = gone();
      if (stopped) return { reply: null, error: stopped };
      const id = ++nextId;
      requests++;
      const p = /** @type {Promise<any>} */ (new Promise((resolve) => waiters.set(String(id), resolve)));
      write({ jsonrpc: '2.0', id, method, params });
      const m = await withTimeout(p, ms);
      waiters.delete(String(id));
      if (m && o.onReply) o.onReply();
      return { reply: m, error: m ? null : gone() || `no reply to ${method} within ${Math.round(ms / 1000)} s` };
    },
    write,
    async stop() {
      if (!child) return;
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      if (!exited && !startError) {
        await withTimeout(exitP, 2000);
        if (!exited) {
          child.kill('SIGTERM');
          await withTimeout(exitP, 2000);
          if (!exited) child.kill('SIGKILL');
        }
      }
    },
    exited: () => exited,
    stderr: () => stderr,
    noise: () => noise,
    requests: () => requests,
  };
}

/**
 * Start a local server and talk to it over stdin and stdout: 2026-07-28 style first (briefly, since older servers may
 * not answer anything before initialize), then initialize, then the lists. Messages are one JSON object per line.
 * Requests the server sends are answered (ping) or refused (anything else). At the end, stdin is closed; a server
 * that doesn't exit within 2 s gets SIGTERM, then SIGKILL.
 *
 * With bothEras, after the 2026-07-28 style worked, initialize is tried in a second, fresh process: a stdio server may
 * keep a connection in the protocol era of its first requests (the TypeScript SDK's serveStdio does), so asking for
 * the other era on the same connection would fail for a server that every client can use.
 * @param {string} command
 * @param {string[]} args
 * @param {ProbeOptions & {cwd?: string, env?: Record<string, string|undefined>, spawn?: typeof nodeSpawn}} [opts]
 * @returns {Promise<Report>}
 */
export async function probeStdio(command, args, opts = {}) {
  const shown = showCommand([command, ...args]);
  const r = emptyReport(shown, []);
  r.transport = 'stdio';
  r.stdio = { exit: null, stderr_tail: null, stdout_noise: 0 };
  const stdio = r.stdio;
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();
  const start = (/** @type {(() => void)|undefined} */ onReply) => startStdio(command, args, { cwd: opts.cwd, env: opts.env, spawn: opts.spawn, timeout, onReply });
  const main = start(() => {
    if (r.handshake_ms === null) r.handshake_ms = Date.now() - t0;
  });
  if (main.failed) {
    r.error = main.failed;
    r.ms = Date.now() - t0;
    return r;
  }
  /** @param {{reply: any, error: string|null}} a */
  const why = (a) => a.error || (a.reply && a.reply.error ? `JSON-RPC error ${a.reply.error.code}: ${txt(a.reply.error.message, 160) || 'no message'}` : 'no result');
  let legacyCheck = false;
  let requests = 0;

  try {
    let pv = MODERN_VERSION;
    let a = await main.ask('server/discover', { _meta: modernMeta(pv) }, Math.min(timeout, 5000));
    if (a.reply && a.reply.error && a.reply.error.code === -32022) {
      const data = a.reply.error.data || {};
      const sup = (Array.isArray(data.supported) ? data.supported : []).filter((/** @type {unknown} */ v) => typeof v === 'string' && DATE_RE.test(v) && v >= '2026-' && v !== pv);
      if (sup.length) {
        pv = sup.sort().reverse()[0];
        a = await main.ask('server/discover', { _meta: modernMeta(pv) }, Math.min(timeout, 5000));
      }
    }
    const dr = a.reply && a.reply.result;
    if (dr && Array.isArray(dr.supportedVersions)) {
      const sv = dr.supportedVersions.filter((/** @type {unknown} */ v) => typeof v === 'string').map((/** @type {string} */ v) => txt(v, 20));
      r.reachable = true;
      r.mcp = true;
      r.era = 'modern';
      r.protocol_version = sv.includes(pv) ? pv : sv[0] || pv;
      r.supported_versions = sv;
      r.server = normServerInfo((dr._meta && dr._meta[SI_META]) || dr.serverInfo);
      r.instructions = txt(dr.instructions, 4000, true);
      r.capabilities = capabilityNames(dr.capabilities);
      r.eras.modern = { ok: true, status: null, error: null, protocol_version: r.protocol_version };
      const modernAsk = /** @type {Ask} */ ((method, params) => main.ask(method, { ...params, _meta: modernMeta(/** @type {string} */ (r.protocol_version)) }));
      await collectLists(r, modernAsk, dr.capabilities, opts);
      legacyCheck = Boolean(opts.bothEras);
      return r;
    }
    r.eras.modern = { ok: false, status: null, error: why(a) };
    if (a.reply) r.reachable = true;
    const init = await main.ask('initialize', { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO });
    const res = init.reply && init.reply.result;
    if (!res || typeof res !== 'object' || (!res.serverInfo && !res.protocolVersion)) {
      r.eras.legacy = { ok: false, status: null, error: why(init) };
      if (init.reply) r.reachable = true;
      r.error = why(init);
      return r;
    }
    r.reachable = true;
    r.mcp = true;
    r.era = 'legacy';
    r.protocol_version = typeof res.protocolVersion === 'string' && DATE_RE.test(res.protocolVersion) ? res.protocolVersion : LEGACY_VERSIONS[0];
    r.supported_versions = [r.protocol_version];
    r.server = normServerInfo(res.serverInfo);
    r.instructions = txt(res.instructions, 4000, true);
    r.capabilities = capabilityNames(res.capabilities);
    r.eras.legacy = { ok: true, status: null, error: null, protocol_version: r.protocol_version };
    main.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await collectLists(r, main.ask, res.capabilities, opts);
    return r;
  } finally {
    await main.stop();
    stdio.exit = main.exited();
    stdio.stderr_tail = txt(main.stderr(), 1500, true) || null;
    stdio.stdout_noise = main.noise();
    requests += main.requests();
    if (legacyCheck) {
      // initialize as the first message of a fresh process, the way a client of the older protocol starts
      const fresh = start(undefined);
      if (fresh.failed) {
        r.eras.legacy = { ok: false, status: null, error: fresh.failed };
      } else {
        try {
          const init = await fresh.ask('initialize', { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO });
          const res = init.reply && init.reply.result;
          r.eras.legacy =
            res && (res.serverInfo || res.protocolVersion)
              ? { ok: true, status: null, error: null, protocol_version: txt(res.protocolVersion, 20) }
              : { ok: false, status: null, error: why(init) };
          if (r.eras.legacy.ok) fresh.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
        } finally {
          await fresh.stop();
          requests += fresh.requests();
        }
      }
    }
    r.requests = requests;
    r.ms = Date.now() - t0;
  }
}
