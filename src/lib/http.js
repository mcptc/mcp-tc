// HTTP for every command: global fetch with our User-Agent, a timeout, a size cap, and polite handling of 429.
//
// 429: honour Retry-After (seconds or an HTTP date); without it, wait 10 s and double each time, plus jitter (mcp.tc's
// /AGENTS.md asks for 10 s when the header is missing). At most 4 attempts and 60 s of waiting in total, then a
// rate_limited error (exit 4). A Retry-After longer than what is left of the 60 s ends the retries at once.
// Cloudflare refusals (403 with a Cloudflare page, error 1010, a challenge) are reported as such, never worked around.
import { CliError, EXIT, UsageError } from './errors.js';
import { USER_AGENT } from '../version.js';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_ATTEMPTS = 4;
export const MAX_WAIT_MS = 60_000;
/** Wait after a 429 without Retry-After, doubled on each further try. */
export const DEFAULT_RETRY_MS = 10_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string|Uint8Array} [body]
 * @property {unknown} [json] sent as the body with Content-Type: application/json
 * @property {number} [timeout] ms for the whole exchange, body included (default 20 s)
 * @property {'follow'|'manual'} [redirect] 'manual' returns 3xx answers with their Location
 * @property {number} [maxAttempts] 429 retries included (default 4; 1 = no retry)
 * @property {boolean} [return429] return a 429 answer to the caller instead of retrying or throwing (for requests that
 *   must not be repeated automatically, like POST /submit, whose caller reads the body to decide)
 * @property {number} [maxWait] ms of waiting for 429s in total (default 60 s)
 * @property {boolean} [readBody] false: don't download the body (status and headers only)
 * @property {number} [maxBytes] refuse bodies larger than this (default 10 MB)
 * @property {boolean} [detectBlock] report Cloudflare refusals as "blocked" (default true)
 * @property {AbortSignal} [signal]
 * @property {(ms: number) => Promise<void>} [sleep] for tests
 * @property {() => number} [random] for tests
 * @property {(info: {host: string, attempt: number, maxAttempts: number, waitMs: number}) => void} [onRetry]
 */

/**
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {boolean} ok
 * @property {Headers} headers
 * @property {string} url
 * @property {string} text body as text ('' when readBody is false)
 * @property {() => any} json parse the body; throws a bad_response CliError
 */

/** @param {number} ms */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Milliseconds to wait from a Retry-After value, or null when absent or unreadable.
 * @param {string|null|undefined} value
 * @param {number} [now] ms since the epoch
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Wait before retry number `attempt` (1-based) when the server gave no Retry-After: 10 s, 20 s, 40 s, plus up to 25%.
 * @param {number} attempt
 * @param {() => number} [random]
 */
export function backoffDelay(attempt, random = Math.random) {
  const base = DEFAULT_RETRY_MS * 2 ** (attempt - 1);
  return Math.round(base + random() * base * 0.25);
}

/**
 * One HTTP exchange with retries on 429. Never throws for other HTTP statuses: callers decide what a 404 means.
 * @param {string|URL} url
 * @param {RequestOptions} [opts]
 * @returns {Promise<HttpResponse>}
 */
export async function request(url, opts = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new UsageError(`Not a valid URL: ${String(url)}`, {}, 'invalid_url');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new UsageError(`Only http and https URLs are supported, not ${target.protocol}`, {}, 'invalid_url');
  }
  const host = target.host;
  const sleep = opts.sleep || realSleep;
  const random = opts.random || Math.random;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
  const maxWait = opts.maxWait ?? MAX_WAIT_MS;
  let waited = 0;

  for (let attempt = 1; ; attempt++) {
    const res = await once(target, opts);
    if (res.status !== 429 || opts.return429) {
      if (opts.detectBlock !== false) checkBlocked(res, host);
      return res;
    }
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const left = maxWait - waited;
    const seconds = retryAfter !== null ? Math.ceil(retryAfter / 1000) : null;
    if (attempt >= maxAttempts || left <= 0 || (retryAfter !== null && retryAfter > left)) {
      throw new CliError(
        'rate_limited',
        `${host} is limiting requests from your address (HTTP 429)${seconds !== null ? `: try again in ${seconds} s` : ''}. Wait a little and run the command again.`,
        EXIT.RATE_LIMITED,
        { host, attempts: attempt, retry_after: seconds },
      );
    }
    let wait = retryAfter !== null ? retryAfter + Math.round(random() * 250) : backoffDelay(attempt, random);
    wait = Math.min(wait, left);
    if (opts.onRetry) opts.onRetry({ host, attempt, maxAttempts, waitMs: wait });
    await sleep(wait);
    waited += wait;
  }
}

