// mcp-tc doctor: connect straight to a server, the way an MCP client would, and report what it answers.
// A slug, name or mcp.tc link is first looked up with the directory's get_server tool to learn the server's own URL;
// the connection itself goes to that URL only.
import { accessState, clientOptions, mcpCall } from '../lib/directory.js';
import { EXIT, UsageError } from '../lib/errors.js';
import { DEFAULT_TIMEOUT_MS, maskUrl, parseHeaderOptions, probe } from '../lib/mcp.js';
import { resolveTarget } from '../lib/target.js';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'doctor',
  summary: 'Connect to a server directly and report what it answers',
  usage: 'doctor <slug|name|link|url> [options]',
  description:
    "Connects to the server's own URL the way an MCP client would: the 2026-07-28 style (server/discover) first, then the initialize handshake, then the older HTTP+SSE transport. Reports whether the server answers, the protocol version, the transport, how sign-in works and how many tools it lists. It reads OAuth metadata but never signs in, and it never calls a tool. For a slug, name or mcp.tc link, mcp.tc is asked for the server's URL first; anything with a user name, a password or a path is read as a URL and never sent to mcp.tc.",
  args: [{ name: 'server', required: true, variadic: true }],
  options: {
    header: {
      type: 'string',
      multiple: true,
      valueName: '"Name: value"',
      description: 'Send this header on MCP requests, to test your own server with a token. Repeatable. Values are never printed.',
    },
    timeout: { type: 'string', valueName: 'seconds', int: { min: 1, max: 120 }, description: 'Seconds to wait for each answer (default 15)' },
  },
  examples: [
    'mcp-tc doctor deepwiki',
    'mcp-tc doctor https://mcp.example.com/mcp',
    'mcp-tc doctor http://localhost:3000/mcp --header "Authorization: Bearer YOUR_TOKEN"',
    'mcp-tc doctor notion --json',
  ],
  exits: [
    [0, 'the server answered as an MCP server, or asked for sign-in (also for a local listing, which has nothing to connect to)'],
    [3, 'no listing with that slug or name, or it was removed'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) while looking the listing up'],
    [5, 'the server could not be reached or did not answer as an MCP server'],
  ],
};

// What the person typed: a URL to connect to, or a listing to look up first (only a slug- or name-shaped value is
// sent to mcp.tc; see lib/target.js).
export { resolveTarget };

/**
 * The fields of a probe report that doctor and check print in JSON. URLs are shown with key-like parts masked.
 * @param {import('../lib/mcp.js').Report} r
 */
export function summarize(r) {
  return {
    url: maskUrl(r.url),
    endpoint: maskUrl(r.endpoint),
    reachable: r.reachable,
    mcp: r.mcp,
    status: r.status,
    error: r.error,
    era: r.era,
    protocol_version: r.protocol_version,
    supported_versions: r.supported_versions,
    transport: r.transport,
    reply_format: r.reply_format,
    session: r.session,
    server: r.server,
    instructions: r.instructions || null,
    capabilities: r.capabilities,
    auth: {
      kind: r.auth.kind,
      www_authenticate: r.auth.www_authenticate,
      resource_metadata: r.auth.prm,
      authorization_server: r.auth.as,
      with_your_headers: r.auth.with_your_headers,
    },
    blocked: r.blocked,
    tools_listed: r.tools_listed,
    tools_count: r.tools_count,
    tools_truncated: r.tools_truncated,
    tools_error: r.tools_error,
    tools: r.tools.map((t) => ({ name: t.name, title: t.title, description: t.description.slice(0, 300), read_only: t.read_only, destructive: t.destructive })),
    prompts_count: r.prompts_count,
    resources_count: r.resources_count,
    eras: r.eras,
    redirects: r.redirects.map((x) => ({ ...x, from: maskUrl(x.from), to: maskUrl(x.to) })),
    points_to: r.points_to,
    moved_to: r.moved_to,
    retry_after: r.retry_after,
    cards: r.cards.map((c) => ({ url: maskUrl(c.url), status: c.status, found: c.found, content_type: c.content_type, cors: c.cors })),
    headers_sent: r.headers_sent,
    stdio: r.stdio,
    timing: { total_ms: r.ms, handshake_ms: r.handshake_ms, requests: r.requests },
  };
}

