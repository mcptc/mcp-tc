// mcp-tc card: make a server card (the MCP server card extension, SEP-2127) and a server.json for the official MCP
// Registry (schema 2025-12-11) from package.json, and from a handshake with the running server when --url is given.
// The card holds only the fields of the extension's ServerCard: no tools, resources, prompts or capabilities (clients
// read those live). Both documents are checked here with built-in rules; the test suite validates them against the
// official JSON schemas too.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseListingRef } from '../lib/directory.js';
import { CliError, EXIT, UsageError } from '../lib/errors.js';
import { KNOWN_VERSIONS, isLoopback, maskUrl, normalizeEndpoint, parseHeaderOptions, probe, secretsInUrl, txt } from '../lib/mcp.js';
import { confirm } from '../lib/prompt.js';

export const CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
export const SERVER_JSON_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
export const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const RANGE_RE = /^[\^~<>=*]|^\d+\.x|\.x$|\.\*$|^\*$|\s-\s|\|\|/;
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'card',
  summary: 'Make a server card and a server.json for the MCP Registry',
  usage: 'card [dir] [options]',
  description:
    'Builds two documents from package.json in [dir] (default: the current folder), and from a handshake with the running server when you give --url: a server card (the MCP server card extension, SEP-2127: name, title, description, version, links, icons and remote URLs, never tools or capabilities) and a server.json for the official MCP Registry (schema 2025-12-11, with an npm package for a package that has a bin entry and a remote for --url). Prints both unless you name files with --out and --server-json. Serve the card at <your endpoint>/server-card, the location the extension recommends; some scanners also look at /.well-known/mcp/server-card.json.',
  args: [{ name: 'dir' }],
  options: {
    out: { type: 'string', valueName: 'file', description: 'Write the server card to this file (for example .well-known/mcp/server-card.json)' },
    'server-json': { type: 'string', valueName: 'file', description: 'Write server.json to this file (for example server.json)' },
    url: { type: 'string', valueName: 'endpoint', description: "Your server's public MCP URL: added as a remote, and read with a handshake for its name, version, icons and protocol versions" },
    offline: { type: 'boolean', description: "With --url: don't connect, only add the URL as a remote" },
    name: { type: 'string', valueName: 'namespace/name', description: 'Registry name, like io.github.you/weather (default: mcpName in package.json, else from the repository or homepage)' },
    title: { type: 'string', valueName: 'text', description: 'Display title (100 characters at most)' },
    description: { type: 'string', valueName: 'text', description: 'Description (100 characters at most; default: package.json description)' },
    header: { type: 'string', multiple: true, valueName: '"Name: value"', description: 'Send this header on the handshake, for a server that needs a token. Never written to the files.' },
    timeout: { type: 'string', valueName: 'seconds', int: { min: 1, max: 120 }, description: 'Seconds to wait for each answer (default 15)' },
    yes: { type: 'boolean', short: 'y', description: 'Overwrite existing files without asking' },
  },
  examples: [
    'mcp-tc card',
    'mcp-tc card --url https://mcp.example.com/mcp --out .well-known/mcp/server-card.json --server-json server.json',
    'mcp-tc card ./my-server --name io.github.you/my-server --json',
  ],
  exits: [
    [0, 'documents built, and written where you named files'],
    [1, 'an error, including a file that could not be written, or Ctrl+D at the question'],
    [2, "usage error, including a package.json that isn't valid JSON, an mcp.tc listing link as --url, or files to overwrite with no terminal to ask (pass --yes)"],
    [5, "--url: the server couldn't be read (add --offline to use the URL without connecting)"],
    [130, 'Ctrl+C at the question: nothing was written'],
  ],
};

// ------------------------------------------------------------------ validation (built-in rules, no dependencies)

/**
 * @typedef {{path: string, message: string}} Problem
 */

/** @param {unknown} v */
function isObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v */
function isUri(v) {
  if (typeof v !== 'string' || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return Boolean(u.protocol);
  } catch {
    return false;
  }
}

