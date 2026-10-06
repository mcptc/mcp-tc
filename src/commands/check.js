// mcp-tc check: read a server, or a server's project folder, the way mcp.tc's checker reads it (what
// https://mcp.tc/docs/server-owners lists) and report errors, warnings and suggestions. It says whether the server is
// readable. It doesn't predict whether a suggestion is listed: on mcp.tc an AI model checks each suggestion, and a
// person may review it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clientOptions, mcpCall, parseListingRef } from '../lib/directory.js';
import { EXIT, UsageError } from '../lib/errors.js';
import {
  DEFAULT_TIMEOUT_MS,
  FOREIGN_ORIGIN,
  KNOWN_VERSIONS,
  LEGACY_VERSIONS,
  cardUrls,
  isLoopback,
  maskUrl,
  parseHeaderOptions,
  probe,
  probeStdio,
  rebindingTest,
  secretsInUrl,
  showCommand,
  splitCommand,
} from '../lib/mcp.js';
import { clean } from '../lib/output.js';
import { classifyTarget } from '../lib/target.js';
import { CARD_SCHEMA, NAME_RE, SERVER_JSON_SCHEMA, deriveName, readJsonFile, repositoryOf, validateCard, validateServerJson } from './card.js';
import { answered, reportRows, summarize } from './doctor.js';

export const NOTE =
  "check reads your server the way mcp.tc reads it and points out what would stop clients or the listing from reading it well. On mcp.tc an AI model checks each suggestion and a person may review it; check doesn't predict whether the server will be listed.";
/** Descriptions shorter than this are flagged as very short. */
const SHORT_DESCRIPTION = 20;

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'check',
  summary: "Check a server or project the way mcp.tc reads it",
  usage: 'check <url|dir> [options]',
  description: `For a URL: the handshake in both protocol styles, tools/list with each tool's description and readOnlyHint and destructiveHint annotations, serverInfo, sign-in and OAuth metadata, the server card, keys in the URL, and for a server on this computer, that a foreign Host and Origin are refused (DNS rebinding protection). For a folder: package.json, server.json and a server card file, plus the running server when you add --url, or a local server started over stdio with --stdio or --command (this runs the project's code on your computer). ${NOTE}`,
  args: [{ name: 'target', required: true }],
  options: {
    url: { type: 'string', valueName: 'endpoint', description: 'With a folder: also check the running server at this URL' },
    stdio: { type: 'boolean', description: "With a folder: start the server from package.json's bin with node and check it over stdio" },
    command: {
      type: 'string',
      valueName: 'command',
      description: 'With a folder: start the server with this command (run in the folder, without a shell) and check it over stdio',
    },
    header: {
      type: 'string',
      multiple: true,
      valueName: '"Name: value"',
      description: 'Send this header on MCP requests, to check a server that needs a token. Repeatable. Values are never printed.',
    },
    timeout: { type: 'string', valueName: 'seconds', int: { min: 1, max: 120 }, description: 'Seconds to wait for each answer (default 15)' },
  },
  examples: [
    'mcp-tc check https://mcp.example.com/mcp',
    'mcp-tc check http://localhost:3000/mcp',
    'mcp-tc check . --url http://localhost:3000/mcp',
    'mcp-tc check . --stdio',
    'mcp-tc check ./server --command "python -m my_server"',
    'mcp-tc check https://mcp.example.com/mcp --header "Authorization: Bearer YOUR_TOKEN" --json',
  ],
  exits: [
    [0, 'no errors (there may be warnings and suggestions)'],
    [3, 'no listing behind that mcp.tc link, or it was removed'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) while looking a listing link up'],
    [5, 'the server could not be reached or did not answer as an MCP server'],
    [6, 'errors found'],
  ],
};

/**
 * @typedef {{level: 'error'|'warning'|'suggestion'|'ok', id: string, message: string}} Finding
 */

class Findings {
  constructor() {
    /** @type {Finding[]} */
    this.list = [];
  }

  /** @param {string} id @param {string} message */
  error(id, message) {
    this.list.push({ level: 'error', id, message });
  }

  /** @param {string} id @param {string} message */
  warn(id, message) {
    this.list.push({ level: 'warning', id, message });
  }

  /** @param {string} id @param {string} message */
  suggest(id, message) {
    this.list.push({ level: 'suggestion', id, message });
  }

  /** @param {string} id @param {string} message */
  ok(id, message) {
    this.list.push({ level: 'ok', id, message });
  }
}

/**
 * "a", "a and b", "a, b and c".
 * @param {string[]} words
 */