/**
 * Like request(), with Accept: application/json, and `data` = the parsed body (null when empty or not JSON).
 * @param {string|URL} url
 * @param {RequestOptions} [opts]
 * @returns {Promise<HttpResponse & {data: any}>}
 */
export async function requestJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  let data = null;
  if (res.text.trim() !== '') {
    try {
      data = JSON.parse(res.text);
    } catch {
      data = null;
    }
  }
  return { ...res, data };
}

/**
 * @param {URL} target
 * @param {RequestOptions} opts
 * @returns {Promise<HttpResponse>}
 */
async function once(target, opts) {
  const host = target.host;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeout);
  const signal = opts.signal ? anySignal([ctl.signal, opts.signal]) : ctl.signal;
  /** @type {Record<string, string>} */
  const headers = { ...(opts.headers || {}) };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'user-agent') delete headers[k];
  headers['User-Agent'] = USER_AGENT;
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  try {
    const res = await fetch(target, { method: opts.method || 'GET', headers, body, redirect: opts.redirect || 'follow', signal });
    let text = '';
    if (opts.readBody === false || (opts.method || 'GET').toUpperCase() === 'HEAD') {
      await res.body?.cancel().catch(() => {});
    } else {
      text = await readText(res, opts.maxBytes ?? DEFAULT_MAX_BYTES, host);
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      url: res.url || target.href,
      text,
      json() {
        try {
          return JSON.parse(text);
        } catch {
          throw new CliError('bad_response', `${host} sent an answer that is not valid JSON (HTTP ${res.status}).`, EXIT.ERROR, { host, status: res.status });
        }
      },
    };
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (timedOut) {
      throw new CliError('timeout', `${host} did not answer within ${Math.round(timeout / 1000)} s.`, EXIT.ERROR, { host });
    }
    if (opts.signal && opts.signal.aborted) {
      throw new CliError('cancelled', 'Cancelled.', EXIT.ERROR, { host });
    }
    throw networkError(err, host);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A signal that aborts when any of these does (AbortSignal.any is missing before Node 20.3).
 * @param {AbortSignal[]} signals
 */
function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort();
      break;
    }
    s.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  return ctl.signal;
}

/**
 * Read the body as UTF-8 text, refusing more than maxBytes.
 * @param {Response} res
 * @param {number} maxBytes
 * @param {string} host
 */
async function readText(res, maxBytes, host) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new CliError('response_too_large', `${host} sent more than ${Math.round(maxBytes / 1024)} KB; stopped reading.`, EXIT.ERROR, { host });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Throw "blocked" for a Cloudflare refusal page.
 * @param {HttpResponse} res
 * @param {string} host
 */
export function checkBlocked(res, host) {
  if (res.status !== 403) return;
  const h = res.headers;
  const cloudflare = h.get('cf-ray') !== null || /cloudflare/i.test(h.get('server') || '');
  if (!cloudflare) return;
  const code = /error code:?\s*(10\d\d)/i.exec(res.text) || /Error\s*(10\d\d)/.exec(res.text);
  const challenge = h.get('cf-mitigated') !== null;
  const html = /text\/html/i.test(h.get('content-type') || '');
  if (!code && !challenge && !html) return;
  const what = code ? `Cloudflare error ${code[1]}` : challenge ? 'a Cloudflare challenge' : 'a Cloudflare error page';
  throw new CliError(
    'blocked',
    `${host} refused the request with ${what} (HTTP 403). mcp-tc does not try to get around this. Try again later, and if it keeps happening, open an issue at https://github.com/mcptc/mcp-tc/issues.`,
    EXIT.ERROR,
    { host, status: 403, cloudflare_error: code ? Number(code[1]) : null, ray: h.get('cf-ray') },
  );
}

/**
 * A fetch failure as a CliError naming the host.
 * @param {any} err
 * @param {string} host
 */
export function networkError(err, host) {
  let cause = err && err.cause;
  if (cause && Array.isArray(cause.errors) && cause.errors.length) cause = cause.errors[0];
  const code = String((cause && (cause.code || cause.name)) || (err && err.code) || '');
  let message;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') {
    message = `Could not find ${host}: the DNS lookup failed. Check the address and your connection.`;
  } else if (code === 'ECONNREFUSED') {
    message = `${host} refused the connection.`;
  } else if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') {
    message = `The connection to ${host} was closed unexpectedly.`;
  } else if (/TIMEOUT|ETIMEDOUT/.test(code)) {
    message = `Could not connect to ${host} in time.`;
  } else if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    message = `The TLS certificate of ${host} was not accepted (${code}).`;
  } else {
    message = `Could not reach ${host}${code ? ` (${code})` : ''}.`;
  }
  return new CliError('network_error', message, EXIT.ERROR, { host, cause: code || null });
}
