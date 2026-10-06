// mcp-tc scan: list the MCP servers in this computer's client configs and find each one on mcp.tc.
//
// What scan sends to mcp.tc, and nothing else (the README repeats this list):
//   - GET /directory?q=<address>, once for each different server, sequentially. <address> is either
//       a remote server's URL without user name, password, query string or fragment; when part of its path looks
//       like a key (a long random token, a UUID, or name=value), only the scheme and host are sent; or
//       a local server's package: an npm package name (for an unscoped name, its npmjs.com page URL), a PyPI project
//       page URL, or a GitHub, GitLab, Bitbucket or Codeberg repository URL. For an mcp-remote bridge, the remote URL
//       it connects to, reduced the same way. Container images (docker run) are shown but not looked up.
//   - GET /api/index.json once, when at least one server is listed (or points at a listing page), for the listings'
//     names, access and checkmarks.
// Never sent: headers, environment values, keys, the other command arguments, file paths, the names you gave the
// servers in your configs, or which clients you use. Not looked up at all: addresses on this computer or a private
// network (localhost, private, shared and reserved IP ranges, single-label names, .local, .internal, .lan,
// .home.arpa, Kubernetes .svc and similar names, tailnet .ts.net names), plain http:// URLs, and URLs with variables.
// An mcp.tc listing link in a config is a page, not a server: scan reports it and sends nothing for it.
// If mcp.tc limits or refuses the lookups, scan stops asking, still lists everything it found, and adds a "partial"
// field to the result (exit code 4 when rate limited, 1 otherwise). With --offline nothing is sent.
import { accessState, addressForLookup, clientOptions, index, lookupAddress, parseListingRef } from '../lib/directory.js';
import { CLIENT_IDS, describeServer, displayPath, lookupTarget, readForScan, scanLocations, serversIn, where } from '../lib/clients.js';
import { clean } from '../lib/output.js';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'scan',
  summary: 'Find the servers in your MCP client configs on mcp.tc',
  usage: 'scan [--offline] [--client <id>]',
  description:
    "Reads the MCP config files of Claude Code, Claude Desktop, Cursor, VS Code, Devin Desktop, Codex and Gemini CLI (your user files and the project files in this folder), lists each server, and looks it up on mcp.tc: its listing, access (No sign-in, Sign-in, API key, Local) and checkmark. Only each server's https URL (without credentials, query or key-like path parts) or package name is sent; never headers, environment values or keys, and nothing for addresses on this computer or a private network. An entry that points at an mcp.tc listing page instead of the server is reported, with the add command that sets the server's own URL. With --offline it only lists what it found and sends nothing. If mcp.tc limits or refuses the lookups, scan stops asking and still lists everything it found: with --json the result keeps \"ok\": true and adds \"partial\": {code, message}, and the exit code is 4 when mcp.tc is limiting requests, 1 otherwise.",
  args: [],
  options: {
    offline: { type: 'boolean', description: 'Only read the local files; send nothing to mcp.tc' },
    client: { type: 'string', valueName: 'id', choices: CLIENT_IDS.filter((c) => !['claude-ai', 'chatgpt', 'json'].includes(c)), description: 'Only this client\'s files' },
  },
  examples: ['mcp-tc scan', 'mcp-tc scan --offline', 'mcp-tc scan --client cursor --json'],
  exits: [
    [0, 'done (servers that are not listed are not an error)'],
    [1, 'error; or mcp.tc refused the lookups or answered with an error, and the list is partial ("partial" in --json)'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) after the retries, and the list is partial ("partial" in --json)'],
  ],
};