/**
 * Rules shared by the card and server.json: name, description, version, title, websiteUrl, repository, icons.
 * @param {Record<string, any>} d
 * @param {Problem[]} p
 * @param {{iconTypes?: string[], iconMax?: number}} [o]
 */
function commonRules(d, p, o = {}) {
  if (typeof d.name !== 'string') p.push({ path: 'name', message: 'name is required: a reverse-DNS name like io.github.you/weather' });
  else if (d.name.length < 3 || d.name.length > 200 || !NAME_RE.test(d.name)) {
    p.push({ path: 'name', message: `name "${txt(d.name, 80)}" must look like namespace/name (letters, digits, dots and hyphens, one slash), 3 to 200 characters` });
  }
  if (typeof d.description !== 'string' || d.description.length < 1) p.push({ path: 'description', message: 'description is required' });
  else if (d.description.length > 100) p.push({ path: 'description', message: `description is ${d.description.length} characters; 100 at most` });
  if (typeof d.version !== 'string' || !d.version) p.push({ path: 'version', message: 'version is required, like 1.0.0' });
  else if (d.version.length > 255 || RANGE_RE.test(d.version) || d.version === 'latest') {
    p.push({ path: 'version', message: `version "${txt(d.version, 40)}" must be one exact version, not a range or "latest"` });
  }
  if (d.title !== undefined && (typeof d.title !== 'string' || d.title.length < 1 || d.title.length > 100)) {
    p.push({ path: 'title', message: 'title must be 1 to 100 characters' });
  }
  if (d.websiteUrl !== undefined && !isUri(d.websiteUrl)) p.push({ path: 'websiteUrl', message: 'websiteUrl must be a full URL' });
  if (d.repository !== undefined) {
    if (!isObj(d.repository)) p.push({ path: 'repository', message: 'repository must be an object with url and source' });
    else {
      if (!isUri(d.repository.url)) p.push({ path: 'repository.url', message: 'repository.url must be a full URL' });
      if (typeof d.repository.source !== 'string') p.push({ path: 'repository.source', message: 'repository.source is required, like "github"' });
    }
  }
  if (d.icons !== undefined) {
    if (!Array.isArray(d.icons)) p.push({ path: 'icons', message: 'icons must be a list' });
    else {
      d.icons.forEach((/** @type {any} */ i, /** @type {number} */ n) => {
        if (!isObj(i) || !isUri(i.src)) p.push({ path: `icons[${n}].src`, message: 'each icon needs src, a full URL' });
        else if (o.iconMax && i.src.length > o.iconMax) p.push({ path: `icons[${n}].src`, message: `icon src is longer than ${o.iconMax} characters` });
        if (isObj(i) && i.theme !== undefined && !['light', 'dark'].includes(i.theme)) p.push({ path: `icons[${n}].theme`, message: 'theme must be light or dark' });
        if (isObj(i) && i.sizes !== undefined && !(Array.isArray(i.sizes) && i.sizes.every((/** @type {unknown} */ s) => typeof s === 'string'))) {
          p.push({ path: `icons[${n}].sizes`, message: 'sizes must be a list of strings like "128x128"' });
        } else if (o.iconTypes && isObj(i) && Array.isArray(i.sizes) && i.sizes.some((/** @type {string} */ s) => !/^(\d+x\d+|any)$/.test(s))) {
          p.push({ path: `icons[${n}].sizes`, message: 'sizes must look like "128x128" or "any"' });
        }
        if (o.iconTypes && isObj(i) && i.mimeType !== undefined && !o.iconTypes.includes(i.mimeType)) {
          p.push({ path: `icons[${n}].mimeType`, message: `mimeType must be one of ${o.iconTypes.join(', ')}` });
        }
      });
    }
  }
  if (d._meta !== undefined && !isObj(d._meta)) p.push({ path: '_meta', message: '_meta must be an object' });
}

/**
 * @param {unknown} list
 * @param {string} at
 * @param {Problem[]} p
 */