function and(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Up to six names, then "and N more".
 * @param {string[]} names
 */
function some(names) {
  const shown = names.slice(0, 6).join(', ');
  return names.length > 6 ? `${shown} and ${names.length - 6} more` : shown;
}

/** @param {string} url */
function isRemoteHttp(url) {
  const u = new URL(url);
  return u.protocol === 'http:' && !isLoopback(u.hostname);
}

// ------------------------------------------------------------------ a running server

/**
 * Findings for a probe report.
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 * @param {{rebinding?: Awaited<ReturnType<typeof rebindingTest>>|null}} [extra]
 */
export function endpointFindings(r, f, extra = {}) {
  for (const s of secretsInUrl(r.url)) {
    if (s.kind === 'key') {
      f.error(
        'secret_in_url',
        `The URL seems to carry a key or token (${s.where === 'query' ? `query parameter "${s.name}"` : s.name}). Anyone who sees the URL can use it, and mcp.tc lists only a server's public URL. Accept the key in a header instead.`,
      );
    } else {
      f.warn('personal_url', `The URL has what looks like an account or tenant ID (${s.name}). If this URL is personal, share the server's public URL instead.`);
    }
  }
  if (isRemoteHttp(r.url)) f.warn('not_https', 'The URL uses http, not https. Many clients refuse plain http for a remote server.');

  for (const x of r.redirects) {
    if (x.cross_origin) {
      f.warn('redirect_other_origin', `The URL redirects to ${maskUrl(x.to)}, on another origin. MCP SDK clients refuse redirects to another origin: publish the final URL.`);
    } else {
      f.suggest('redirect', `The URL redirects (HTTP ${x.status}) to ${maskUrl(x.to)}. Publish the final URL so clients don't depend on the redirect.`);
    }
  }

  if (!r.reachable) {
    f.error('unreachable', `Could not reach the server: ${r.error || 'no answer'}.`);
    return;
  }
  if (r.points_to) {
    f.error('not_the_endpoint', `This address answered that it is not an MCP endpoint and points to ${r.points_to.endpoint || r.points_to.command}. Check that instead.`);
    return;
  }
  if (r.moved_to) {
    f.error('moved', `The server says this URL is gone (HTTP 410) and points to ${r.moved_to}.`);
    return;
  }
  if (r.blocked) {
    f.error(
      'blocked',
      `A firewall or bot check answered instead of the server (HTTP ${r.status}). mcp.tc's checker and MCP clients are not browsers, so they get the same refusal: let MCP requests through to the endpoint.`,
    );
    return;
  }
  if (r.retry_after !== null || r.status === 429) {
    f.error('rate_limited', `The server answered HTTP 429 (too many requests)${r.retry_after !== null ? `; it asked to wait ${r.retry_after} s` : ''}. Try again later.`);
    return;
  }

  authFindings(r, f);
  if (!r.mcp) {
    if (r.auth.kind === 'oauth' || r.auth.kind === 'api_key') {
      f.warn(
        'tools_need_sign_in',
        "The server asks for sign-in before the handshake, so mcp.tc can't read its name or tools, and the listing shows an empty tool list. To check the rest with your own token: --header \"Authorization: Bearer YOUR_TOKEN\".",
      );
      return;
    }
    f.error('not_mcp', `The server answered, but not as an MCP server: ${r.error || 'no MCP reply'}.`);
    return;
  }

  serverFindings(r, f);
  if (r.session.issued && r.session.delete_status !== null && !r.session.ended && r.session.delete_status !== 405) {
    f.warn('session_delete', `The server issued a session (Mcp-Session-Id), but DELETE with it answered HTTP ${r.session.delete_status}. Answer 200 or 204, or 405 if sessions can't be ended by the client.`);
  }
  cardFindings(r, f);
  if (extra.rebinding) rebindingFindings(extra.rebinding, f);
}

/**
 * What every transport shares: protocol, serverInfo, tools and the other lists.
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 */
function serverFindings(r, f) {
  eraFindings(r, f);
  serverInfoFindings(r, f);
  toolFindings(r, f);
  for (const e of r.list_errors) f.warn('list_failed', `${e}.`);
}

/**
 * Findings for a local server checked over stdio.
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 */
export function stdioFindings(r, f) {
  const noise = r.stdio ? r.stdio.stdout_noise : 0;
  if (!r.mcp) {
    const tail = r.stdio && r.stdio.stderr_tail ? ` Its error output ends with: ${r.stdio.stderr_tail.slice(-300)}` : '';
    f.error('stdio_failed', `The server did not answer over stdio: ${r.error || 'no answer'}.${tail}`);
  } else {
    f.ok('stdio', 'Answers over stdio.');
  }
  if (noise) {
    f.error('stdio_noise', `The server wrote ${noise} line${noise === 1 ? '' : 's'} to stdout that ${noise === 1 ? 'is' : 'are'} not JSON-RPC. Over stdio, stdout carries only protocol messages: send logs to stderr.`);
  }
  if (r.mcp) serverFindings(r, f);
}

/**
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 */
function eraFindings(r, f) {
  const m = r.eras.modern;
  const l = r.eras.legacy;
  if (r.transport === 'sse') {
    f.warn(
      'sse_transport',
      'The server uses the HTTP+SSE transport, deprecated since protocol 2025-03-26. Serve Streamable HTTP on one endpoint (POST to /mcp), and keep /sse only for old clients.',
    );
    return;
  }
  if (m && m.ok) f.ok('modern', `Answers server/discover (protocol ${m.protocol_version}).`);
  else f.suggest('modern_missing', "No answer to server/discover, the 2026-07-28 style. Clients fall back to initialize for now; add it when your SDK supports it.");
  if (l && l.ok) {
    f.ok('legacy', `Answers initialize (protocol ${l.protocol_version}).`);
    const pv = String(l.protocol_version);
    if (!KNOWN_VERSIONS.includes(pv)) f.warn('unknown_version', `initialize answered with protocol version ${pv}, which this tool doesn't know. Clients disconnect when they don't speak the version the server picks.`);
    else if (!LEGACY_VERSIONS.includes(pv)) f.suggest('old_version', `initialize answered with protocol ${pv}. Update your MCP SDK to speak ${LEGACY_VERSIONS[0]}.`);
  } else if (m && m.ok) {
    f.warn('legacy_missing', `The server doesn't answer initialize (${l ? l.error : 'no answer'}). Most clients still connect with initialize (protocol ${LEGACY_VERSIONS[0]} and older), so they can't use it yet.`);
  }
  if (r.reply_format === 'sse') f.ok('reply_sse', 'Replies come as SSE streams, which clients read fine.');
}

/**
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 */
function serverInfoFindings(r, f) {
  const s = r.server;
  if (!s) {
    f.error('server_info_missing', 'The handshake has no serverInfo. Clients and mcp.tc use its name and version.');
    return;
  }
  if (!s.name) f.error('server_name_missing', 'serverInfo has no name.');
  if (!s.version) f.error('server_version_missing', 'serverInfo has no version.');
  if (s.name && s.version) f.ok('server_info', `serverInfo: ${s.name} ${s.version}.`);
  const missing = /** @type {string[]} */ ([!s.title && 'title', !s.description && 'description', !s.websiteUrl && 'websiteUrl', !s.icons.length && 'icons'].filter(Boolean));
  if (missing.length) {
    f.suggest('server_info_fields', `Add ${and(missing)} to serverInfo. mcp.tc uses them for the listing, and clients show the title and icon.`);
  }
  if (s.icons.length) {
    const kind = (/** @type {{src: string, mimeType: string}} */ i) => (i.mimeType || i.src).toLowerCase();
    const usable = s.icons.filter((i) => !/svg|ico|x-icon/.test(kind(i)));
    if (!usable.length) f.warn('icons_format', 'Every icon is SVG or ICO, which mcp.tc skips. Add a PNG, WebP or JPEG icon.');
    const plain = s.icons.filter((i) => /^http:\/\//i.test(i.src));
    if (plain.length) f.warn('icons_http', 'Some icons use http URLs. Use https.');
  }
  if (!r.instructions) f.suggest('instructions_missing', 'The handshake has no instructions. A few sentences on how the tools fit together help the model use them.');
}

/**
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 */
function toolFindings(r, f) {
  if (!r.tools_listed) {
    if (r.tools_error && /sign-in/.test(r.tools_error)) {
      f.warn(
        'tools_need_sign_in',
        "tools/list needs sign-in, so mcp.tc can't show your tools and the listing explains why the list is empty. To check them with your own token: --header \"Authorization: Bearer YOUR_TOKEN\".",
      );
    } else if (r.capabilities && r.capabilities.length && !r.capabilities.includes('tools')) {
      f.ok('no_tools_capability', "The server doesn't offer tools (no tools capability).");
    } else {
      f.error('tools_failed', `tools/list failed: ${r.tools_error || 'no answer'}.`);
    }
    return;
  }
  if (r.tools_count === 0) {
    f.warn('tools_none', 'tools/list answered with no tools.');
    return;
  }
  f.ok('tools', `Lists ${r.tools_count} tool${r.tools_count === 1 ? '' : 's'}${r.tools_pages > 1 ? ` over ${r.tools_pages} pages` : ''}.`);
  if (r.tools_truncated) f.warn('tools_truncated', 'tools/list has more than 1,000 tools or 20 pages; this check stopped there. Clients may stop earlier.');
  if (r.tools_invalid) f.error('tool_invalid', `${r.tools_invalid} entr${r.tools_invalid === 1 ? 'y' : 'ies'} in tools/list ha${r.tools_invalid === 1 ? 's' : 've'} no name.`);
  const names = r.tools.map((t) => t.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length) f.error('tool_duplicate', `Tool names appear more than once: ${some(dupes)}. Each name must be unique.`);
  const odd = names.filter((n) => n.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(n));
  if (odd.length) f.warn('tool_name_chars', `Tool names should be 1 to 128 letters, digits, "_", "-" or ".": ${some(odd)}.`);
  const schema = r.tools.filter((t) => t.input_schema !== 'object').map((t) => t.name);
  if (schema.length) f.error('tool_input_schema', `Tools without an inputSchema of type "object": ${some(schema)}. Clients check this field and may refuse the whole list.`);
  const noDesc = r.tools.filter((t) => !t.description).map((t) => t.name);
  if (noDesc.length) f.warn('tool_description_missing', `Tools without a description: ${some(noDesc)}. Models and people can't tell what they do, and mcp.tc can't summarize them.`);
  const short = r.tools.filter((t) => t.description && t.description.length < SHORT_DESCRIPTION).map((t) => t.name);
  if (short.length) f.warn('tool_description_short', `Very short tool descriptions (under ${SHORT_DESCRIPTION} characters): ${some(short)}. Say what the tool does, what it returns and when to use it.`);
  const noRo = r.tools.filter((t) => t.read_only === null).map((t) => t.name);
  if (noRo.length) f.warn('tool_read_only_hint', `Tools without readOnlyHint: ${some(noRo)}. Without it, mcp.tc can't say which tools only read, and clients can't either.`);
  const noDestr = r.tools.filter((t) => t.read_only !== true && t.destructive === null).map((t) => t.name);
  if (noDestr.length) f.warn('tool_destructive_hint', `Tools that may change things but have no destructiveHint: ${some(noDestr)}. Set it so clients can warn before a delete or overwrite.`);
  if (!noDesc.length && !short.length && !noRo.length && !noDestr.length) f.ok('tools_annotated', 'Every tool has a description and the readOnlyHint and destructiveHint annotations it needs.');
  const noTitle = r.tools.filter((t) => !t.title).map((t) => t.name);
  if (noTitle.length) f.suggest('tool_title', `Tools without a title: ${some(noTitle)}. Clients show the title to people.`);
}

/**
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 */
function authFindings(r, f) {
  const a = r.auth;
  if (a.with_your_headers && r.mcp) {
    f.ok('auth_headers', 'The server answered with the headers you gave.');
  }
  if (a.kind === 'none' && !a.with_your_headers) f.ok('auth_none', 'Answers without sign-in.');
  if (a.kind === 'optional') f.ok('auth_optional', 'Answers without sign-in and also offers it (WWW-Authenticate on a successful answer).');
  if (a.kind === 'api_key') {
    f.ok('auth_key', 'Asks for a key or token (HTTP 401 without OAuth metadata). mcp.tc lists such servers as needing an API key.');
    f.suggest('key_header_docs', 'Say which header carries the key in your README and in server.json (remotes[].headers with isSecret: true), so setup guides can show it.');
  }
  if (a.kind !== 'oauth') return;
  const prm = a.prm;
  const header = a.challenge && a.challenge.params.resource_metadata;
  const mismatch = a.prm_attempts.find((p) => p.problem === 'resource_mismatch');
  if (!prm) {
    if (mismatch) {
      f.error('oauth_resource_mismatch', `The protected resource metadata at ${mismatch.url} names the resource ${mismatch.resource}, which doesn't cover ${maskUrl(r.endpoint)}. Clients refuse tokens for another resource.`);
    } else {
      f.warn('oauth_no_metadata', 'The server asks for OAuth sign-in but publishes no protected resource metadata (RFC 9728). Clients look for it first: serve it and point to it from WWW-Authenticate (resource_metadata).');
    }
  } else {
    f.ok('oauth_metadata', `Asks for OAuth sign-in and publishes protected resource metadata at ${prm.url}.`);
    if (!header) f.suggest('oauth_resource_metadata_param', 'Add resource_metadata="<metadata URL>" to the WWW-Authenticate challenge, so clients find the metadata without guessing.');
    if (!prm.authorization_servers.length) f.error('oauth_no_authorization_server', 'The protected resource metadata lists no authorization_servers, so clients don\'t know where to sign in.');
  }
  const as = a.as;
  if (as && !as.ok) {
    f.error(
      'oauth_as_metadata',
      as.problem === 'issuer_mismatch'
        ? `The authorization server metadata for ${as.issuer} names another issuer. Clients refuse it.`
        : `No authorization server metadata (RFC 8414 or OpenID Connect discovery) found for ${as.issuer}.`,
    );
  } else if (as && as.ok) {
    if (!as.code_challenge_methods_supported.includes('S256')) {
      f.error('oauth_pkce', 'The authorization server metadata doesn\'t list S256 in code_challenge_methods_supported. MCP clients must refuse to sign in without it.');
    }
    if (!as.registration_endpoint && !as.client_id_metadata_document_supported) {
      f.warn('oauth_registration', 'The authorization server offers neither dynamic client registration nor client ID metadata documents, so each user has to create a client ID by hand.');
    } else {
      f.ok('oauth_registration', 'Clients can register themselves with the authorization server.');
    }
  }
}

/**
 * @param {import('../lib/mcp.js').Report} r
 * @param {Findings} f
 */
function cardFindings(r, f) {
  if (r.transport === 'sse') return;
  const [recommended] = cardUrls(r.endpoint);
  const found = r.cards.filter((c) => c.found);
  for (const c of r.cards) {
    if (c.status === 200 && !c.found) f.error('card_not_json', `${maskUrl(c.url)} answered, but not with a JSON object.`);
  }
  if (!found.length) {
    f.suggest('card_missing', `No server card at ${maskUrl(recommended)}. Make one with: mcp-tc card --url ${maskUrl(r.endpoint)}`);
    return;
  }
  for (const c of found) {
    const { errors, warnings } = validateCard(c.card);
    const where = maskUrl(c.url);
    if (errors.length) f.error('card_invalid', `The server card at ${where} has problems: ${errors.map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`).join('; ')}.`);
    else f.ok('card', `Server card at ${where}.`);
    for (const w of warnings) f.warn('card_extra', `Server card at ${where}: ${w.message}.`);
    if (!/application\/(mcp-server-card\+)?json/i.test(c.content_type)) f.suggest('card_content_type', `${where} is served as "${c.content_type || 'no type'}"; use application/mcp-server-card+json.`);
    if (!c.cors) f.warn('card_cors', `${where} has no Access-Control-Allow-Origin header. The server card extension asks for "*", so browser-based clients can read it.`);
    if (r.server && typeof c.card.version === 'string' && r.server.version && c.card.version !== r.server.version) {
      f.warn('card_version', `The card at ${where} says version ${c.card.version}, the server says ${r.server.version}. Keep them in step.`);
    }
  }
  if (!found.some((c) => c.url === recommended)) {
    f.suggest('card_location', `Also serve the card at ${maskUrl(recommended)}, the location the server card extension recommends.`);
  }
}

/**
 * @param {Awaited<ReturnType<typeof rebindingTest>>} rb
 * @param {Findings} f
 */
function rebindingFindings(rb, f) {
  if (rb.origin.accepted === true) {
    f.error(
      'rebinding_origin',
      `The server accepted a request with a foreign Origin (${FOREIGN_ORIGIN}). A web page could reach it through DNS rebinding: refuse unknown Origins with HTTP 403, as the MCP specification requires.`,
    );
  } else if (rb.origin.accepted === false) {
    f.ok('rebinding_origin', `Refuses a foreign Origin (HTTP ${rb.origin.status}).`);
  } else {
    f.warn('rebinding_origin_untested', `Could not test a foreign Origin: ${rb.origin.error}.`);
  }
  if (rb.host.accepted === true) {
    f.warn('rebinding_host', 'The server accepted a request with a foreign Host header. Check Host as well (for example allowedHosts in the MCP TypeScript SDK), so DNS rebinding fails even when a request has no Origin.');
  } else if (rb.host.accepted === false) {
    f.ok('rebinding_host', `Refuses a foreign Host (HTTP ${rb.host.status}).`);
  } else {
    f.warn('rebinding_host_untested', `Could not test a foreign Host: ${rb.host.error}.`);
  }
}

// ------------------------------------------------------------------ a project folder

/** @param {string} dir @param {string[]} names */
function firstFile(dir, names) {
  for (const n of names) if (existsSync(join(dir, n))) return n;
  return null;
}

/**
 * Read a JSON file for check: problems become findings instead of errors.
 * @param {string} file
 * @param {string} label
 * @param {Findings} f
 * @param {string} id
 */
function readForCheck(file, label, f, id) {
  try {
    return readJsonFile(file);
  } catch {
    f.error(id, `${label} is not valid JSON.`);
    return undefined;
  }
}

/**
 * Findings for a project folder: package.json, server.json, a server card file, README, pyproject.toml.
 * @param {string} dir
 * @param {Findings} f
 * @param {{url: string|null, stdio?: boolean}} o
 */
export function projectFindings(dir, f, o) {
  const pkg = readForCheck(join(dir, 'package.json'), 'package.json', f, 'pkg_invalid_json');
  const sjName = firstFile(dir, ['server.json']);
  const sj = sjName ? readForCheck(join(dir, sjName), 'server.json', f, 'server_json_invalid_json') : null;
  const cardName = firstFile(dir, ['.well-known/mcp/server-card.json', 'public/.well-known/mcp/server-card.json', 'static/.well-known/mcp/server-card.json', 'server-card.json']);
  const card = cardName ? readForCheck(join(dir, cardName), cardName, f, 'card_file_invalid_json') : null;
  const readme = firstFile(dir, ['README.md', 'readme.md', 'README', 'README.markdown', 'Readme.md']);
  const pyproject = existsSync(join(dir, 'pyproject.toml')) ? readFileSync(join(dir, 'pyproject.toml'), 'utf8') : null;
  const project = { package_json: pkg !== null && pkg !== undefined, server_json: sjName, card_file: cardName, readme, pyproject: pyproject !== null };

  if (pkg === null && !pyproject && !sj) {
    f.error('pkg_missing', 'No package.json, pyproject.toml or server.json in this folder.');
    return project;
  }
  if (pkg && (typeof pkg !== 'object' || Array.isArray(pkg))) {
    f.error('pkg_invalid_json', 'package.json is not a JSON object.');
  } else if (pkg) {
    packageFindings(pkg, f, sj, o);
  }
  if (pyproject) pythonFindings(pyproject, readme ? readFileSync(join(dir, readme), 'utf8') : '', f, sj);

  if (sj !== null && sj !== undefined) {
    const { errors, warnings } = validateServerJson(sj);
    if (errors.length) f.error('server_json_invalid', `server.json has problems: ${errors.map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`).join('; ')}.`);
    else f.ok('server_json', 'server.json passes the 2025-12-11 schema rules this tool checks.');
    for (const w of warnings) f.warn('server_json_note', `server.json: ${w.path ? `${w.path}: ` : ''}${w.message}.`);
    if (pkg && typeof pkg === 'object' && !Array.isArray(pkg) && Array.isArray(sj.packages)) {
      for (const k of sj.packages) {
        if (k && k.registryType === 'npm' && k.identifier !== pkg.name) f.error('server_json_package', `server.json lists the npm package "${k.identifier}", but package.json is "${pkg.name}".`);
        else if (k && k.registryType === 'npm' && k.version && k.version !== pkg.version) {
          f.warn('server_json_package_version', `server.json lists npm version ${k.version}, package.json says ${pkg.version}. Keep them in step when you publish.`);
        }
      }
    }
    if (pkg && typeof pkg === 'object' && typeof sj.version === 'string' && pkg.version && sj.version !== pkg.version) {
      f.warn('server_json_version', `server.json says version ${sj.version}, package.json says ${pkg.version}.`);
    }
  } else if (sj === null) {
    f.suggest('server_json_missing', 'No server.json. Make one with: mcp-tc card --server-json server.json, then publish it to the official MCP Registry with mcp-publisher. mcp.tc reads registry entries too.');
  }

  if (card !== null && card !== undefined) {
    const { errors, warnings } = validateCard(card);
    if (errors.length) f.error('card_file_invalid', `${cardName} has problems: ${errors.map((e) => `${e.path ? `${e.path}: ` : ''}${e.message}`).join('; ')}.`);
    else f.ok('card_file', `${cardName} passes the server card rules.`);
    for (const w of warnings) f.warn('card_file_note', `${cardName}: ${w.message}.`);
    if (sj && typeof sj.name === 'string' && typeof card.name === 'string' && card.name !== sj.name) {
      f.warn('card_file_name', `${cardName} is named ${card.name}, server.json ${sj.name}. Use the same name.`);
    }
  } else if (o.url) {
    f.suggest('card_file_missing', 'No server card file. Make one with: mcp-tc card --url <your endpoint> --out .well-known/mcp/server-card.json, and serve it at <endpoint>/server-card.');
  }

  if (!readme) f.suggest('readme_missing', 'No README. mcp.tc reads it, and people look there first for setup steps.');
  return project;
}

/**
 * @param {Record<string, any>} pkg
 * @param {Findings} f
 * @param {any} sj
 * @param {{url: string|null, stdio?: boolean}} o
 */
function packageFindings(pkg, f, sj, o) {
  const nameOk = typeof pkg.name === 'string' && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(pkg.name) && pkg.name.length <= 214;
  const versionOk = typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version);
  if (!nameOk) f.error('pkg_name', 'package.json needs a valid npm name (lowercase, like my-server or @you/my-server).');
  if (!versionOk) f.error('pkg_version', 'package.json needs an exact version like 1.0.0.');
  if (nameOk && versionOk) f.ok('pkg', `package.json: ${pkg.name} ${pkg.version}.`);
  if (typeof pkg.description !== 'string' || !pkg.description.trim()) {
    f.warn('pkg_description', 'package.json has no description. npm, the registry and mcp.tc show it.');
  } else if (pkg.description.trim().length > 100) {
    f.suggest('pkg_description_long', `package.json's description is ${pkg.description.trim().length} characters. server.json and server cards allow 100: mcp-tc card will ask for a shorter one (--description).`);
  }
  if (pkg.mcpName !== undefined) {
    if (typeof pkg.mcpName !== 'string' || !NAME_RE.test(pkg.mcpName)) f.error('pkg_mcp_name', 'mcpName in package.json must look like namespace/name, for example io.github.you/weather.');
    else if (sj && typeof sj.name === 'string' && sj.name !== pkg.mcpName) {
      f.error('pkg_mcp_name_mismatch', `mcpName in package.json (${pkg.mcpName}) differs from the name in server.json (${sj.name}). The official registry wants them to match.`);
    } else f.ok('pkg_mcp_name', `package.json has mcpName ${pkg.mcpName}.`);
  } else if (pkg.bin && !pkg.private) {
    const guess = deriveName({ pkg, url: o.url, server: null }).name;
    f.suggest('pkg_mcp_name_missing', `Add "mcpName"${guess ? `: "${guess}"` : ''} to package.json. The official MCP Registry checks it to confirm the npm package is yours.`);
  }
  if (!repositoryOf(pkg.repository)) f.suggest('pkg_repository', 'Add repository.url to package.json. mcp.tc and the registry read your repository.');
  if (typeof pkg.homepage !== 'string' || !pkg.homepage) f.suggest('pkg_homepage', 'Add homepage to package.json, so the listing can link to your docs.');
  if (!pkg.license) f.suggest('pkg_license', 'Add a license to package.json.');
  if (pkg.private === true) f.suggest('pkg_private', 'package.json says "private": true, so npm won\'t publish it. Fine for a remote-only server.');
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  if (pkg.bin && !o.url && !o.stdio) {
    f.suggest('stdio_check', 'To check the server itself as well, add --stdio: mcp-tc starts it from "bin" with node and talks to it over stdio (it runs your code on this computer).');
  } else if (!pkg.bin && !o.url && !o.stdio && (scripts.start || scripts.dev)) {
    f.suggest('run_and_check', `To check the running server as well, start it (npm ${scripts.dev ? 'run dev' : 'start'}) and add --url http://localhost:<port>/mcp.`);
  } else if (!pkg.bin && !scripts.start && !o.url && !o.stdio) {
    f.suggest('pkg_bin', 'package.json has no "bin": a local server needs one so clients can start it with npx.');
  }
}

