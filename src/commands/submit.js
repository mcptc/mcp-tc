// mcp-tc submit: suggest a server to mcp.tc, then follow its status until it is listed, waits for a person's review,
// is not accepted, or --wait runs out. It uses the JSON form of the site's Submit page (https://mcp.tc/docs/api#submit):
// the same checks and the same limits as the form, with no account.
//
// What submit sends to mcp.tc (copy for the README):
//   - POST /submit with {"url": "...", "note": "..."} (the note only when you give one), Content-Type and Accept
//     application/json, and mcp-tc's User-Agent. No cookies, no Origin header, nothing from your config files.
//   - Before sending, the URL loses a user name and password, its #fragment, and every query parameter that looks
//     like a key or a token; mcp-tc shows what it removed. A URL whose path looks like it holds a key or an account
//     ID is not sent at all. The note is cut to 500 characters, the most mcp.tc keeps.
//   - Then GET /s/{token}.json, the suggestion's status, every 5 seconds for the first minute and every 10 seconds
//     after that, until the suggestion is finished or --wait runs out.
// mcp.tc checks the URL and the note automatically, including with an AI model, and a person may review them.
// Sending a suggestion doesn't mean the server will be listed.
//
// Limits: a 429 for the daily limits (scope ip_day or global_day) is never retried: submit reports the wait and exits
// 4. A 429 for the hourly limit (ip_hour), or one without mcp.tc's JSON body (a burst limit), is tried once more, and
// only when the wait is 60 seconds or less (10 seconds when the answer gives none). A 422 (mcp.tc can't take this URL)
// is never retried, and the suggestion is never sent twice otherwise.
import { isPrivateHost, looksLikeToken } from '../lib/clients.js';
import { parseListingRef } from '../lib/directory.js';
import { CliError, EXIT, UsageError } from '../lib/errors.js';
import { parseRetryAfter, request } from '../lib/http.js';
import { secretsInUrl } from '../lib/mcp.js';
import { clean } from '../lib/output.js';
import { confirm } from '../lib/prompt.js';

/** The longest note mcp.tc keeps. */
export const NOTE_MAX = 500;
/** The longest URL mcp.tc accepts. */
export const URL_MAX = 2048;
export const DEFAULT_WAIT_MS = 10 * 60_000;
export const MAX_WAIT_MS = 60 * 60_000;
/** Status checks: every 5 s for the first minute, then every 10 s (mcp.tc's docs ask for 5 to 10 s). */
export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 10_000;
const FAST_PHASE_MS = 60_000;
/** Wait after a 429 that names no time (a burst limit). */
const BURST_WAIT_S = 10;
/** A 429 on the suggestion itself is tried again only when its wait is this short. */
const MAX_RETRY_WAIT_S = 60;
const POST_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 20_000;
/** Status reads that may fail in a row (network, 5xx) before submit gives up. */
const MAX_STATUS_FAILURES = 3;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const RUNNING = Object.freeze(['queued', 'checking', 'reviewing']);
const FINAL = Object.freeze(['listed', 'duplicate', 'pending', 'rejected', 'error']);

export const REVIEW_NOTE =
  "mcp.tc checks the URL and the note automatically, including with an AI model, and a person may review them. Sending a suggestion doesn't mean the server will be listed. Leave personal data out of the note.";