function headerRules(list, at, p) {
  if (list === undefined) return;
  if (!Array.isArray(list)) {
    p.push({ path: at, message: 'headers must be a list' });
    return;
  }
  list.forEach((h, n) => {
    if (!isObj(h) || typeof h.name !== 'string' || !h.name) p.push({ path: `${at}[${n}].name`, message: 'each header needs a name' });
  });
}

/**
 * Check a server card against the extension's ServerCard rules. Returns errors, and warnings for things the schema
 * allows but the extension says not to do.
 * @param {unknown} doc
 * @returns {{errors: Problem[], warnings: Problem[]}}
 */
export function validateCard(doc) {
  /** @type {Problem[]} */
  const errors = [];
  /** @type {Problem[]} */
  const warnings = [];
  if (!isObj(doc)) return { errors: [{ path: '', message: 'a server card is a JSON object' }], warnings };
  const d = /** @type {Record<string, any>} */ (doc);
  if (d.$schema !== CARD_SCHEMA) errors.push({ path: '$schema', message: `$schema must be ${CARD_SCHEMA}` });
  commonRules(d, errors);
  if (d.remotes !== undefined) {
    if (!Array.isArray(d.remotes)) errors.push({ path: 'remotes', message: 'remotes must be a list' });
    else {
      d.remotes.forEach((/** @type {any} */ r, /** @type {number} */ n) => {
        if (!isObj(r)) return errors.push({ path: `remotes[${n}]`, message: 'each remote is an object' });
        if (!['streamable-http', 'sse'].includes(r.type)) errors.push({ path: `remotes[${n}].type`, message: 'type must be streamable-http or sse' });
        if (typeof r.url !== 'string' || !/^(https?:\/\/\S+|\{[a-zA-Z_][a-zA-Z0-9_]*\}\S*)$/.test(r.url)) {
          errors.push({ path: `remotes[${n}].url`, message: 'url must be an http(s) URL' });
        }
        headerRules(r.headers, `remotes[${n}].headers`, errors);
        if (r.supportedProtocolVersions !== undefined && !(Array.isArray(r.supportedProtocolVersions) && r.supportedProtocolVersions.every((/** @type {unknown} */ v) => typeof v === 'string'))) {
          errors.push({ path: `remotes[${n}].supportedProtocolVersions`, message: 'supportedProtocolVersions must be a list of strings' });
        }
      });
    }
  }
  for (const k of ['tools', 'prompts', 'resources', 'capabilities', 'packages']) {
    if (k in d) warnings.push({ path: k, message: `server cards don't carry ${k}: clients read them from the server itself` });
  }
  return { errors, warnings };
}

/**
 * Check a server.json against the 2025-12-11 schema's rules, plus what the official registry adds.
 * @param {unknown} doc
 * @returns {{errors: Problem[], warnings: Problem[]}}
 */