/** Pause between two address lookups, so a long config never comes close to mcp.tc's request limits. */
export const timing = { gapMs: 250 };

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REASONS = {
  offline: 'not looked up (--offline)',
  local_address: 'not looked up: an address on this computer or a private network',
  not_https: 'not looked up: a plain http address (public MCP servers use https)',
  local_command: 'not looked up: a local command',
  local_path: 'not looked up: a local file',
  no_package: 'not looked up: no package name in the command',
  image_registry: 'not looked up: a container image',
  container_image: 'not looked up: a container image',
  not_http: 'not looked up: not an http or https address',
  not_a_url: 'not looked up: not a valid URL',
  has_variables: 'not looked up: the URL uses variables',
  unknown_shape: 'not looked up: no URL or command',
  no_address: 'not looked up: nothing to look it up by',
  lookup_failed: 'not looked up: the lookups stopped (see the error)',
};

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const w = where(ctx);
  const only = ctx.args.client || null;
  const offline = Boolean(ctx.args.offline);
  // an mcp.tc listing link (mcp.tc/i/<slug>, any language) is a page: MCP clients get an error there
  const listingSlug = (/** @type {string} */ url) => {
    const r = parseListingRef(url, ctx.base);
    return r.link && /^[a-z0-9][a-z0-9-]{0,63}$/.test(r.slug) ? r.slug : null;
  };
  /** @type {any[]} */
  const files = [];
  /** @type {any[]} */
  const servers = [];
  for (const loc of scanLocations(w)) {
    if (only && !loc.clients.includes(only)) continue;
    const r = readForScan(loc.path, loc.format);
    if (!r.exists) continue;
    const found = r.problem ? [] : serversIn(loc, r.data, w);
    files.push({ client: loc.label, clients: loc.clients, path: loc.path, scope: loc.scope, status: r.problem ? 'unreadable' : 'read', problem: r.problem, servers: found.length });
    for (const s of found) {
      const shape = describeServer(s.raw, loc.clients.length === 1 ? loc.clients[0] : '');
      const target = lookupTarget(shape, { listingSlug });
      const sv = {
        client: loc.label,
        clients: loc.clients,
        file: loc.path,
        scope: s.note ? 'local' : loc.scope,
        name: clean(s.name, { oneLine: true }).slice(0, 120),
        transport: shape.transport,
        uses: usesText(shape, target),
        target,
        lookup: { status: 'skipped', sent: /** @type {string|null} */ (null), reason: /** @type {string|null} */ (offline ? 'offline' : null) },
        listing: /** @type {any} */ (null),
        submit_url: /** @type {string|null} */ (null),
        fix: /** @type {string|null} */ (null),
      };
      if (target.type === 'listing') {
        // nothing to look up: the slug is in the link
        sv.lookup = { status: 'listing_link', sent: null, reason: null };
        sv.listing = { slug: target.slug, name: null, state: null, state_label: null, verified: null, link: `${ctx.base}/i/${target.slug}` };
        sv.fix = `mcp-tc add ${target.slug} --client ${(only && loc.clients.includes(only) ? only : loc.clients[0])}`;
      }
      servers.push(sv);
    }
  }

  /** @type {string[]} */
  const sent = [];
  /** @type {{code: string, message: string}|null} */
  let partial = null;
  let indexFetched = false;
  if (!offline) {
    const opts = clientOptions(ctx);
    /** @type {Map<string, string|null>} */
    const cache = new Map();
    for (const sv of servers) {
      const t = sv.target;
      if (t.type === 'listing') continue;
      if (t.type === 'skip') {
        sv.lookup.reason = t.reason;
        continue;
      }
      if (t.type === 'package' && t.registry === 'oci') {
        sv.lookup.reason = 'container_image';
        continue;
      }
      const input = t.type === 'package' ? t.name : t.url;
      const registry = t.type === 'package' && t.registry !== 'oci' ? t.registry : null;
      const q = addressForLookup(input, { registry });
      if (q === null) {
        sv.lookup.reason = 'no_address';
        continue;
      }
      let slug;
      if (cache.has(q)) {
        slug = cache.get(q) ?? null;
      } else if (partial) {
        sv.lookup = { status: 'error', sent: null, reason: 'lookup_failed' };
        continue;
      } else {
        if (sent.length) await sleep(timing.gapMs);
        sent.push(q);
        try {
          slug = await lookupAddress(input, { ...opts, registry });
        } catch (err) {
          const e = /** @type {any} */ (err);
          partial = { code: e && e.code ? String(e.code) : 'unexpected', message: e && e.message ? String(e.message) : String(err) };
          if (e && typeof e.exit === 'number') ctx.setExitCode(e.exit);
          else ctx.setExitCode(1);
          sv.lookup = { status: 'error', sent: q, reason: 'lookup_failed' };
          continue;
        }
        cache.set(q, slug);
      }
      if (slug) {
        sv.lookup = { status: 'listed', sent: q, reason: null };
        sv.listing = { slug, name: null, state: null, state_label: null, verified: null, link: `${ctx.base}/i/${slug}` };
      } else if (t.type === 'url' && isOriginOnly(q)) {
        // mcp.tc matches a server URL by host and path, so a bare host (or a URL whose key-like path was not sent)
        // can miss a server that is listed: no claim that it is missing, and no suggestion to submit it again
        sv.lookup = { status: 'not_found_by_url', sent: q, reason: null };
      } else {
        sv.lookup = { status: 'not_listed', sent: q, reason: null };
        sv.submit_url = submitUrl(t);
      }
    }
    // after a rate limit or a block, ask nothing more
    if (servers.some((s) => s.listing) && !(partial && (partial.code === 'rate_limited' || partial.code === 'blocked'))) {
      try {
        const all = await index(opts);
        indexFetched = true;
        /** @type {Map<string, any>} */
        const bySlug = new Map(all.map((e) => [e && e.s, e]));
        for (const sv of servers) {
          if (!sv.listing) continue;
          const e = bySlug.get(sv.listing.slug);
          if (!e) continue;
          const st = accessState(e.k, e.a);
          sv.listing.name = clean(e.n, { oneLine: true }) || sv.listing.slug;
          sv.listing.state = st.key;
          sv.listing.state_label = st.label;
          sv.listing.verified = Boolean(e.f);
        }
      } catch (err) {
        const e = /** @type {any} */ (err);
        ctx.out.warn(`Could not read the directory index, so names and access are missing: ${e && e.message ? e.message : String(err)}`);
      }
    }
  }

  for (const sv of servers) delete sv.target;
  const count = (/** @type {string} */ st) => servers.filter((s) => s.lookup.status === st).length;
  return {
    offline,
    files: files.map((f) => ({ ...f, shown: displayPath(f.path, w) })),
    servers: servers.map((s) => ({ ...s, file_shown: displayPath(s.file, w) })),
    counts: {
      servers: servers.length,
      listed: count('listed'),
      not_listed: count('not_listed'),
      not_found_by_url: count('not_found_by_url'),
      listing_link: count('listing_link'),
      skipped: count('skipped'),
      error: count('error'),
    },
    sent,
    index_fetched: indexFetched,
    partial,
  };
}