/** Clock and sleep, replaceable in tests. */
export const timing = {
  now: () => Date.now(),
  /** @param {number} ms */
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'submit',
  summary: 'Suggest a server to mcp.tc and wait for the result',
  usage: 'submit <url> [--note <text>] [--wait <duration>] [--no-wait] [--yes]',
  description: [
    "Sends a server's address to mcp.tc, like the Submit page on the site, then follows the suggestion until the server is listed, waits for a person's review, is not accepted, or --wait runs out.",
    '<url> is a remote MCP endpoint (https), a GitHub or GitLab repository, an npm or PyPI page, or an official MCP Registry name; npm:<package> and pypi:<package> stand for the package page.',
    'Before sending, mcp-tc removes a user name and password, a #fragment and query parameters that look like keys, shows what it will send, and in a terminal asks first (--yes skips the question).',
    REVIEW_NOTE,
  ].join(' '),
  args: [{ name: 'url', required: true }],
  options: {
    note: {
      type: 'string',
      valueName: 'text',
      description: 'A note for the person who reviews it, up to 500 characters, such as who runs the server. No personal data.',
    },
    wait: {
      type: 'string',
      valueName: 'duration',
      description: 'How long to follow the status: 30s, 5m, 1h or a number of seconds (default 10m, at most 1h)',
    },
    'no-wait': { type: 'boolean', description: 'Stop once mcp.tc has queued it; its status page keeps updating' },
    yes: { type: 'boolean', short: 'y', description: 'Send without asking' },
  },
  examples: [
    'mcp-tc submit https://mcp.example.com/mcp',
    'mcp-tc submit https://github.com/example/weather-mcp --note "The official server of Example."',
    'mcp-tc submit npm:@example/weather-mcp --wait 5m',
    'mcp-tc submit https://mcp.example.com/mcp --yes --no-wait --json',
  ],
  exits: [
    [0, 'listed or already listed (with --no-wait: queued)'],
    [1, 'any other error, including a check mcp.tc could not finish, or Ctrl+D at the question'],
    [4, 'rate limited by mcp.tc'],
    [10, "waiting for a person's review"],
    [11, 'not accepted (the review said no, or mcp.tc refused the URL)'],
    [12, '--wait ran out while it was still being checked'],
    [130, 'Ctrl+C at the question: nothing was sent'],
  ],
};

// ------------------------------------------------------------------ what to send