/**
 * @param {string} toml
 * @param {string} readme
 * @param {Findings} f
 * @param {any} sj
 */
function pythonFindings(toml, readme, f, sj) {
  const project = /\[project\]([\s\S]*?)(?:\n\[|$)/.exec(toml);
  const body = project ? project[1] : '';
  const field = (/** @type {string} */ k) => {
    const m = new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm').exec(body);
    return m ? m[1] : null;
  };
  if (!field('name')) f.error('py_name', 'pyproject.toml has no [project] name.');
  if (!field('version') && !/dynamic\s*=.*version/.test(body)) f.warn('py_version', 'pyproject.toml has no [project] version.');
  if (!field('description')) f.warn('py_description', 'pyproject.toml has no [project] description.');
  const tag = /mcp-name:\s*([a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+)/.exec(readme);
  if (!tag) {
    f.suggest('py_mcp_name', 'Add a line "mcp-name: <your registry name>" to the README (it can sit in an HTML comment). The official registry checks it to confirm the PyPI package is yours.');
  } else if (sj && typeof sj.name === 'string' && tag[1] !== sj.name) {
    f.error('py_mcp_name_mismatch', `The README says mcp-name: ${tag[1]}, server.json says ${sj.name}. The registry wants them to match.`);
  }
}

// ------------------------------------------------------------------ the command

/**
 * The command that starts a local server: --command split into words, or node with package.json's bin.
 * @param {string} dir
 * @param {string|undefined} command
 * @returns {string[]}
 */
export function stdioCommand(dir, command) {
  if (command !== undefined) {
    const words = splitCommand(command);
    if (!words.length || !words[0]) throw new UsageError('--command is empty.', {}, 'invalid_command');
    return words;
  }
  let pkg;
  try {
    pkg = readJsonFile(join(dir, 'package.json'));
  } catch {
    pkg = null;
  }
  const bin = pkg && typeof pkg === 'object' ? (typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin).find((v) => typeof v === 'string') : null) : null;
  if (!bin) {
    throw new UsageError('--stdio starts the server from package.json\'s "bin", and there is none here. Give the command instead: --command "<command>"', {}, 'no_bin');
  }
  const file = resolve(dir, /** @type {string} */ (bin));
  if (!existsSync(file)) throw new UsageError(`package.json's bin points to ${bin}, which doesn't exist yet. Build the project first, or use --command.`, {}, 'no_bin');
  return [process.execPath, file];
}

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const input = String(ctx.positionals[0] || '').trim();
  if (!input) throw new UsageError('Missing <url|dir>. Usage: mcp-tc check <url|dir>');
  const { headers } = parseHeaderOptions(ctx.args.header);
  const timeout = (ctx.args.timeout || DEFAULT_TIMEOUT_MS / 1000) * 1000;
  const f = new Findings();

  /** @type {string|null} */
  let dir = null;
  /** @type {string|null} */
  let url = null;
  /** @type {any} */
  let listing = null;
  const asPath = resolve(ctx.cwd, input);
  const ref = parseListingRef(input, ctx.base);
  if (ref.link) {
    const d = await mcpCall('get_server', { slug: ref.slug }, clientOptions(ctx));
    // the name comes from the directory: cleaned like every other text from mcp.tc before it reaches the terminal
    const name = clean(d.name, { oneLine: true }).slice(0, 120) || ref.slug;
    listing = { slug: d.slug, name: d.name, link: d.link };
    if (d.kind === 'local' || !d.endpoint) {
      throw new UsageError(`${name} runs locally, so there is no URL to check. Check its project folder instead: mcp-tc check <dir>`, {}, 'local_listing');
    }
    url = String(d.endpoint);
    ctx.out.info(`${name}: checking its own URL, ${clean(maskUrl(url), { oneLine: true })}`);
  } else if (!/^https?:\/\//i.test(input) && existsSync(asPath)) {
    if (!statSync(asPath).isDirectory()) throw new UsageError(`${input} is a file. Give the project folder or the server's URL.`, {}, 'not_a_folder');
    dir = asPath;
    if (ctx.args.url) {
      const t = classifyTarget(ctx.args.url, ctx.base);
      if (t.kind !== 'url') throw new UsageError('--url needs the server\'s URL, like http://localhost:3000/mcp.', {}, 'invalid_url');
      url = t.url;
    }
  } else {
    const t = classifyTarget(input, ctx.base);
    if (t.kind !== 'url') throw new UsageError(`"${clean(input, { oneLine: true })}" is not a URL or a folder here. Usage: mcp-tc check <url|dir>`, {}, 'invalid_target');
    if (ctx.args.url) throw new UsageError('--url goes with a folder: mcp-tc check <dir> --url <endpoint>', {}, 'usage');
    url = t.url;
  }
  if (!dir && (ctx.args.stdio || ctx.args.command !== undefined)) {
    throw new UsageError('--stdio and --command go with a folder: mcp-tc check <dir> --stdio', {}, 'usage');
  }

  /** @type {any} */
  let project = null;
  if (dir) project = projectFindings(dir, f, { url, stdio: Boolean(ctx.args.stdio || ctx.args.command) });

  /** @type {import('../lib/mcp.js').Report|null} */
  let local = null;
  if (dir && (ctx.args.stdio || ctx.args.command !== undefined)) {
    const argv = stdioCommand(dir, ctx.args.command);
    ctx.out.info(`Starting ${showCommand(argv)} in ${dir} ...`);
    local = await probeStdio(argv[0], argv.slice(1), { cwd: dir, env: ctx.env, timeout, bothEras: true, lists: true });
    stdioFindings(local, f);
  }

  /** @type {import('../lib/mcp.js').Report|null} */
  let report = null;
  /** @type {any} */
  let rebinding = null;
  if (url) {
    ctx.out.info(`Checking ${maskUrl(url)} ...`);
    report = await probe(url, { headers, timeout, bothEras: true, lists: true, cards: true });
    if (report.mcp && isLoopback(new URL(report.endpoint).hostname)) {
      rebinding = await rebindingTest(report, { headers, timeout });
    }
    endpointFindings(report, f, { rebinding });
  }

  const counts = { error: 0, warning: 0, suggestion: 0, ok: 0 };
  for (const x of f.list) counts[x.level]++;
  const readable = report || local ? (!report || answered(report)) && (!local || local.mcp) : null;
  if (readable === false) ctx.setExitCode(EXIT.UNREACHABLE);
  else if (counts.error) ctx.setExitCode(EXIT.PROBLEMS);
  const order = { error: 0, warning: 1, suggestion: 2, ok: 3 };
  const findings = [...f.list].sort((a, b) => order[a.level] - order[b.level]);
  return {
    target: dir ? { kind: 'dir', dir, url: url ? maskUrl(url) : null, command: local ? local.url : null } : { kind: 'url', url: maskUrl(/** @type {string} */ (url)) },
    listing,
    passed: counts.error === 0 && readable !== false,
    readable,
    counts,
    findings,
    project,
    report: report ? summarize(report) : null,
    stdio: local ? summarize(local) : null,
    rebinding,
    schemas: { card: CARD_SCHEMA, server_json: SERVER_JSON_SCHEMA },
    note: NOTE,
  };
}