export function validateServerJson(doc) {
  /** @type {Problem[]} */
  const errors = [];
  /** @type {Problem[]} */
  const warnings = [];
  if (!isObj(doc)) return { errors: [{ path: '', message: 'server.json is a JSON object' }], warnings };
  const d = /** @type {Record<string, any>} */ (doc);
  if (d.$schema !== undefined && !isUri(d.$schema)) errors.push({ path: '$schema', message: '$schema must be a URL' });
  else if (d.$schema !== SERVER_JSON_SCHEMA) warnings.push({ path: '$schema', message: `this tool checks against ${SERVER_JSON_SCHEMA}` });
  commonRules(d, errors, { iconTypes: ICON_TYPES, iconMax: 255 });
  if (d.packages !== undefined) {
    if (!Array.isArray(d.packages)) errors.push({ path: 'packages', message: 'packages must be a list' });
    else {
      d.packages.forEach((/** @type {any} */ k, /** @type {number} */ n) => {
        const at = `packages[${n}]`;
        if (!isObj(k)) return errors.push({ path: at, message: 'each package is an object' });
        if (typeof k.registryType !== 'string' || !k.registryType) errors.push({ path: `${at}.registryType`, message: 'registryType is required, like "npm"' });
        if (typeof k.identifier !== 'string' || !k.identifier) errors.push({ path: `${at}.identifier`, message: 'identifier is required: the package name' });
        if (k.version !== undefined && (typeof k.version !== 'string' || !k.version || k.version === 'latest')) {
          errors.push({ path: `${at}.version`, message: 'version must be one exact version, not "latest"' });
        } else if (typeof k.version === 'string' && RANGE_RE.test(k.version)) {
          errors.push({ path: `${at}.version`, message: 'version must be one exact version, not a range' });
        }
        if (k.registryBaseUrl !== undefined && !isUri(k.registryBaseUrl)) errors.push({ path: `${at}.registryBaseUrl`, message: 'registryBaseUrl must be a full URL' });
        if (k.fileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(k.fileSha256))) errors.push({ path: `${at}.fileSha256`, message: 'fileSha256 must be 64 lowercase hex characters' });
        const t = k.transport;
        if (!isObj(t) || !['stdio', 'streamable-http', 'sse'].includes(t.type)) {
          errors.push({ path: `${at}.transport`, message: 'transport is required: {"type": "stdio"} for a local package' });
        } else if (t.type !== 'stdio' && (typeof t.url !== 'string' || !/^https?:\/\/\S+$/.test(t.url))) {
          errors.push({ path: `${at}.transport.url`, message: 'an http transport needs a url' });
        }
        headerRules(k.environmentVariables, `${at}.environmentVariables`, errors);
      });
    }
  }
  if (d.remotes !== undefined) {
    if (!Array.isArray(d.remotes)) errors.push({ path: 'remotes', message: 'remotes must be a list' });
    else {
      d.remotes.forEach((/** @type {any} */ r, /** @type {number} */ n) => {
        if (!isObj(r)) return errors.push({ path: `remotes[${n}]`, message: 'each remote is an object' });
        if (!['streamable-http', 'sse'].includes(r.type)) errors.push({ path: `remotes[${n}].type`, message: 'type must be streamable-http or sse' });
        if (typeof r.url !== 'string' || !/^https?:\/\/\S+$/.test(r.url)) errors.push({ path: `remotes[${n}].url`, message: 'url must be an http(s) URL' });
        headerRules(r.headers, `remotes[${n}].headers`, errors);
      });
    }
  }
  if (isObj(d._meta)) {
    for (const k of Object.keys(d._meta)) {
      if (k !== 'io.modelcontextprotocol.registry/publisher-provided') {
        warnings.push({ path: `_meta.${k}`, message: 'the official registry keeps only _meta["io.modelcontextprotocol.registry/publisher-provided"]' });
      }
    }
  }
  if (!Array.isArray(d.packages) && !Array.isArray(d.remotes)) {
    warnings.push({ path: '', message: 'neither packages nor remotes: clients have nothing to install or connect to' });
  }
  return { errors, warnings };
}

// ------------------------------------------------------------------ building

/**
 * The repository from package.json as {url, source, subfolder?}, or null.
 * @param {unknown} repo package.json "repository" (a string or {type, url, directory})
 */
export function repositoryOf(repo) {
  let raw = typeof repo === 'string' ? repo : isObj(repo) && typeof (/** @type {any} */ (repo).url) === 'string' ? /** @type {any} */ (repo).url : '';
  const dir = isObj(repo) && typeof (/** @type {any} */ (repo).directory) === 'string' ? /** @type {any} */ (repo).directory : '';
  raw = raw.trim();
  if (!raw) return null;
  const short = /^(github|gitlab|bitbucket):([\w.-]+\/[\w.-]+)$/.exec(raw) || (/^([\w.-]+\/[\w.-]+)$/.test(raw) ? [raw, 'github', raw] : null);
  let url;
  if (short) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[/** @type {'github'} */ (short[1])];
    url = `https://${host}/${short[2]}`;
  } else {
    const m = /^(?:git\+)?(?:(?:https?|ssh|git):\/\/)?(?:git@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(raw);
    if (!m) return null;
    url = `https://${m[1].replace(/^www\./, '')}/${m[2].replace(/\.git$/, '')}`;
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const source = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket' : host === 'codeberg.org' ? 'codeberg' : host.split('.')[0];
  /** @type {{url: string, source: string, subfolder?: string}} */
  const out = { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, source };
  const sub = dir.replace(/^\.?\/+|\/+$/g, '');
  if (sub) out.subfolder = sub;
  return out;
}

/** @param {string} s */
function namePart(s) {
  return s
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100);
}