const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const REGISTRY_NAME = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
/** First labels of reverse-DNS registry namespaces (io.github.you/server, com.example/server). */
const NAMESPACE_TLDS = new Set(
  'io com net org ai dev app co me sh xyz tech cloud info biz us uk de fr it eu jp in ca au tv gg run tools page site so systems software studio inc ac is to fm lol'.split(' '),
);
/** Query parameter names that carry keys, tokens or signatures. Generous: a removed harmless parameter costs little. */
const SECRET_PARAM = /key|token|secret|auth|pass|pwd|session|sig|cred|bearer|jwt|^code$|^pat$|^k$|^t$/i;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const CODE_HOSTS = new Set(['github.com', 'www.github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'www.npmjs.com', 'npmjs.com', 'pypi.org']);

/**
 * @typedef {{code: string, message: string, parameters?: string[]}} Change
 * @typedef {{url: string, kind: 'url'|'registry_name', changes: Change[]}} Prepared
 */

/**
 * The address to send for what the person typed. Throws a UsageError for input mcp.tc can't take, before anything is
 * sent: no URL that is private, has a key in its path, or isn't http(s).
 * @param {unknown} input
 * @returns {Prepared}
 */
export function prepareUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new UsageError('Missing <url>. Usage: mcp-tc submit <url>', { argument: 'url' }, 'missing_url');
  if (/\s/.test(s)) {
    throw new UsageError('Give one address, without spaces. Example: mcp-tc submit https://mcp.example.com/mcp', {}, 'invalid_url');
  }
  /** @type {Change[]} */
  const changes = [];
  const short = /^(npm|pypi):(.*)$/i.exec(s);
  if (short) return packagePage(short[1].toLowerCase() === 'npm' ? 'npm' : 'pypi', short[2]);

  let withScheme = s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (REGISTRY_NAME.test(s) && isNamespace(s.split('/')[0])) {
      if (s.length > 200) throw new UsageError('That registry name is too long (200 characters at most).', {}, 'too_long');
      return { url: s, kind: 'registry_name', changes };
    }
    const hostPart = s.replace(/[/?#].*$/, '');
    const hostLike = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(hostPart) && (hostPart.includes('.') || /:\d/.test(hostPart) || /^localhost$/i.test(hostPart));
    if (!hostLike) {
      const shown = clean(s, { oneLine: true }).slice(0, 100);
      throw new UsageError(
        /^@?[a-z0-9._~/-]+$/i.test(s)
          ? `"${shown}" is not a URL. For a package, write npm:${shown} or pypi:${shown}; otherwise give the server's https URL or its repository's.`
          : `"${shown}" is not a URL. Give the server's https URL, or its repository's, like https://github.com/owner/repo.`,
        {},
        'invalid_url',
      );
    }
    withScheme = `https://${s}`;
    changes.push({ code: 'added_https', message: 'Added https:// in front.' });
  }
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    throw new UsageError(`Not a valid URL: ${clean(s, { oneLine: true }).slice(0, 200)}`, {}, 'invalid_url');
  }
  if (u.protocol === 'http:') {
    u.protocol = 'https:';
    changes.push({ code: 'https', message: 'Changed http:// to https://: mcp.tc reads servers over https.' });
  } else if (u.protocol !== 'https:') {
    throw new UsageError(`mcp.tc takes https URLs, not ${clean(u.protocol, { oneLine: true })} ones. Give the server's https URL, or its repository's.`, {}, 'invalid_url');
  }
  if (/^(www\.)?mcp\.tc$/i.test(u.hostname)) {
    // a listing link is a page about a server that is already listed, never the server itself
    const ref = parseListingRef(u.href);
    throw new UsageError(
      ref.link
        ? `That's the mcp.tc page of a server that is already listed. See it with: mcp-tc info ${ref.slug}`
        : "That's an mcp.tc address, not an MCP server. Give the server's own https URL, or its repository's.",
      ref.link ? { slug: ref.slug } : {},
      'mcptc_link',
    );
  }
  if (!u.hostname || isPrivateHost(u.hostname)) {
    throw new UsageError(
      `${clean(u.hostname || s, { oneLine: true })} is not a public address, so mcp.tc can't reach it. Put the server online first, or suggest its repository or package page.`,
      {},
      'not_public',
    );
  }
  if (u.username || u.password) {
    u.username = '';
    u.password = '';
    changes.push({ code: 'credentials_removed', message: 'Removed the user name and password.' });
  }
  if (u.hash) {
    u.hash = '';
    changes.push({ code: 'fragment_removed', message: 'Removed the #fragment.' });
  }
  const secretNames = [...new Set([...u.searchParams].filter(([k, v]) => secretParam(k, v)).map(([k]) => k))];
  if (secretNames.length) {
    for (const k of secretNames) u.searchParams.delete(k);
    const names = secretNames.map((k) => `"${clean(k, { oneLine: true }).slice(0, 40)}"`).join(', ');
    changes.push({
      code: 'query_removed',
      message: `Removed the query ${secretNames.length === 1 ? 'parameter' : 'parameters'} ${names}, which can hold a key or a token.`,
      parameters: secretNames,
    });
  }
  // on code hosts and package registries the path holds names, not keys
  if (!CODE_HOSTS.has(u.hostname) && secretsInUrl(u.href).some((f) => f.where === 'path')) {
    throw new UsageError(
      "This looks like a personal server URL: part of its path looks like a key or an account ID. Nothing was sent. Suggest the server's public URL or its repository instead, and keep yours private.",
      {},
      'personal_url',
    );
  }
  const url = u.pathname === '/' && !u.search ? u.origin : u.href;
  if (url.length > URL_MAX) throw new UsageError(`That URL is too long (${URL_MAX} characters at most).`, {}, 'too_long');
  return { url, kind: 'url', changes };
}

/**
 * npm:<name> and pypi:<name> as the package's page, without a version.
 * @param {'npm'|'pypi'} registry
 * @param {string} raw
 * @returns {Prepared}
 */
function packagePage(registry, raw) {
  let name = raw.trim();
  if (registry === 'npm') {
    name = name.startsWith('@') ? name.replace(/^(@[^/@]+\/[^@]+)@.*$/, '$1') : name.replace(/@.*$/, '');
    if (!NPM_NAME.test(name) || name.length > 214) {
      throw new UsageError(`"${clean(raw, { oneLine: true }).slice(0, 100)}" is not an npm package name. Example: npm:@example/weather-mcp`, {}, 'invalid_package');
    }
    return {
      url: `https://www.npmjs.com/package/${name}`,
      kind: 'url',
      changes: [{ code: 'npm_page', message: `Sending the npm page of ${name}.` }],
    };
  }
  name = name.replace(/(\[|==|>=|<=|~=|!=|>|<).*$/, '');
  if (!PYPI_NAME.test(name) || name.length > 200) {
    throw new UsageError(`"${clean(raw, { oneLine: true }).slice(0, 100)}" is not a PyPI package name. Example: pypi:weather-mcp`, {}, 'invalid_package');
  }
  return {
    url: `https://pypi.org/project/${name}/`,
    kind: 'url',
    changes: [{ code: 'pypi_page', message: `Sending the PyPI page of ${name}.` }],
  };
}

/** @param {string} ns */
function isNamespace(ns) {
  const labels = ns.toLowerCase().split('.');
  return labels.length >= 2 && labels.every((l) => /^[a-z0-9-]+$/.test(l)) && NAMESPACE_TLDS.has(labels[0]);
}

/**
 * @param {string} name
 * @param {string} value
 */
function secretParam(name, value) {
  return SECRET_PARAM.test(name) || looksLikeToken(value) || UUID.test(value);
}

/**
 * The note as it will be sent: control characters removed, at most NOTE_MAX characters. Null when empty.
 * @param {unknown} raw
 * @returns {{text: string|null, cut: boolean, length: number}}
 */
export function prepareNote(raw) {
  if (raw === undefined || raw === null) return { text: null, cut: false, length: 0 };
  const text = clean(String(raw).replace(/\r\n?/g, '\n')).trim();
  const chars = [...text];
  if (!chars.length) return { text: null, cut: false, length: 0 };
  if (chars.length <= NOTE_MAX) return { text, cut: false, length: chars.length };
  return { text: chars.slice(0, NOTE_MAX).join('').trimEnd(), cut: true, length: chars.length };
}

/**
 * --wait as milliseconds: "30s", "5m", "1h", "1h30m" or plain seconds. 0 means don't wait.
 * @param {unknown} raw
 */
export function parseDuration(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  let ms = null;
  if (/^\d{1,7}$/.test(s)) {
    ms = Number(s) * 1000;
  } else {
    const m = /^(?:(\d{1,3})h)?(?:(\d{1,5})m)?(?:(\d{1,7})s)?$/.exec(s);
    if (m && (m[1] || m[2] || m[3])) ms = ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
  }
  if (ms === null) {
    throw new UsageError(`--wait takes a duration like 30s, 5m or 1h, or a number of seconds, not "${clean(raw, { oneLine: true }).slice(0, 40)}".`, { option: 'wait' });
  }
  if (ms > MAX_WAIT_MS) throw new UsageError('--wait can be 1h at most.', { option: 'wait' });
  return ms;
}

/**
 * A duration for people: "10m", "1m30s", "45s".
 * @param {number} ms
 */
export function formatDuration(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s || (!h && !m) ? `${s}s` : ''}`;
}

/**
 * A wait in seconds as words, rounded the way people say it.
 * @param {number} seconds
 */
function inWords(seconds) {
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  const h = Math.ceil(seconds / 3600);
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------ run

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const prepared = prepareUrl(ctx.positionals[0]);
  if (ctx.args.wait !== undefined && ctx.args['no-wait']) throw new UsageError('Use --wait or --no-wait, not both.');
  const waitMs = ctx.args['no-wait'] ? 0 : ctx.args.wait !== undefined ? parseDuration(ctx.args.wait) : DEFAULT_WAIT_MS;
  const note = prepareNote(ctx.args.note);
  const base = ctx.base;
  const host = new URL(base).host;
  const changes = [...prepared.changes];
  if (note.cut) {
    ctx.out.warn(`The note has ${note.length} characters; mcp.tc keeps ${NOTE_MAX}, so only the first ${NOTE_MAX} are sent.`);
    changes.push({ code: 'note_cut', message: `Cut the note to ${NOTE_MAX} characters.` });
  }
  const sent = { url: prepared.url, kind: prepared.kind, note: note.text };

  const ask = !ctx.args.yes;
  // without a terminal there is nobody to ask: say so before printing anything
  if (ask && !ctx.stdin.isTTY) await confirm('', { stdin: ctx.stdin, stderr: ctx.stderr });
  const preview = previewText(ctx.out, host, sent, changes);
  if (ask) ctx.stderr.write(`${preview}\n`);
  else ctx.out.info(preview);
  if (ask) {
    const ok = await (ctx.confirm || confirm)(`Send this suggestion to ${host}?`, { stdin: ctx.stdin, stderr: ctx.stderr });
    if (!ok) throw new CliError('cancelled', 'Cancelled: nothing was sent.', EXIT.ERROR);
  }

  const { res, data } = await post(ctx, base, sent);
  const result = {
    sent,
    changes,
    state: /** @type {string} */ ('queued'),
    terminal: false,
    timed_out: false,
    waited_seconds: 0,
    token: /** @type {string|null} */ (null),
    status_url: /** @type {string|null} */ (null),
    page: /** @type {string|null} */ (null),
    existing_submission: false,
    listing: /** @type {{slug: string, name: string|null, link: string}|null} */ (null),
    status: /** @type {Record<string, unknown>|null} */ (null),
  };

  if (res.status === 200 && data && data.ok === true && data.state === 'duplicate') {
    const l = data.listing && typeof data.listing === 'object' ? data.listing : {};
    result.state = 'duplicate';
    result.terminal = true;
    result.listing = listingFrom(l.link, l.name, base, l.slug);
    ctx.out.print(`Sent to ${host}: ${sent.url}`);
    return finish(ctx, result);
  }
  if (!(res.status === 202 && data && data.ok === true && typeof data.token === 'string' && TOKEN_RE.test(data.token))) {
    throw answerError(res, data, host, base);
  }

  const token = data.token;
  result.token = token;
  result.status_url = `${base}/s/${token}.json`;
  result.page = `${base}/s/${token}`;
  result.existing_submission = data.existing_submission === true;
  ctx.out.print(`Sent to ${host}: ${sent.url}`);
  ctx.out.print(`Status page: ${result.page}`);
  if (result.existing_submission) ctx.out.info('This URL was already waiting to be checked, so this follows that suggestion.');
  if (waitMs === 0) return finish(ctx, result);

  ctx.out.info(`Waiting up to ${formatDuration(waitMs)} for the result. Ctrl+C stops waiting; the check goes on, and the status page keeps updating.`);
  let f;
  try {
    f = await follow(ctx, base, token, waitMs);
  } catch (err) {
    // the suggestion was sent: keep its token in the error so a script can follow it
    if (err instanceof CliError) {
      err.details = { ...err.details, token, status_url: result.status_url, page: result.page };
    }
    throw err;
  }
  result.waited_seconds = Math.round(f.waitedMs / 1000);
  if (f.status) {
    result.status = f.status;
    result.state = String(f.status.state);
    if (typeof f.status.link === 'string') result.listing = listingFrom(f.status.link, f.status.name, base);
  }
  result.terminal = !f.timedOut && Boolean(f.status);
  result.timed_out = f.timedOut;
  return finish(ctx, result, waitMs);
}

/**
 * Set the exit code for the outcome and return the result.
 * @param {any} ctx
 * @param {any} result
 * @param {number} [waitMs]
 */
function finish(ctx, result, waitMs = 0) {
  if (result.timed_out) ctx.setExitCode(EXIT.WAIT_TIMEOUT);
  else if (result.state === 'pending') ctx.setExitCode(EXIT.WAITING);
  else if (result.state === 'rejected') ctx.setExitCode(EXIT.NOT_ACCEPTED);
  else if (result.terminal && result.state !== 'listed' && result.state !== 'duplicate') ctx.setExitCode(EXIT.ERROR);
  Object.defineProperty(result, '__wait', { value: waitMs, enumerable: false });
  return result;
}

/**
 * What will be sent, for people (stderr).
 * @param {import('../lib/output.js').Output} out
 * @param {string} host
 * @param {{url: string, kind: string, note: string|null}} sent
 * @param {Change[]} changes
 */
function previewText(out, host, sent, changes) {
  const lines = [`mcp-tc will send this suggestion to ${host}:`];
  lines.push(
    out.fields(
      [
        ['URL', sent.kind === 'registry_name' ? `${sent.url} (an MCP Registry name; add https:// if you meant a web address)` : sent.url],
        ['Note', sent.note ?? '(none)'],
      ],
      // the preview always goes to stderr, so it takes stderr's colors
      { indent: 2, stderr: true },
    ),
  );
  for (const c of changes) lines.push(out.paragraph(c.message, { indent: 2 }));
  lines.push(out.paragraph(REVIEW_NOTE));
  return lines.join('\n');
}

