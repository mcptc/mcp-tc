// What the person typed on the command line: a listing to look up on mcp.tc (a slug, a name or an mcp.tc listing
// link) or a server URL to connect to. Shared by info, doctor and check.
//
// Only text shaped like a slug or a listing name is ever sent to mcp.tc. Anything with the characters of a URL, a
// credential or a key=value pair (@ / \ ? = : # %), and anything that looks like a key or a token, never leaves this
// computer as a listing name: it is read as a URL (doctor, check), so the URL checks refuse a user name and password
// locally, or it is refused before any request (info).
import { parseListingRef } from './directory.js';
import { UsageError } from './errors.js';
import { isLoopback } from './mcp.js';

/** The longest listing name or slug sent to mcp.tc. */
export const MAX_QUERY = 200;
// characters that belong to URLs, credentials and key=value pairs, never to a slug or a listing name
const URL_CHARS = /[@/\\?=:#%<>"`{}[\]|^$~]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// a slug: lowercase words joined by hyphens
const SLUG_WORDS = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * Does this look like a key or a token rather than a name? One word of 20 characters or more that mixes letters and
 * digits (and is not lowercase words joined by hyphens, which is how slugs look), or a UUID.
 * @param {string} s
 */
export function looksLikeSecret(s) {
  if (UUID.test(s)) return true;
  if (/\s/.test(s) || s.length < 20) return false;
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return false;
  return !SLUG_WORDS.test(s);
}

/**
 * The slug or name to send to get_server, from what the person typed. A listing link gives its slug. Anything that is
 * not shaped like a slug or a name throws a UsageError before any request, and the error does not repeat the input
 * (it may hold a credential).
 * @param {string} input
 * @param {string} [base] mcp.tc base URL, whose host also counts for listing links
 * @returns {{slug: string, lang: string|null, link: boolean}}
 */
export function listingQuery(input, base) {
  const s = String(input ?? '').trim();
  const ref = parseListingRef(s, base);
  if (ref.link) return ref;
  if (!s || s.length > MAX_QUERY || URL_CHARS.test(s) || CONTROL.test(s) || looksLikeSecret(s)) {
    throw new UsageError(
      "That doesn't look like a listing slug, name or link, so it was not sent to mcp.tc. Give a slug (notion), a name (\"Hugging Face\") or a listing link (https://mcp.tc/i/notion).",
      {},
      'invalid_listing',
    );
  }
  return ref;
}

/**
 * What the input is, without checking a name: a listing link, a URL (with a scheme added to a bare host), or a
 * listing slug or name. Text with a user name, a path, a query or a scheme counts as a URL, so it is checked as one.
 * @param {string} input
 * @param {string} base mcp.tc base URL
 * @returns {{kind: 'url', url: string} | {kind: 'listing', slug: string, link: boolean}}
 */
export function classifyTarget(input, base) {
  const s = String(input ?? '').trim();
  const ref = parseListingRef(s, base);
  if (ref.link) return { kind: 'listing', slug: ref.slug, link: true };
  if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
  if (!/\s/.test(s)) {
    // another scheme: normalizeEndpoint() says which schemes work
    if (s.includes('://')) return { kind: 'url', url: s };
    const host = /^([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d+)?(?:[/?#]|$)/i.exec(s);
    if (host && (host[1].includes('.') || host[2] || s.includes('/') || isLoopback(host[1]))) {
      return { kind: 'url', url: `${isLoopback(host[1]) ? 'http' : 'https'}://${s}` };
    }
    // user:password@host/..., a path or a query without a scheme: a URL, so its credentials are refused locally
    if (/[@/?=]/.test(s)) return { kind: 'url', url: `https://${s}` };
  }
  return { kind: 'listing', slug: s, link: false };
}

/**
 * A URL to connect to, or a listing to look up first, with the name checked by listingQuery(): what doctor uses.
 * @param {string} input
 * @param {string} base mcp.tc base URL
 * @returns {{kind: 'url', url: string} | {kind: 'listing', slug: string}}
 */
export function resolveTarget(input, base) {
  const t = classifyTarget(input, base);
  if (t.kind === 'url') return t;
  return { kind: 'listing', slug: t.link ? t.slug : listingQuery(t.slug, base).slug };
}