/** @param {string} host */
function reverseHost(host) {
  return host.toLowerCase().replace(/^www\./, '').split('.').reverse().join('.');
}

const CODE_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|npmjs\.com|npmjs\.org|pypi\.org|github\.io)$/i;

/**
 * The registry name: --name, mcpName in package.json, the GitHub repository, the homepage's domain, the npm scope, or
 * the server URL's host. The official registry accepts io.github.<user>/* after a GitHub login and <reversed domain>/*
 * after a DNS or HTTP check of that domain.
 * @param {{pkg: any, url: string|null, server: any, name?: string}} src
 * @returns {{name: string|null, from: string, note: string|null}}
 */
export function deriveName({ pkg, url, server, name }) {
  if (name) return { name, from: '--name', note: null };
  if (pkg && typeof pkg.mcpName === 'string' && pkg.mcpName) return { name: pkg.mcpName, from: 'package.json mcpName', note: null };
  const short = namePart((pkg && typeof pkg.name === 'string' && pkg.name) || (server && server.name) || '');
  const repo = pkg ? repositoryOf(pkg.repository) : null;
  if (repo && repo.source === 'github') {
    const [owner, project] = new URL(repo.url).pathname.split('/').filter(Boolean);
    const part = short || namePart(project || '');
    if (owner && part) return { name: `io.github.${owner}/${part}`, from: 'repository', note: `Publishing under io.github.${owner} needs a GitHub login as ${owner} (or as an owner of that organization).` };
  }
  const home = pkg && typeof pkg.homepage === 'string' ? pkg.homepage : '';
  if (home) {
    try {
      const h = new URL(home).hostname;
      if (!CODE_HOSTS.test(h) && h.includes('.') && short) {
        return { name: `${reverseHost(h)}/${short}`, from: 'homepage', note: `Publishing under ${reverseHost(h)} needs a DNS or HTTP check of ${h.replace(/^www\./, '')}.` };
      }
    } catch {
      // not a URL
    }
  }
  const scope = pkg && typeof pkg.name === 'string' ? /^@([^/]+)\//.exec(pkg.name) : null;
  if (scope && short) {
    return { name: `io.github.${scope[1]}/${short}`, from: 'npm scope', note: `This assumes the npm scope @${scope[1]} is also your GitHub user or organization. If not, pass --name.` };
  }
  if (url) {
    const h = new URL(url).hostname;
    const part = short || namePart(h.split('.')[0]);
    if (!isLoopback(h) && h.includes('.') && part) {
      return { name: `${reverseHost(h)}/${part}`, from: 'server URL', note: `Publishing under ${reverseHost(h)} needs a DNS or HTTP check of that domain.` };
    }
  }
  return { name: null, from: 'none', note: null };
}

/**
 * Build both documents.
 * @param {{pkg: any, report: import('../lib/mcp.js').Report|null, url: string|null, name?: string, title?: string, description?: string}} src
 */