/**
 * True for a URL sent without a path (only scheme and host).
 * @param {string} q
 */
function isOriginOnly(q) {
  try {
    const u = new URL(q);
    return u.pathname === '/' || u.pathname === '';
  } catch {
    return false;
  }
}

/**
 * What an entry runs or connects to, safe to print: the URL as it would be sent, or the runner and the package.
 * Arguments, headers and environment values are never shown (they can hold keys).
 * @param {import('../lib/clients.js').ServerShape} shape
 * @param {import('../lib/clients.js').LookupTarget} t
 */
function usesText(shape, t) {
  const runner = shape.command ? clean(shape.command.split(/[\\/]/).pop() || shape.command, { oneLine: true }) : '';
  if (t.type === 'listing') {
    const link = listingText(shape.url || shape.args.find((a) => /^https?:\/\//i.test(a)) || '', t.slug);
    return shape.url ? link : `${runner} mcp-remote ${link}`;
  }
  if (shape.url) {
    if (t.type === 'url') return t.trimmed.includes('path') ? `${t.url}/...` : `${t.url}${t.trimmed.includes('query') ? '?...' : ''}`;
    if (t.type === 'skip' && (t.reason === 'local_address' || t.reason === 'not_https')) {
      try {
        const u = new URL(shape.url);
        return `${u.protocol}//${u.host}/...`;
      } catch {
        return '(URL)';
      }
    }
    return '(URL)';
  }
  if (!shape.command) return '(no URL or command)';
  if (t.type === 'package') return `${runner} ${t.name}`;
  if (t.type === 'url') return `${runner} mcp-remote ${t.trimmed.includes('path') ? `${t.url}/...` : t.url}`;
  if (t.type === 'repo') return `${runner} ${t.url}`;
  return runner;
}

/**
 * A listing link as written in a config, without its query or fragment.
 * @param {string} raw
 * @param {string} slug
 */
function listingText(raw, slug) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return `https://mcp.tc/i/${slug}`;
  }
}

/**
 * The address to suggest the server with (mcp-tc submit), or null when there is no good one.
 * @param {import('../lib/clients.js').LookupTarget} t
 */