// ------------------------------------------------------------------ the suggestion

/**
 * POST /submit once (twice at most, after a short 429). Never repeats it after any other answer.
 * @param {any} ctx
 * @param {string} base
 * @param {{url: string, note: string|null}} sent
 * @returns {Promise<{res: import('../lib/http.js').HttpResponse, data: any}>}
 */
async function post(ctx, base, sent) {
  const host = new URL(base).host;
  const body = JSON.stringify(sent.note ? { url: sent.url, note: sent.note } : { url: sent.url });
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await request(`${base}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        redirect: 'manual',
        return429: true,
        timeout: POST_TIMEOUT_MS,
        maxBytes: 256 * 1024,
      });
    } catch (err) {
      if (err instanceof CliError && (err.code === 'timeout' || (err.code === 'network_error' && /closed unexpectedly/.test(err.message)))) {
        err.message += ` It is not clear whether ${host} received the suggestion. Sending the same URL again is safe: one that is already waiting gets the same status page.`;
      }
      throw err;
    }
    const data = jsonObject(res.text);
    if (res.status !== 429) return { res, data };

    const scope = data && typeof data.scope === 'string' ? data.scope : null;
    const ra = parseRetryAfter(res.headers.get('retry-after'));
    let seconds = ra !== null ? Math.ceil(ra / 1000) : null;
    if (seconds === null && data && Number.isInteger(data.retry_after) && data.retry_after >= 0) seconds = data.retry_after;
    const daily = scope === 'ip_day' || scope === 'global_day';
    const wait = seconds ?? BURST_WAIT_S;
    if (!daily && attempt === 1 && wait <= MAX_RETRY_WAIT_S) {
      ctx.out.info(`${host} is limiting requests (HTTP 429). Trying once more in ${wait} s.`);
      await timing.sleep(wait * 1000 + Math.round(Math.random() * 250));
      continue;
    }
    const said = data && typeof data.message === 'string' ? clean(data.message, { oneLine: true }).slice(0, 300) : '';
    throw new CliError(
      'rate_limited',
      said
        ? `${said}${seconds !== null ? ` ${host} asks to wait ${inWords(seconds)}.` : ''}`
        : `${host} is limiting suggestions from your address (HTTP 429). ${seconds !== null ? `Try again in ${inWords(seconds)}.` : 'Wait a little and try again.'}`,
      EXIT.RATE_LIMITED,
      { host, status: 429, scope, retry_after: seconds },
    );
  }
}

/**
 * The error for an answer that is neither queued nor a duplicate. mcp.tc's own message is shown as it is.
 * @param {import('../lib/http.js').HttpResponse} res
 * @param {any} data
 * @param {string} host
 * @param {string} base
 */
function answerError(res, data, host, base) {
  const status = res.status;
  if (data && typeof data.error === 'string') {
    const code = /^[a-z][a-z0-9_]{0,39}$/.test(data.error) ? data.error : 'submit_error';
    const said = typeof data.message === 'string' ? clean(data.message, { oneLine: true }).slice(0, 400) : '';
    if (status === 422) {
      return new CliError(code, said || `${host} can't take this URL (HTTP 422).`, EXIT.NOT_ACCEPTED, { status });
    }
    if (code === 'paused') {
      const ra = parseRetryAfter(res.headers.get('retry-after'));
      const seconds = ra !== null ? Math.ceil(ra / 1000) : null;
      return new CliError(code, `${said || `${host} has paused suggestions.`}${seconds !== null ? ` ${host} asks to wait ${inWords(seconds)}.` : ''}`, EXIT.ERROR, { status, retry_after: seconds });
    }
    return new CliError(code, said || `${host} refused the suggestion (HTTP ${status}).`, EXIT.ERROR, { status });
  }
  if (status >= 500) {
    return new CliError('server_error', `${host} answered HTTP ${status}. Try again later.`, EXIT.ERROR, { status });
  }
  return new CliError(
    'unsupported',
    `${host} did not answer as mcp.tc's suggestion endpoint (HTTP ${status}). Suggest the server on ${base}/submit instead, or update mcp-tc.`,
    EXIT.ERROR,
    { status },
  );
}