export function buildDocuments({ pkg, report, url, name, title, description }) {
  /** @type {string[]} */
  const notes = [];
  const server = report && report.server ? report.server : null;
  const n = deriveName({ pkg, url, server, name });
  if (!n.name) {
    throw new UsageError('Could not work out a registry name: add "mcpName" to package.json, a GitHub repository, or pass --name io.github.you/your-server.', {}, 'no_name');
  }
  if (n.note) notes.push(n.note);
  if (pkg && n.from !== '--name' && n.from !== 'package.json mcpName' && pkg.bin) {
    notes.push(`The official registry checks that an npm package is yours through "mcpName" in package.json: add "mcpName": "${n.name}" before you publish to npm.`);
  }
  if (pkg && pkg.mcpName && name && pkg.mcpName !== name) notes.push(`package.json says mcpName "${txt(pkg.mcpName, 100)}", which differs from --name: the registry wants them to match.`);

  const desc = description ?? (pkg && typeof pkg.description === 'string' && pkg.description.trim() ? pkg.description.trim() : '') ?? '';
  const finalDesc = desc || (server && server.description ? server.description : '');
  if (!finalDesc) throw new UsageError('No description: add one to package.json or pass --description "What the server does".', {}, 'no_description');
  if (finalDesc.length > 100) {
    throw new UsageError(
      `The description is ${finalDesc.length} characters; server cards and server.json allow 100. Pass a shorter one with --description.`,
      { length: finalDesc.length },
      'description_too_long',
    );
  }
  const version = (pkg && typeof pkg.version === 'string' && pkg.version) || (server && server.version) || '';
  if (!version) throw new UsageError('No version: add one to package.json.', {}, 'no_version');
  const t = title ?? ((server && server.title) || (pkg && typeof pkg.displayName === 'string' ? pkg.displayName : ''));
  if (t && t.length > 100) throw new UsageError('The title is longer than 100 characters.', {}, 'title_too_long');
  const homepage = pkg && typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage) ? pkg.homepage : server && server.websiteUrl ? server.websiteUrl : '';
  const repo = pkg ? repositoryOf(pkg.repository) : null;
  const icons = server
    ? server.icons
        .filter((/** @type {any} */ i) => /^https:\/\//.test(i.src))
        .map((/** @type {any} */ i) => ({ src: i.src, ...(i.mimeType ? { mimeType: i.mimeType } : {}), ...(i.sizes.length ? { sizes: i.sizes } : {}) }))
    : [];
  if (server && server.icons.some((/** @type {any} */ i) => i.src.startsWith('data:'))) notes.push('Icons given as data: URIs were left out: a card links to icons by https URL.');

  /** @type {Record<string, any>} */
  const card = { $schema: CARD_SCHEMA, name: n.name };
  if (t) card.title = t;
  card.description = finalDesc;
  card.version = version;
  if (homepage) card.websiteUrl = homepage;
  if (repo) card.repository = repo;
  if (icons.length) card.icons = icons;

  /** @type {Record<string, any>} */
  const sj = { $schema: SERVER_JSON_SCHEMA, name: n.name };
  if (t) sj.title = t;
  sj.description = finalDesc;
  sj.version = version;
  if (homepage) sj.websiteUrl = homepage;
  if (repo) sj.repository = repo;
  const sjIcons = icons
    .filter((/** @type {any} */ i) => i.src.length <= 255)
    .map((/** @type {any} */ i) => {
      /** @type {Record<string, any>} */
      const o = { src: i.src };
      if (i.mimeType && ICON_TYPES.includes(i.mimeType)) o.mimeType = i.mimeType;
      const sizes = (i.sizes || []).filter((/** @type {string} */ s) => /^(\d+x\d+|any)$/.test(s));
      if (sizes.length) o.sizes = sizes;
      return o;
    });
  if (sjIcons.length) sj.icons = sjIcons;

  if (pkg && pkg.bin && !pkg.private && typeof pkg.name === 'string') {
    sj.packages = [{ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } }];
    notes.push('If the server reads keys or settings from the environment, list them in packages[0].environmentVariables (isSecret: true for keys).');
  } else if (pkg && pkg.private) {
    notes.push('package.json says "private": true, so server.json has no npm package.');
  } else if (pkg && !pkg.bin && !url) {
    notes.push('package.json has no "bin", so there is no npm package to run with npx; give --url for a remote server.');
  }

  if (url) {
    const transport = report && report.transport === 'sse' ? 'sse' : 'streamable-http';
    /** @type {Record<string, any>} */
    const remote = { type: transport, url };
    const versions = new Set([...(report ? report.supported_versions : []), ...((report && report.legacy_versions) || [])]);
    if (report && report.eras.legacy && report.eras.legacy.ok && report.eras.legacy.protocol_version) versions.add(report.eras.legacy.protocol_version);
    const sorted = [...versions].sort((a, b) => (KNOWN_VERSIONS.indexOf(a) === -1 ? 99 : KNOWN_VERSIONS.indexOf(a)) - (KNOWN_VERSIONS.indexOf(b) === -1 ? 99 : KNOWN_VERSIONS.indexOf(b)));
    card.remotes = [sorted.length ? { ...remote, supportedProtocolVersions: sorted } : remote];
    sj.remotes = [remote];
    if (isLoopback(new URL(url).hostname)) notes.push('The URL points to this computer: publish your public URL instead before you share these files.');
    if (report && report.auth.kind === 'api_key') {
      notes.push('The server asks for a key: add remotes[0].headers with the header name (isRequired: true, isSecret: true), so clients ask for it.');
    }
    if (report && report.transport === 'sse') notes.push('The server uses the older HTTP+SSE transport; Streamable HTTP is what current clients expect.');
  } else {
    notes.push('A server card describes a remote server: with no --url it has no remotes, and server.json is what the registry needs.');
  }
  return { card, serverJson: sj, name: n.name, nameFrom: n.from, notes };
}