function submitUrl(t) {
  if (t.type === 'url') return t.trimmed.includes('path') ? null : t.url;
  if (t.type === 'repo') return t.url;
  if (t.type === 'package' && t.registry === 'npm') return `https://www.npmjs.com/package/${t.name}`;
  if (t.type === 'package' && t.registry === 'pypi') return `https://pypi.org/project/${t.name}`;
  return null;
}

/**
 * @param {any} r
 * @param {import('../lib/output.js').Output} out
 */
export function render(r, out) {
  if (!r.files.length) {
    out.print('No MCP client config files found for this user or in this folder.');
    return;
  }
  const n = r.counts.servers;
  out.print(`Found ${n} MCP server${n === 1 ? '' : 's'} in ${r.files.length} config file${r.files.length === 1 ? '' : 's'}.${r.offline ? ' Nothing was looked up (--offline).' : ''}`);
  for (const f of r.files) {
    out.print('');
    out.print(out.style.bold(`${clean(f.client)}: ${clean(f.shown)}${f.scope === 'project' ? ' (this folder)' : ''}`));
    if (f.status !== 'read') {
      out.print(`  Could not read it (${f.problem === 'invalid' ? 'not valid JSON or TOML' : String(f.problem).replace(/_/g, ' ')}).`);
      continue;
    }
    const list = r.servers.filter((/** @type {any} */ s) => s.file === f.path);
    if (!list.length) {
      out.print(out.style.dim('  No servers.'));
      continue;
    }
    const nameW = Math.min(28, Math.max(...list.map((/** @type {any} */ s) => s.name.length)) + 2);
    for (const s of list) {
      out.print(`  ${out.truncate(s.name, nameW - 2).padEnd(nameW)}${clean(s.uses, { oneLine: true })}${s.scope === 'local' ? out.style.dim(' (this folder only)') : ''}`);
      out.print(`  ${' '.repeat(nameW)}${status(s, out)}`);
    }
  }
  const missing = r.servers.filter((/** @type {any} */ s) => s.lookup.status === 'not_listed');
  const c = r.counts;
  out.print('');
  if (!r.offline) {
    const parts = [`${c.listed} listed`, `${c.not_listed} not listed`];
    if (c.not_found_by_url) parts.push(`${c.not_found_by_url} not found by URL`);
    parts.push(`${c.skipped + c.error} not looked up`);
    out.print(`On mcp.tc: ${parts.join(', ')}.`);
    if (missing.length) out.print('Suggest a missing server with: mcp-tc submit <url>, or at https://mcp.tc/submit');
  }
  if (c.listing_link) {
    out.print(
      `${c.listing_link} ${c.listing_link === 1 ? 'entry points' : 'entries point'} at an mcp.tc listing page instead of the server. A listing page is a page, not an MCP endpoint: use the server's own URL (the add command above sets it), then remove the old entry.`,
    );
  }
  if (r.partial) out.warn(`The lookups stopped, so this list is partial: ${clean(r.partial.message)}`);
}

/**
 * @param {any} s
 * @param {import('../lib/output.js').Output} out
 */
function status(s, out) {
  if (s.lookup.status === 'listed') {
    const l = s.listing;
    const name = l.name ? `${clean(l.name, { oneLine: true })}${l.verified ? ' \u2713' : ''}` : clean(l.slug);
    const state = l.state_label ? `, ${l.state_label}` : '';
    return `${out.style.green('On mcp.tc:')} ${name}${state}: ${l.link}`;
  }
  if (s.lookup.status === 'not_listed') {
    return `${out.style.yellow('Not on mcp.tc.')}${s.submit_url ? ` Suggest it: mcp-tc submit ${clean(s.submit_url)}` : ''}`;
  }
  if (s.lookup.status === 'not_found_by_url') {
    return `${out.style.yellow('Not found by this URL.')} mcp.tc matches a server by its host and path; find it by name with: mcp-tc search <name>`;
  }
  if (s.lookup.status === 'listing_link') {
    const l = s.listing;
    const name = l.name ? `${clean(l.name, { oneLine: true })}${l.verified ? ' \u2713' : ''}` : clean(l.slug);
    return `${out.style.yellow('This is the mcp.tc page for')} ${name}, not the server. Use the server's own URL: ${clean(s.fix || '')}`;
  }
  return out.style.dim(REASONS[/** @type {keyof typeof REASONS} */ (s.lookup.reason)] || 'not looked up');
}