// ------------------------------------------------------------------ the status

/**
 * Read /s/{token}.json until the suggestion is finished or the wait runs out.
 * @param {any} ctx
 * @param {string} base
 * @param {string} token
 * @param {number} waitMs
 * @returns {Promise<{status: Record<string, unknown>|null, timedOut: boolean, waitedMs: number}>}
 */
async function follow(ctx, base, token, waitMs) {
  const url = `${base}/s/${encodeURIComponent(token)}.json`;
  const host = new URL(base).host;
  const start = timing.now();
  const deadline = start + waitMs;
  /** @type {Record<string, unknown>|null} */
  let status = null;
  let lastState = 'queued';
  let failures = 0;
  let hold = 0;
  for (;;) {
    const now = timing.now();
    const remaining = deadline - now;
    if (remaining <= 0 || hold > remaining) return { status, timedOut: true, waitedMs: Math.min(now, deadline) - start };
    const interval = now - start < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS;
    await timing.sleep(Math.min(Math.max(interval, hold), remaining));
    hold = 0;
    let res;
    try {
      res = await request(url, { headers: { Accept: 'application/json' }, return429: true, timeout: STATUS_TIMEOUT_MS, maxBytes: 64 * 1024 });
    } catch (err) {
      if (err instanceof CliError && (err.code === 'network_error' || err.code === 'timeout') && ++failures < MAX_STATUS_FAILURES) {
        ctx.out.info(`Could not read the status: ${err.message} Trying again.`);
        continue;
      }
      throw err;
    }
    if (res.status === 429) {
      const ra = parseRetryAfter(res.headers.get('retry-after'));
      hold = ra ?? BURST_WAIT_S * 1000;
      ctx.out.info(`${host} is limiting requests (HTTP 429). Next status check in ${Math.ceil(hold / 1000)} s.`);
      continue;
    }
    if (res.status === 404) {
      throw new CliError('status_missing', `${host} has no suggestion with this token any more.`, EXIT.ERROR, { status: 404 });
    }
    if (res.status >= 500) {
      if (++failures < MAX_STATUS_FAILURES) continue;
      throw new CliError('server_error', `${host} answered HTTP ${res.status} for the status of the suggestion.`, EXIT.ERROR, { status: res.status });
    }
    const data = jsonObject(res.text);
    if (res.status !== 200 || !data || typeof data.state !== 'string') {
      throw new CliError('bad_response', `${host} sent a status in an unexpected shape (HTTP ${res.status}).`, EXIT.ERROR, { status: res.status });
    }
    failures = 0;
    status = pickStatus(data);
    const state = String(status.state);
    const done = status.terminal === true || FINAL.includes(state);
    if (!done && state !== lastState) {
      ctx.out.info(`[${clock(timing.now() - start)}] ${statusLine(status)}`);
    }
    lastState = state;
    if (done) return { status, timedOut: false, waitedMs: timing.now() - start };
  }
}