// ------------------------------------------------------------------ the command

/**
 * Read and parse a JSON file, or null when it doesn't exist.
 * @param {string} file
 */
export function readJsonFile(file) {
  if (!existsSync(file)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError('read_failed', `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`, EXIT.ERROR);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new CliError('invalid_json', `${file} is not valid JSON.`, EXIT.USAGE, { file });
  }
}

/**
 * Write a JSON file (run() has asked about overwriting before anything is written).
 * @param {string} path absolute
 * @param {string} file as the person gave it
 * @param {unknown} doc
 */
function writeJson(path, file, doc) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (err) {
    throw new CliError('write_failed', `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}`, EXIT.ERROR, { file });
  }
}

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const dir = resolve(ctx.cwd, ctx.positionals[0] || '.');
  const pkgFile = join(dir, 'package.json');
  const pkg = readJsonFile(pkgFile);
  if (pkg !== null && !isObj(pkg)) throw new CliError('invalid_json', `${pkgFile} is not a JSON object.`, EXIT.USAGE);
  const rawUrl = ctx.args.url;
  if (!pkg && !rawUrl) {
    throw new UsageError(`No package.json in ${dir}. Run it in your server's folder, or give --url with your server's URL (and --name).`, {}, 'no_project');
  }
  if (ctx.args.name !== undefined && (!NAME_RE.test(ctx.args.name) || ctx.args.name.length < 3 || ctx.args.name.length > 200)) {
    throw new UsageError('--name must look like namespace/name, for example io.github.you/weather.', {}, 'invalid_name');
  }
  let url = null;
  /** @type {import('../lib/mcp.js').Report|null} */
  let report = null;
  if (rawUrl) {
    url = normalizeEndpoint(rawUrl);
    // the listing page on mcp.tc is not an endpoint: as a remote it would send registry clients to a web page
    const ref = parseListingRef(url, ctx.base);
    if (ref.link) {
      throw new UsageError(
        `That is the mcp.tc page of the listing "${ref.slug}", not your server. Pass your server's own MCP URL with --url.`,
        { slug: ref.slug },
        'listing_link',
      );
    }
    const secrets = secretsInUrl(url).filter((s) => s.kind === 'key');
    if (secrets.length) {
      throw new UsageError('The URL seems to contain a key or token. A server card and server.json are public: give the URL without it.', {}, 'secret_in_url');
    }
    const u = new URL(url);
    if (u.search) {
      u.search = '';
      url = u.href;
    }
    if (!ctx.args.offline) {
      const { headers } = parseHeaderOptions(ctx.args.header);
      ctx.out.info(`Reading ${maskUrl(url)} ...`);
      report = await probe(url, { headers, timeout: (ctx.args.timeout || 15) * 1000, bothEras: true, legacyVersions: true, lists: false });
      if (!report.mcp && !(report.reachable && ['oauth', 'api_key'].includes(String(report.auth.kind)))) {
        throw new CliError(
          'unreachable',
          `Could not read the server at ${maskUrl(url)}: ${report.error || 'no MCP reply'}. Fix it, or add --offline to use the URL without connecting.`,
          EXIT.UNREACHABLE,
          { url: maskUrl(url) },
        );
      }
      if (report.endpoint !== url && report.redirects.length) url = new URL(report.endpoint).href;
    }
  }
  const built = buildDocuments({ pkg, report, url, name: ctx.args.name, title: ctx.args.title, description: ctx.args.description });
  const cardCheck = validateCard(built.card);
  const sjCheck = validateServerJson(built.serverJson);
  if (cardCheck.errors.length || sjCheck.errors.length) {
    const first = [...cardCheck.errors, ...sjCheck.errors][0];
    throw new CliError('invalid_document', `The generated documents don't pass the schema rules: ${first.path} ${first.message}.`, EXIT.ERROR, {
      card_errors: cardCheck.errors,
      server_json_errors: sjCheck.errors,
    });
  }
  // every target is checked, and one question covers the files that exist, before anything is written: a refusal
  // (or no terminal to ask in) leaves both files as they were
  /** @type {{kind: string, given: string, path: string, doc: unknown}[]} */
  const targets = [];
  if (ctx.args.out) targets.push({ kind: 'card', given: ctx.args.out, path: resolve(ctx.cwd, ctx.args.out), doc: built.card });
  if (ctx.args['server-json']) targets.push({ kind: 'server_json', given: ctx.args['server-json'], path: resolve(ctx.cwd, ctx.args['server-json']), doc: built.serverJson });
  if (targets.length === 2 && targets[0].path === targets[1].path) {
    throw new UsageError('--out and --server-json name the same file. Give each document its own file.', {}, 'same_file');
  }
  const existing = targets.filter((t) => existsSync(t.path));
  let write = true;
  if (existing.length) {
    const names = existing.map((t) => t.given);
    const q = names.length === 1 ? `${names[0]} exists. Overwrite it?` : `${names.join(' and ')} exist. Overwrite them?`;
    write = await confirm(q, { yes: ctx.args.yes, stdin: ctx.stdin, stderr: ctx.stderr });
  }
  /** @type {{kind: string, file: string, written: boolean}[]} */
  const files = [];
  for (const t of targets) {
    if (write) writeJson(t.path, t.given, t.doc);
    files.push({ kind: t.kind, file: t.path, written: write });
  }
  return {
    dir,
    name: built.name,
    name_from: built.nameFrom,
    url: url ? maskUrl(url) : null,
    handshake: report ? { era: report.era, protocol_version: report.protocol_version, supported_versions: report.supported_versions, transport: report.transport, auth: report.auth.kind } : null,
    card: built.card,
    server_json: built.serverJson,
    files,
    notes: built.notes,
  };
}

/**
 * @param {any} r
 * @param {import('../lib/output.js').Output} out
 */
export function render(r, out) {
  // a document is printed unless it went into a file
  const show = (/** @type {string} */ kind) => !r.files.some((/** @type {any} */ f) => f.kind === kind && f.written);
  if (show('card')) {
    out.print(out.style.bold('Server card (serve it at <your endpoint>/server-card):'));
    out.print(JSON.stringify(r.card, null, 2));
    out.print('');
  }
  if (show('server_json')) {
    out.print(out.style.bold('server.json (for the official MCP Registry, schema 2025-12-11):'));
    out.print(JSON.stringify(r.server_json, null, 2));
    out.print('');
  }
  for (const f of r.files) {
    out.print(f.written ? `Wrote ${f.kind === 'card' ? 'the server card' : 'server.json'} to ${f.file}` : `Did not write ${f.file}.`);
  }
  out.print(`Name: ${r.name} (from ${r.name_from})`);
  for (const n of r.notes) out.print(`- ${n}`);
  if (show('card') || show('server_json')) out.print(out.style.dim('Write them with --out <file> and --server-json <file>.'));
  out.print(out.style.dim('Publish server.json with the official mcp-publisher tool: https://github.com/modelcontextprotocol/registry'));
}