/**
 * Did the server answer as an MCP server (or ask for sign-in, which is how a protected one answers)?
 * @param {import('../lib/mcp.js').Report} r
 */
export function answered(r) {
  return r.mcp || (r.reachable && !r.blocked && r.error === null && ['oauth', 'api_key', 'optional'].includes(String(r.auth.kind)));
}

/**
 * One word for the outcome.
 * @param {import('../lib/mcp.js').Report} r
 * @returns {'ok'|'sign_in'|'api_key'|'blocked'|'not_mcp'|'unreachable'}
 */
export function verdict(r) {
  if (!r.reachable) return 'unreachable';
  if (r.blocked) return 'blocked';
  if (!r.mcp && r.auth.kind === 'oauth') return 'sign_in';
  if (!r.mcp && r.auth.kind === 'api_key') return 'api_key';
  if (r.mcp) return 'ok';
  return 'not_mcp';
}

/**
 * Compare what mcp.tc lists with what the server just said.
 * @param {any} listing
 * @param {import('../lib/mcp.js').Report} r
 */
function compare(listing, r) {
  /** @type {string[]} */
  const notes = [];
  if (!listing || !r.reachable) return notes;
  const seen = r.auth.kind;
  const listed = accessState('remote', listing.auth).label;
  if (r.auth.with_your_headers) return notes;
  if (listing.auth === 'none' && (seen === 'oauth' || seen === 'api_key')) notes.push(`mcp.tc lists it as "${listed}", but it asked for sign-in now.`);
  if ((listing.auth === 'oauth' || listing.auth === 'api_key') && seen === 'none') notes.push(`mcp.tc lists it as "${listed}", but it answered without sign-in now.`);
  if (listing.auth === 'oauth' && seen === 'api_key') notes.push('mcp.tc lists it with OAuth sign-in, but no OAuth metadata was found now.');
  if (r.redirects.some((x) => x.cross_origin)) notes.push('The listed URL now redirects to another origin.');
  return notes;
}

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const input = ctx.positionals.join(' ').trim();
  if (!input) throw new UsageError('Missing <slug|name|link|url>. Usage: mcp-tc doctor <slug|name|link|url>');
  if (input.length > 2000) throw new UsageError('That is too long for a slug, name or URL.', {}, 'invalid_argument');
  const { headers } = parseHeaderOptions(ctx.args.header);
  const timeout = (ctx.args.timeout || DEFAULT_TIMEOUT_MS / 1000) * 1000;
  const target = resolveTarget(input, ctx.base);

  let listing = null;
  let url;
  if (target.kind === 'listing') {
    const d = await mcpCall('get_server', { slug: target.slug }, clientOptions(ctx));
    listing = {
      slug: d.slug,
      name: d.name,
      link: d.link,
      kind: d.kind,
      auth: d.auth,
      access: accessState(d.kind, d.auth).label,
      endpoint: d.endpoint || null,
      install_command: d.install_command || null,
      homepage: d.homepage || null,
    };
    if (d.kind === 'local' || !d.endpoint) {
      return { input, listing, local: true, verdict: 'local', report: null, notes: [] };
    }
    url = d.endpoint;
  } else {
    url = target.url;
  }

  ctx.out.info(`Connecting to ${maskUrl(url)} ...`);
  const r = await probe(url, { headers, timeout, lists: true });
  if (!answered(r)) ctx.setExitCode(EXIT.UNREACHABLE);
  return { input, listing, local: false, verdict: verdict(r), report: summarize(r), notes: compare(listing, r) };
}