/**
 * The fields of a status answer that submit passes on, as sent (strings capped).
 * @param {any} data
 */
function pickStatus(data) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of ['state', 'title', 'message', 'link', 'name', 'display']) {
    if (typeof data[k] === 'string') out[k] = data[k].slice(0, 2000);
  }
  out.terminal = data.terminal === true;
  return out;
}

/** @param {Record<string, unknown>} s */
function statusLine(s) {
  const title = clean(s.title, { oneLine: true }).slice(0, 120) || clean(s.state, { oneLine: true });
  const message = clean(s.message, { oneLine: true }).slice(0, 300);
  return message ? `${title}: ${message}` : title;
}

/** @param {number} ms */
function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A listing from a link mcp.tc sent, or null when the link isn't a listing page on mcp.tc.
 * @param {unknown} link
 * @param {unknown} name
 * @param {string} base
 * @param {unknown} [slug]
 */
function listingFrom(link, name, base, slug) {
  if (typeof link !== 'string' || !/^https?:\/\//i.test(link)) return null;
  const ref = parseListingRef(link, base);
  if (!ref.link || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(ref.slug)) return null;
  if (typeof slug === 'string' && slug.toLowerCase() !== ref.slug) return null;
  const n = typeof name === 'string' ? clean(name, { oneLine: true }).slice(0, 120) : '';
  return { slug: ref.slug, name: n || null, link };
}

/** @param {string} text */
function jsonObject(text) {
  if (!text || !text.trim()) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ output for people

/**
 * @param {any} r
 * @param {import('../lib/output.js').Output} out
 */
export function render(r, out) {
  const link = r.listing ? out.clean(r.listing.link, { oneLine: true }) : '';
  const details = r.listing ? `Details and setup: mcp-tc info ${r.listing.slug}` : '';
  const s = r.status || {};
  const message = out.clean(s.message, { oneLine: true });
  if (r.timed_out) {
    const where = s.title ? ` (${out.clean(s.title, { oneLine: true })})` : '';
    out.print(`Still being checked after ${formatDuration(r.__wait || 0)}${where}. Follow it on the status page: ${r.page}`);
    return;
  }
  switch (r.state) {
    case 'listed':
      out.print(link ? `Listed: ${link}` : 'Listed.');
      if (details) out.print(details);
      return;
    case 'duplicate':
      out.print(link ? `Already listed: ${link}` : 'Already listed.');
      if (details) out.print(details);
      return;
    case 'pending':
      out.print(`Waiting for review${message ? `: ${message}` : '.'}`);
      if (link) out.print(`Its link, once it goes live: ${link}`);
      out.print(`Status page: ${r.page}`);
      return;
    case 'rejected':
      out.print(`Not listed${message ? `: ${message}` : '.'}`);
      return;
    case 'error':
      out.print(`${out.clean(s.title, { oneLine: true }) || 'The check did not finish'}${message ? `: ${message}` : '.'}`);
      out.print(`Status page: ${r.page}`);
      return;
    default:
      if (!r.terminal && RUNNING.includes(r.state) && !r.status) {
        out.print(`Queued. The status page updates by itself; as JSON: ${r.status_url}`);
        return;
      }
      out.print(`State: ${out.clean(r.state, { oneLine: true })}${message ? `: ${message}` : ''}`);
      if (r.page) out.print(`Status page: ${r.page}`);
  }
}