const MARK = { error: 'error', warning: 'warn ', suggestion: 'tip  ', ok: 'ok   ' };

/**
 * @param {any} r
 * @param {import('../lib/output.js').Output} out
 */
export function render(r, out) {
  const head = r.target.kind === 'dir' ? `Checked ${r.target.dir}${r.target.url ? ` and ${r.target.url}` : ''}${r.target.command ? ' over stdio' : ''}` : `Checked ${r.target.url}`;
  out.print(out.style.bold(head));
  if (r.stdio) out.print(out.fields(reportRows(r.stdio), { indent: 2 }));
  if (r.report) {
    out.print(out.fields(reportRows(r.report), { indent: 2 }));
  }
  out.print('');
  /** @type {Record<string, (s: string) => string>} */
  const color = { error: out.style.red, warning: out.style.yellow, suggestion: out.style.cyan, ok: out.style.green };
  for (const x of r.findings) {
    const lines = out.paragraph(x.message, { indent: 8 }).split('\n');
    lines[0] = `  ${color[x.level](MARK[/** @type {keyof typeof MARK} */ (x.level)])} ${lines[0].slice(8)}`;
    out.print(lines.join('\n'));
  }
  out.print('');
  const c = r.counts;
  const plural = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const summary = `${plural(c.error, 'error')}, ${plural(c.warning, 'warning')}, ${plural(c.suggestion, 'suggestion')}.`;
  if (r.readable === false) out.print(out.style.red(`The server is not readable. ${summary}`));
  else out.print(c.error ? out.style.red(summary) : out.style.green(summary));
  out.print(out.style.dim(r.note));
}