/** @param {number|null|undefined} ms */
function time(ms) {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The sign-in line and the OAuth details under it.
 * @param {ReturnType<typeof summarize>} s
 * @returns {[string, unknown][]}
 */
export function authRows(s) {
  const a = s.auth;
  const prm = a.resource_metadata;
  const as = a.authorization_server;
  /** @type {[string, unknown][]} */
  const rows = [];
  const yours = a.with_your_headers ? ' (with the headers you gave)' : '';
  // the labels mcp.tc uses for a listing's access state
  switch (a.kind) {
    case 'none':
      rows.push(['Access', `No sign-in${yours}`]);
      break;
    case 'optional':
      rows.push(['Access', `Sign-in optional: it answers without sign-in and also offers it${yours}`]);
      break;
    case 'oauth':
      rows.push(['Access', 'Sign-in (OAuth): the client opens a sign-in page the first time it connects']);
      break;
    case 'api_key':
      rows.push(['Access', 'API key: HTTP 401 without OAuth metadata, so clients send a key or token in a header']);
      break;
    case 'unknown':
      rows.push(['Access', 'Unknown: a firewall or bot check answered instead of the server']);
      break;
    default:
      break;
  }
  if (prm) rows.push(['Metadata', prm.url]);
  if (prm && prm.scopes_supported && prm.scopes_supported.length) rows.push(['Scopes', prm.scopes_supported.join(', ')]);
  if (as && as.ok) {
    const reg = as.registration_endpoint ? 'yes' : as.client_id_metadata_document_supported ? 'client ID metadata documents' : 'no';
    const pkce = as.code_challenge_methods_supported.includes('S256') ? 'yes' : 'not listed';
    rows.push(['Auth server', `${as.issuer} (client registration: ${reg}; PKCE S256: ${pkce})`]);
  } else if (as && !as.ok) {
    rows.push(['Auth server', `${as.issuer}: no metadata found`]);
  }
  return rows;
}

/**
 * The main lines for a report (shared with check).
 * @param {ReturnType<typeof summarize>} s
 * @returns {[string, unknown][]}
 */
export function reportRows(s) {
  /** @type {[string, unknown][]} */
  const rows = [];
  if (s.transport === 'stdio') {
    rows.push(['Command', s.url]);
    if (s.mcp) {
      const how = s.era === 'modern' ? 'server/discover' : 'initialize';
      rows.push(['Protocol', `${s.protocol_version} (${how}) over stdio${s.timing.handshake_ms !== null ? `, first answer in ${time(s.timing.handshake_ms)}` : ''}`]);
    }
    if (s.stdio && s.stdio.exit) rows.push(['Exit', s.stdio.exit.signal ? `stopped with ${s.stdio.exit.signal}` : `code ${s.stdio.exit.code}`]);
    if (s.stdio && !s.mcp && s.stdio.stderr_tail) rows.push(['Its stderr', s.stdio.stderr_tail.slice(-300)]);
  } else {
    rows.push(['Server URL', s.endpoint]);
    if (s.endpoint !== s.url) rows.unshift(['Asked', s.url]);
  }
  if (s.status !== null) rows.push(['Answer', `HTTP ${s.status}${s.timing.handshake_ms !== null ? ` in ${time(s.timing.handshake_ms)}` : ''}`]);
  if (s.mcp && s.transport !== 'stdio') {
    const how = s.era === 'modern' ? 'server/discover' : s.transport === 'sse' ? 'initialize over HTTP+SSE' : 'initialize';
    const more = s.supported_versions.filter((v) => v !== s.protocol_version);
    rows.push(['Protocol', `${s.protocol_version} (${how})${more.length ? `; also ${more.join(', ')}` : ''}`]);
    rows.push([
      'Transport',
      s.transport === 'sse' ? 'HTTP+SSE (the older transport, deprecated since 2025-03-26)' : `Streamable HTTP, ${s.reply_format === 'sse' ? 'replies as SSE streams' : 'JSON replies'}`,
    ]);
    rows.push([
      'Session',
      s.session.issued ? `Mcp-Session-Id issued${s.session.ended ? ', ended with DELETE' : s.session.delete_status ? `, DELETE answered HTTP ${s.session.delete_status}` : ''}` : 'none (stateless)',
    ]);
  }
  rows.push(...authRows(s));
  if (s.server) {
    const name = [s.server.name, s.server.version].filter(Boolean).join(' ');
    rows.push(['Server', `${name || '(no name)'}${s.server.title ? ` (${s.server.title})` : ''}`]);
  }
  if (s.tools_listed) {
    const ro = s.tools.filter((t) => t.read_only === true).length;
    const none = s.tools.filter((t) => t.read_only === null && t.destructive === null).length;
    const parts = [ro ? `${ro} read-only` : '', none ? `${none} without hints` : ''].filter(Boolean);
    rows.push(['Tools', `${s.tools_count}${s.tools_truncated ? '+ (stopped at the limit)' : ''}${parts.length ? ` (${parts.join(', ')})` : ''}`]);
  } else if (s.tools_error) {
    rows.push(['Tools', s.tools_error]);
  }
  if (s.prompts_count !== null) rows.push(['Prompts', s.prompts_count]);
  if (s.resources_count !== null) rows.push(['Resources', s.resources_count]);
  for (const x of s.redirects) rows.push(['Redirect', `${x.status} to ${x.to}${x.cross_origin ? ' (another origin)' : ''}`]);
  if (s.headers_sent.length) rows.push(['Your headers', s.headers_sent.join(', ')]);
  rows.push(['Requests', `${s.timing.requests} in ${time(s.timing.total_ms)}`]);
  return rows;
}

/**
 * One sentence for the outcome.
 * @param {ReturnType<typeof summarize>} s
 * @param {string} v
 */
export function outcome(s, v) {
  switch (v) {
    case 'ok':
      if (s.auth.kind === 'optional') return 'The server answers MCP without sign-in, and sign-in is available.';
      if (s.tools_error && /sign-in/.test(s.tools_error)) return 'The server answers MCP, but lists its tools only after sign-in.';
      return s.auth.with_your_headers ? 'The server answers MCP with the headers you gave.' : 'The server answers MCP without sign-in.';
    case 'sign_in':
      return 'The server asks for OAuth sign-in. Clients open the sign-in page the first time they connect; its tools show after that.';
    case 'api_key':
      return 'The server asks for a key or token. Put it in the header the server documents; with mcp-tc you can test it with --header.';
    case 'blocked':
      return `A firewall or bot check refused the request${s.status ? ` (HTTP ${s.status})` : ''}. MCP clients are not browsers, so they may get the same answer.`;
    case 'unreachable':
      return `The server could not be reached: ${s.error || 'no answer'}.`;
    default:
      return `The address answered, but not as an MCP server: ${s.error || 'no MCP reply'}.`;
  }
}

/**
 * @param {any} res
 * @param {import('../lib/output.js').Output} out
 */
export function render(res, out) {
  const l = res.listing;
  if (res.local) {
    out.print(out.style.bold(`${out.clean(l.name, { oneLine: true })} runs on your computer: there is no server URL to connect to.`));
    out.print('');
    if (l.install_command) {
      out.print(out.fields([['Install', l.install_command]], { indent: 2 }));
      out.print('');
      out.print(`Add it to a client: mcp-tc add ${out.clean(l.slug, { oneLine: true })} --client <id>`);
    } else {
      out.print(`Install it with the vendor's own instructions: ${out.clean(l.homepage || l.link, { oneLine: true })}`);
    }
    return;
  }
  const s = res.report;
  if (l) out.print(out.style.bold(`${out.clean(l.name, { oneLine: true })} (${out.clean(l.link, { oneLine: true })}, listed as ${l.access})`));
  out.print(out.fields(reportRows(s), { indent: l ? 2 : 0 }));
  out.print('');
  const line = outcome(s, res.verdict);
  out.print(res.verdict === 'ok' ? out.style.green(line) : ['sign_in', 'api_key'].includes(res.verdict) ? line : out.style.red(line));
  if (s.points_to) {
    out.print(`It points to the server's own ${s.points_to.endpoint ? `URL: ${out.clean(s.points_to.endpoint, { oneLine: true })}` : `install command: ${out.clean(s.points_to.command, { oneLine: true })}`}`);
  }
  if (s.moved_to) out.print(`Try the new URL: mcp-tc doctor ${out.clean(s.moved_to, { oneLine: true })}`);
  for (const n of res.notes) out.print(out.style.yellow(n));
}
