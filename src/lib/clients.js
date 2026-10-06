// MCP client config files: where each client keeps its servers, and careful read, merge, backup, diff and write
// helpers for `add` (writes one entry) and `scan` (only reads).
//
// Locations, checked on each client's own documentation on 2026-10-06:
//   Cursor          ~/.cursor/mcp.json (all projects), .cursor/mcp.json (one project); key "mcpServers".
//                   https://cursor.com/docs/context/mcp
//   VS Code         mcp.json in the user profile folder ("MCP: Open User Configuration"), .vscode/mcp.json in a
//                   workspace; key "servers", plus "inputs" for values VS Code asks for and stores itself.
//                   Portable files: .mcp.json in a workspace and ~/.copilot/mcp-config.json (or $COPILOT_HOME), key
//                   "mcpServers".
//                   https://code.visualstudio.com/docs/copilot/reference/mcp-configuration
//                   https://code.visualstudio.com/docs/copilot/customization/mcp-servers
//                   The user folder: %APPDATA%\Code\User (Windows), ~/Library/Application Support/Code/User (macOS),
//                   ~/.config/Code/User (Linux; Electron honours $XDG_CONFIG_HOME). Other profiles live in
//                   User/profiles/<id>/. https://code.visualstudio.com/docs/configure/settings
//   Claude Desktop  ~/Library/Application Support/Claude/claude_desktop_config.json (macOS),
//                   %APPDATA%\Claude\claude_desktop_config.json (Windows); key "mcpServers". Not available on Linux.
//                   https://modelcontextprotocol.io/docs/develop/connect-local-servers
//   Devin Desktop   ~/.config/devin/mcp_config.json or $XDG_CONFIG_HOME/devin/mcp_config.json (macOS and Linux),
//                   %APPDATA%\devin\mcp_config.json (Windows); key "mcpServers", remote URL in "serverUrl" or "url".
//                   https://docs.devin.ai/desktop/cascade/mcp
//                   Its FAQ (https://docs.devin.ai/desktop/devin-desktop-faq) still lists ~/.codeium/mcp_config.json,
//                   and Windsurf used ~/.codeium/windsurf/mcp_config.json: scan reads those too, add writes the first.
//   Claude Code     ~/.claude.json: user servers under "mcpServers", this folder's servers under
//                   "projects"[<folder>]."mcpServers"; .mcp.json in a project. $CLAUDE_CONFIG_DIR moves ~/.claude.json.
//                   https://code.claude.com/docs/en/mcp
//   Gemini CLI      ~/.gemini/settings.json and .gemini/settings.json; key "mcpServers" ("httpUrl" streamable HTTP,
//                   "url" SSE, "command" local). https://geminicli.com/docs/tools/mcp-server/
//   Codex           ~/.codex/config.toml (or $CODEX_HOME/config.toml) and .codex/config.toml in a trusted project;
//                   tables [mcp_servers.<name>]. https://learn.chatgpt.com/docs/extend/mcp?surface=cli
//                   https://developers.openai.com/codex/environment-variables
import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/**
 * The clients mcp.tc writes setup steps for (the ids of get_server's `client` argument), and how `add` handles each.
 *   cli      the client has its own command for adding a server: run it after confirmation
 *   file     the client reads a JSON file: merge the entry into it
 *   web      nothing local to write: print the steps and the link
 *   snippet  any other client: print the JSON
 * @type {Readonly<Record<string, {label: string, kind: 'cli'|'file'|'web'|'snippet', bin?: string, container?: string}>>}
 */
export const CLIENTS = Object.freeze({
  'claude-code': { label: 'Claude Code', kind: 'cli', bin: 'claude' },
  'claude-desktop': { label: 'Claude Desktop', kind: 'file', container: 'mcpServers' },
  'claude-ai': { label: 'claude.ai', kind: 'web' },
  chatgpt: { label: 'ChatGPT', kind: 'web' },
  cursor: { label: 'Cursor', kind: 'file', container: 'mcpServers' },
  vscode: { label: 'VS Code', kind: 'file', container: 'servers' },
  devin: { label: 'Devin Desktop', kind: 'file', container: 'mcpServers' },
  codex: { label: 'Codex', kind: 'cli', bin: 'codex' },
  gemini: { label: 'Gemini CLI', kind: 'cli', bin: 'gemini' },
  json: { label: 'Any client', kind: 'snippet' },
});

export const CLIENT_IDS = Object.freeze(Object.keys(CLIENTS));

/** Files larger than this are not read (a config file is a few KB; ~/.claude.json can reach a few MB). */
export const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/**
 * @typedef {object} Where
 * @property {NodeJS.Platform} platform
 * @property {Record<string, string|undefined>} env
 * @property {string} cwd
 * @property {string} home
 * @property {typeof path.posix} p path functions for that platform
 */

/**
 * The places to look, from a command context (platform, environment, working folder).
 * @param {{platform?: NodeJS.Platform, env?: Record<string, string|undefined>, cwd?: string}} ctx
 * @returns {Where}
 */
export function where(ctx) {
  const platform = ctx.platform || process.platform;
  const env = ctx.env || process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir();
  return { platform, env, cwd: ctx.cwd || process.cwd(), home, p };
}

/** @param {Where} w */
function appData(w) {
  return w.env.APPDATA || w.p.join(w.home, 'AppData', 'Roaming');
}

/** @param {Where} w */
function xdgConfig(w) {
  const x = w.env.XDG_CONFIG_HOME;
  return x && w.p.isAbsolute(x) ? x : w.p.join(w.home, '.config');
}

/**
 * VS Code's user folder for an edition ("Code", "Code - Insiders").
 * @param {Where} w
 * @param {string} edition
 */
function vscodeUserDir(w, edition = 'Code') {
  if (w.platform === 'win32') return w.p.join(appData(w), edition, 'User');
  if (w.platform === 'darwin') return w.p.join(w.home, 'Library', 'Application Support', edition, 'User');
  return w.p.join(xdgConfig(w), edition, 'User');
}

/**
 * The user-level file `add` writes for a file client, or null when the client has none on this system.
 * @param {string} client
 * @param {Where} w
 */
export function userFile(client, w) {
  switch (client) {
    case 'cursor':
      return w.p.join(w.home, '.cursor', 'mcp.json');
    case 'vscode':
      return w.p.join(vscodeUserDir(w), 'mcp.json');
    case 'claude-desktop':
      if (w.platform === 'darwin') return w.p.join(w.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      if (w.platform === 'win32') return w.p.join(appData(w), 'Claude', 'claude_desktop_config.json');
      return null;
    case 'devin':
      if (w.platform === 'win32') return w.p.join(appData(w), 'devin', 'mcp_config.json');
      return w.p.join(xdgConfig(w), 'devin', 'mcp_config.json');
    default:
      return null;
  }
}

/**
 * The project file in the working folder for a file client, or null when the client has none.
 * @param {string} client
 * @param {Where} w
 */
export function projectFile(client, w) {
  if (client === 'cursor') return w.p.join(w.cwd, '.cursor', 'mcp.json');
  if (client === 'vscode') return w.p.join(w.cwd, '.vscode', 'mcp.json');
  return null;
}

/**
 * Older locations a client may still use, for a hint when the documented file doesn't exist.
 * @param {string} client
 * @param {Where} w
 */
export function legacyFiles(client, w) {
  if (client === 'devin') return [w.p.join(w.home, '.codeium', 'mcp_config.json'), w.p.join(w.home, '.codeium', 'windsurf', 'mcp_config.json')];
  return [];
}

/**
 * @typedef {object} ConfigLocation
 * @property {string[]} clients client ids that read this file
 * @property {string} label who reads it, for people
 * @property {string} path
 * @property {'user'|'project'} scope
 * @property {'json'|'toml'|'claude'} format claude = ~/.claude.json (user servers and this folder's servers)
 * @property {string} [container] the key holding the servers (JSON)
 */

/**
 * Every config file scan reads, in display order. Missing files are fine.
 * @param {Where} w
 * @returns {ConfigLocation[]}
 */
export function scanLocations(w) {
  /** @type {ConfigLocation[]} */
  const list = [];
  const add = (/** @type {string[]} */ clients, /** @type {string} */ label, /** @type {string|null} */ file, /** @type {'user'|'project'} */ scope, /** @type {'json'|'toml'|'claude'} */ format, container = 'mcpServers') => {
    if (file && !list.some((l) => l.path === file)) list.push({ clients, label, path: file, scope, format, container });
  };
  const claudeDir = w.env.CLAUDE_CONFIG_DIR && w.p.isAbsolute(w.env.CLAUDE_CONFIG_DIR) ? w.env.CLAUDE_CONFIG_DIR : null;
  add(['claude-code'], 'Claude Code', claudeDir ? w.p.join(claudeDir, '.claude.json') : w.p.join(w.home, '.claude.json'), 'user', 'claude');
  add(['claude-code', 'vscode'], 'Claude Code, VS Code', w.p.join(w.cwd, '.mcp.json'), 'project', 'json');
  add(['claude-desktop'], 'Claude Desktop', userFile('claude-desktop', w), 'user', 'json');
  add(['cursor'], 'Cursor', userFile('cursor', w), 'user', 'json');
  add(['cursor'], 'Cursor', projectFile('cursor', w), 'project', 'json');
  for (const edition of ['Code', 'Code - Insiders']) {
    const dir = vscodeUserDir(w, edition);
    const label = edition === 'Code' ? 'VS Code' : 'VS Code Insiders';
    add(['vscode'], label, w.p.join(dir, 'mcp.json'), 'user', 'json', 'servers');
    for (const id of listDir(w.p.join(dir, 'profiles'))) add(['vscode'], `${label} (profile ${id})`, w.p.join(dir, 'profiles', id, 'mcp.json'), 'user', 'json', 'servers');
  }
  const copilot = w.env.COPILOT_HOME && w.p.isAbsolute(w.env.COPILOT_HOME) ? w.env.COPILOT_HOME : w.p.join(w.home, '.copilot');
  add(['vscode'], 'VS Code', w.p.join(copilot, 'mcp-config.json'), 'user', 'json');
  add(['vscode'], 'VS Code', projectFile('vscode', w), 'project', 'json', 'servers');
  add(['devin'], 'Devin Desktop', userFile('devin', w), 'user', 'json');
  for (const f of legacyFiles('devin', w)) add(['devin'], 'Devin Desktop', f, 'user', 'json');
  const codexHome = w.env.CODEX_HOME && w.p.isAbsolute(w.env.CODEX_HOME) ? w.env.CODEX_HOME : w.p.join(w.home, '.codex');
  add(['codex'], 'Codex', w.p.join(codexHome, 'config.toml'), 'user', 'toml');
  add(['codex'], 'Codex', w.p.join(w.cwd, '.codex', 'config.toml'), 'project', 'toml');
  add(['gemini'], 'Gemini CLI', w.p.join(w.home, '.gemini', 'settings.json'), 'user', 'json');
  add(['gemini'], 'Gemini CLI', w.p.join(w.cwd, '.gemini', 'settings.json'), 'project', 'json');
  return list;
}

/** @param {string} dir */
function listDir(dir) {
  try {
    return readdirSync(dir).filter((n) => /^[A-Za-z0-9._-]{1,80}$/.test(n) && !n.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * A path for people: the home folder as "~".
 * @param {string} file
 * @param {Where} w
 */
export function displayPath(file, w) {
  const home = w.home.replace(/[\\/]+$/, '');
  if (home && (file === home || file.startsWith(home + w.p.sep))) return `~${file.slice(home.length)}`;
  return file;
}

// ------------------------------------------------------------------ reading

/**
 * @typedef {object} ConfigText
 * @property {boolean} exists
 * @property {string} path the file to write (a symlink resolved to its target)
 * @property {string} text '' for a missing file
 * @property {Buffer|null} raw the bytes read (null for a missing file): add compares them again before it writes
 * @property {any} data parsed object ({} for a missing or empty file); null when it could not be read as JSON
 * @property {null|'comments'|'invalid'|'not_object'|'too_large'|'unreadable'|'not_a_file'} problem
 * @property {string} indent
 * @property {string} eol
 * @property {boolean} finalNewline
 * @property {number|null} mode permission bits of the existing file
 */

/**
 * Read a JSON config file for writing. A file with comments or trailing commas (JSONC) is reported, not rewritten:
 * rewriting it would drop the comments.
 * @param {string} file
 * @returns {ConfigText}
 */
export function readJsonForWrite(file) {
  /** @type {ConfigText} */
  const r = { exists: false, path: file, text: '', raw: null, data: {}, problem: null, indent: '  ', eol: '\n', finalNewline: true, mode: null };
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return r;
  }
  r.exists = true;
  try {
    if (st.isSymbolicLink()) {
      r.path = realpathSync(file);
      st = statSync(r.path);
    }
  } catch {
    r.problem = 'unreadable';
    r.data = null;
    return r;
  }
  if (!st.isFile()) {
    r.problem = 'not_a_file';
    r.data = null;
    return r;
  }
  if (st.size > MAX_CONFIG_BYTES) {
    r.problem = 'too_large';
    r.data = null;
    return r;
  }
  r.mode = st.mode & 0o777;
  try {
    r.raw = readFileSync(r.path);
    r.text = r.raw.toString('utf8');
  } catch {
    r.problem = 'unreadable';
    r.data = null;
    return r;
  }
  const body = r.text.replace(/^\uFEFF/, '');
  r.eol = body.includes('\r\n') ? '\r\n' : '\n';
  r.finalNewline = body === '' || /\n$/.test(body);
  r.indent = detectIndent(body);
  if (body.trim() === '') {
    r.data = {};
    return r;
  }
  try {
    r.data = JSON.parse(body);
  } catch {
    r.data = null;
    let loose = false;
    try {
      parseJsonc(body);
      loose = true;
    } catch {
      loose = false;
    }
    r.problem = loose ? 'comments' : 'invalid';
    return r;
  }
  if (!isPlainObject(r.data)) {
    r.problem = 'not_object';
    r.data = null;
  }
  return r;
}

/**
 * Read any config file for scan: JSON with comments and trailing commas allowed, or TOML.
 * @param {string} file
 * @param {'json'|'toml'|'claude'} format
 * @returns {{exists: boolean, data: any, problem: string|null}}
 */
export function readForScan(file, format) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { exists: false, data: null, problem: null };
  }
  if (!st.isFile()) return { exists: true, data: null, problem: 'not_a_file' };
  if (st.size > MAX_CONFIG_BYTES) return { exists: true, data: null, problem: 'too_large' };
  let text;
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return { exists: true, data: null, problem: 'unreadable' };
  }
  if (text.trim() === '') return { exists: true, data: {}, problem: null };
  try {
    const data = format === 'toml' ? parseToml(text) : parseJsonLoose(text);
    return isPlainObject(data) ? { exists: true, data, problem: null } : { exists: true, data: null, problem: 'not_object' };
  } catch {
    return { exists: true, data: null, problem: 'invalid' };
  }
}

/**
 * Plain JSON first (fast, even for a large ~/.claude.json), then JSONC.
 * @param {string} text
 */
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return parseJsonc(text);
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @param {string} text */
function detectIndent(text) {
  const m = /^([ \t]+)\S/m.exec(text);
  if (!m) return '  ';
  return m[1].startsWith('\t') ? '\t' : ' '.repeat(Math.min(8, m[1].length));
}

/**
 * Parse JSON that may have // and block comments and trailing commas (VS Code's JSONC).
 * @param {string} text
 */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('Unterminated comment');
      out += ' ';
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas before } or ] (strings were copied whole above, but may still contain ",}": match outside them)
  let res = '';
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
    } else if (c === ',') {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
      res += c;
    } else {
      res += c;
    }
  }
  return JSON.parse(res);
}

// ------------------------------------------------------------------ merging and writing

/**
 * Put one server entry into a config object without touching the others.
 * @param {Record<string, any>} data the whole file
 * @param {{container: string, name: string, entry: Record<string, any>, inputs?: any[], replace?: boolean}} what
 * @returns {{data: Record<string, any>, status: 'added'|'same'|'conflict'|'replaced', inputsAdded: string[], inputsKept: string[], problem: string|null}}
 */
export function mergeServer(data, what) {
  const next = structuredClone(data);
  const res = { data: next, status: /** @type {'added'|'same'|'conflict'|'replaced'} */ ('added'), inputsAdded: /** @type {string[]} */ ([]), inputsKept: /** @type {string[]} */ ([]), problem: /** @type {string|null} */ (null) };
  if (!Object.hasOwn(next, what.container)) next[what.container] = {};
  const servers = next[what.container];
  if (!isPlainObject(servers)) {
    res.problem = `"${what.container}" in this file is not an object`;
    return res;
  }
  if (Object.hasOwn(servers, what.name)) {
    if (sameJson(servers[what.name], what.entry)) res.status = 'same';
    else if (what.replace) res.status = 'replaced';
    else {
      res.status = 'conflict';
      return res;
    }
  }
  if (res.status !== 'same') servers[what.name] = what.entry;
  if (what.inputs && what.inputs.length) {
    if (!Object.hasOwn(next, 'inputs')) next.inputs = [];
    if (!Array.isArray(next.inputs)) {
      res.problem = '"inputs" in this file is not a list';
      return res;
    }
    for (const input of what.inputs) {
      const have = next.inputs.find((/** @type {any} */ x) => isPlainObject(x) && x.id === input.id);
      if (!have) {
        next.inputs.push(input);
        res.inputsAdded.push(String(input.id));
      } else if (!sameJson(have, input)) {
        res.inputsKept.push(String(input.id));
      }
    }
  }
  return res;
}

/**
 * Deep equality for JSON values (key order ignored).
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function sameJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  }
  return false;
}

/**
 * The file text for a config object, in the original file's indentation and line endings.
 * @param {any} data
 * @param {{indent?: string, eol?: string, finalNewline?: boolean}} [fmt]
 */
export function serialize(data, fmt = {}) {
  const text = JSON.stringify(data, null, fmt.indent ?? '  ') + (fmt.finalNewline === false ? '' : '\n');
  return fmt.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * Where add keeps backups: a per-user state folder, never next to the config file. A copy next to a project file
 * (.cursor/mcp.json.bak-...) would not match an exact .gitignore rule for the file, so the old keys could be committed.
 *   Linux and others  $XDG_STATE_HOME/mcp-tc/backups, else ~/.local/state/mcp-tc/backups
 *   macOS             $XDG_STATE_HOME/mcp-tc/backups when set, else ~/Library/Application Support/mcp-tc/backups
 *   Windows           %LOCALAPPDATA%\mcp-tc\backups
 * @param {Where} w
 */
export function backupDir(w) {
  if (w.platform === 'win32') {
    const local = w.env.LOCALAPPDATA && w.p.isAbsolute(w.env.LOCALAPPDATA) ? w.env.LOCALAPPDATA : w.p.join(w.home, 'AppData', 'Local');
    return w.p.join(local, 'mcp-tc', 'backups');
  }
  const state = w.env.XDG_STATE_HOME;
  if (state && w.p.isAbsolute(state)) return w.p.join(state, 'mcp-tc', 'backups');
  if (w.platform === 'darwin') return w.p.join(w.home, 'Library', 'Application Support', 'mcp-tc', 'backups');
  return w.p.join(w.home, '.local', 'state', 'mcp-tc', 'backups');
}

/**
 * A timestamped copy of a config file in the backup folder (folder 0700, file 0600, never over an earlier backup):
 * <first 12 hex of sha256(real path)>-<file name>.bak-20261006T213045Z
 * @param {string} file the file being backed up (its name goes into the backup's name)
 * @param {Date} now
 * @param {{dir: string, bytes?: Buffer|string, key?: string}} opts dir: the backup folder; bytes: what to save (the
 *   bytes add read and merged, default: the file now); key: the path hashed into the name (default: the file)
 * @returns {string} the backup's path
 */
export function backupFile(file, now, opts) {
  const dir = opts.dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows: permission bits don't apply
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const hash = createHash('sha256').update(opts.key ?? file).digest('hex').slice(0, 12);
  const name = `${hash}-${path.basename(file)}.bak-${stamp}`;
  const bytes = opts.bytes ?? readFileSync(file);
  for (let i = 1; ; i++) {
    const target = path.join(dir, i === 1 ? name : `${name}-${i}`);
    let fd;
    try {
      // 'wx': never write through an existing file or link
      fd = openSync(target, 'wx', 0o600);
    } catch (err) {
      if (/** @type {any} */ (err).code === 'EEXIST' && i < 1000) continue;
      throw err;
    }
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(target, 0o600);
    } catch {
      // Windows
    }
    return target;
  }
}

/**
 * The bytes of a file now, or null when it doesn't exist (or can't be read).
 * @param {string} file
 * @returns {Buffer|null}
 */
export function readBytes(file) {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * Write a file so that it is either the old or the new content, never half written: a temporary file in the same
 * folder, flushed, then renamed over the original. New folders are private to the user.
 * @param {string} file
 * @param {string} text
 * @param {{mode?: number}} [opts] permission bits (default 0600 for a new file)
 */
export function writeFileAtomic(file, text, opts = {}) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.mcp-tc-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  const mode = opts.mode ?? 0o600;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      chmodSync(tmp, mode);
    } catch {
      // Windows
    }
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to remove
    }
    throw err;
  }
}

/**
 * The git work tree a path is in (a folder above it with .git), or null. The path is taken as written: use
 * realLocation() first to follow links.
 * @param {string} file
 */
export function gitRepoOf(file) {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Where a path really is once links are followed: the real path of the file, or for a file that doesn't exist yet,
 * the real path of its nearest existing folder with the rest of the path appended. A linked file
 * (~/.cursor/mcp.json -> ~/dotfiles/cursor/mcp.json) or a linked folder (~/.cursor -> ~/dotfiles/cursor) is written
 * at its target, so decisions about repositories and project folders are made there.
 * @param {string} file
 */
export function realLocation(file) {
  const abs = path.resolve(file);
  /** @type {string[]} */
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

/**
 * True when `child` is `parent` or inside it (both absolute, already real paths).
 * @param {string} child
 * @param {string} parent
 */
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

/**
 * The real location of a config file when a link at or below the working folder or the home folder leads elsewhere
 * (a linked file, or a linked folder on the way to it), else null. Links above those folders (like /var ->
 * /private/var on macOS) are not the person's doing and don't count.
 * @param {string} file
 * @param {{cwd: string, home: string}} w
 */
export function linkedTarget(file, w) {
  const abs = path.resolve(file);
  const real = realLocation(abs);
  let expected = abs;
  for (const base of [w.cwd, w.home]) {
    if (!base) continue;
    const b = path.resolve(base);
    if (isInside(abs, b)) {
      expected = path.join(realLocation(b), path.relative(b, abs));
      break;
    }
  }
  return real === expected ? null : real;
}

/**
 * The git work tree a config file would be written into, from where it really is (links followed) and from the path
 * as written; null when neither is in one.
 * @param {string} file
 */
export function repoForWrite(file) {
  return gitRepoOf(realLocation(file)) || gitRepoOf(file);
}

// ------------------------------------------------------------------ diff

/**
 * A unified diff of two texts (line based, 3 lines of context). '' when they are equal.
 * @param {string} before
 * @param {string} after
 * @param {{from?: string, to?: string, context?: number}} [opts]
 */
export function unifiedDiff(before, after, opts = {}) {
  if (before === after) return '';
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffLines(a, b);
  const ctx = opts.context ?? 3;
  const out = [`--- ${opts.from ?? 'before'}`, `+++ ${opts.to ?? 'after'}`];
  // positions of each op in a and b
  /** @type {{t: ' '|'-'|'+', line: string, ai: number, bi: number}[]} */
  const rows = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    rows.push({ ...op, ai, bi });
    if (op.t !== '+') ai++;
    if (op.t !== '-') bi++;
  }
  let i = 0;
  while (i < rows.length) {
    while (i < rows.length && rows[i].t === ' ') i++;
    if (i >= rows.length) break;
    const start = Math.max(0, i - ctx);
    let end = i;
    // extend while the next change is within 2*ctx unchanged lines
    for (;;) {
      while (end < rows.length && rows[end].t !== ' ') end++;
      let gap = end;
      while (gap < rows.length && rows[gap].t === ' ') gap++;
      if (gap < rows.length && gap - end <= ctx * 2) {
        end = gap;
        continue;
      }
      end = Math.min(rows.length, end + ctx);
      break;
    }
    const hunk = rows.slice(start, end);
    const aCount = hunk.filter((r) => r.t !== '+').length;
    const bCount = hunk.filter((r) => r.t !== '-').length;
    const aStart = aCount ? hunk.find((r) => r.t !== '+')?.ai ?? 0 : (hunk[0]?.ai ?? 0) - 1;
    const bStart = bCount ? hunk.find((r) => r.t !== '-')?.bi ?? 0 : (hunk[0]?.bi ?? 0) - 1;
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const r of hunk) out.push(`${r.t}${r.line}`);
    i = end;
  }
  return out.join('\n');
}

/** @param {string} text */
function splitLines(text) {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line operations turning a into b (longest common subsequence after trimming the common start and end).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{t: ' '|'-'|'+', line: string}[]}
 */
function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  /** @type {{t: ' '|'-'|'+', line: string}[]} */
  const mid = [];
  const n = am.length;
  const m = bm.length;
  if (n * m > 4_000_000) {
    for (const line of am) mid.push({ t: '-', line });
    for (const line of bm) mid.push({ t: '+', line });
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        mid.push({ t: ' ', line: am[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        mid.push({ t: '-', line: am[i++] });
      } else {
        mid.push({ t: '+', line: bm[j++] });
      }
    }
    while (i < n) mid.push({ t: '-', line: am[i++] });
    while (j < m) mid.push({ t: '+', line: bm[j++] });
  }
  return [...a.slice(0, pre).map((line) => ({ t: /** @type {' '} */ (' '), line })), ...mid, ...a.slice(a.length - suf).map((line) => ({ t: /** @type {' '} */ (' '), line }))];
}

// ------------------------------------------------------------------ keeping secrets out of what we print

/** Names whose values are secrets: API keys, tokens, passwords, auth headers. */
export const SECRET_NAME = /(api[_-]?key|apikey|token|secret|passw(or)?d|passphrase|authorization|bearer|cookie|credential|private[_-]?key|access[_-]?key|session|auth|(^|[_-])pat$)/i;

/** @param {string} v */
function isPlaceholder(v) {
  return /^<YOUR_[A-Z0-9_]+>$/.test(v) || /^\$\{[^}]+\}$/.test(v) || /^Bearer <YOUR_[A-Z0-9_]+>$/.test(v) || /^Bearer \$\{[^}]+\}$/.test(v);
}

/**
 * A string value made safe to print: secret-looking parts become <hidden>; placeholders stay.
 * @param {string} v
 * @param {string} [name] the JSON key it belongs to
 */
export function redactValue(v, name = '') {
  if (isPlaceholder(v)) return v;
  if (name && SECRET_NAME.test(name)) return '<hidden>';
  // a flag with a value: --api-key=xyz
  let m = /^(--?[A-Za-z0-9_-]+=)(.+)$/.exec(v);
  if (m && SECRET_NAME.test(m[1])) return isPlaceholder(m[2]) ? v : `${m[1]}<hidden>`;
  // a header line: X-Api-Key: xyz, Authorization: Bearer xyz
  m = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(v);
  if (m && !/^https?$/i.test(m[1]) && SECRET_NAME.test(m[1])) return isPlaceholder(m[2].trim()) ? v : `${m[1]}: <hidden>`;
  // KEY=value as in docker -e or env lists
  m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(v);
  if (m && SECRET_NAME.test(m[1])) return isPlaceholder(m[2]) ? v : `${m[1]}=<hidden>`;
  // URLs: hide user info and the query
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    return v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#\s]*@/i, '$1<hidden>@').replace(/\?[^#]*/, '?<hidden>');
  }
  // a long random-looking token
  if (looksLikeToken(v)) return '<hidden>';
  return v;
}

/**
 * True for a string that looks like a key or token: 20+ characters of letters, digits and _-+/=.~ with both letters
 * and digits, not a path, a URL or a package name.
 * @param {string} v
 */
export function looksLikeToken(v) {
  if (v.length < 20 || v.length > 4096) return false;
  if (/^[./~@]/.test(v) || v.includes('://')) return false;
  if (!/^[A-Za-z0-9_\-+/=.~]+$/.test(v)) return false;
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return false;
  // words joined by hyphens or dots (a package or host name) are not keys
  if (/^[a-z]+(?:[-.][a-z0-9]+)*$/.test(v) && !/\d{4,}/.test(v)) return false;
  return true;
}

/**
 * A line of JSON with secret-looking values hidden. It sees one line at a time, so it can't pair a flag with a value
 * on the next line or know every key name: add's diffs use redactConfig() on the whole structure instead.
 * @param {string} line
 */
export function redactLine(line) {
  // "name": "value"
  let out = line.replace(/"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (_m, k, sep, v) => `"${k}"${sep}"${redactValue(v, k)}"`);
  // other strings ("--header", "X-Key: abc" in an args list); keys followed by ":" were handled above
  out = out.replace(/(^|[[,\s])"((?:[^"\\]|\\.)*)"(?=\s*(?:,|\]|$))/g, (_m, before, v) => `${before}"${redactValue(v)}"`);
  return out;
}

/**
 * A command line for printing, with secret values hidden.
 * @param {string[]} argv
 */
export function redactArgv(argv) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const prev = i > 0 ? argv[i - 1] : '';
    const flagSecret = /^--?[A-Za-z0-9_-]+$/.test(prev) && SECRET_NAME.test(prev) && !/^--?header$/i.test(prev);
    out.push(flagSecret && !isPlaceholder(argv[i]) ? '<hidden>' : redactValue(argv[i]));
  }
  return out;
}

/**
 * A config object made safe to show in a diff (on the screen and in --json): every string value becomes <hidden>,
 * except a server's "command", its "type" or "transport", and its URLs cut down to scheme, host and path (no user
 * name, password, query or fragment; no path when a part of it looks like a key). Object keys, numbers and booleans
 * stay, so the diff keeps its shape. `show` names what is printed as it is: the entry add writes (it comes from
 * mcp.tc and holds placeholders, never a key) and the VS Code inputs add adds. Redacting the structure, not the
 * printed lines, keeps a flag and its value hidden together ("--password", "hunter2") whatever their names.
 * @param {any} data
 * @param {{container?: string, name?: string, inputs?: string[]}} [show]
 * @returns {any}
 */
export function redactConfig(data, show = {}) {
  /** @returns {any} */
  const hide = (/** @type {any} */ v, /** @type {string} */ key) => {
    if (typeof v === 'string') return shownString(v, key);
    if (Array.isArray(v)) return v.map((x) => hide(x, ''));
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x, k)]));
    return v;
  };
  if (!isPlainObject(data)) return hide(data, '');
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (show.container && k === show.container && isPlainObject(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([n, entry]) => [n, show.name !== undefined && n === show.name ? structuredClone(entry) : hide(entry, '')]));
    } else if (k === 'inputs' && Array.isArray(v)) {
      out[k] = v.map((x) => (isPlainObject(x) && (show.inputs || []).includes(x.id) ? structuredClone(x) : hide(x, '')));
    } else {
      out[k] = hide(v, k);
    }
  }
  return out;
}

/**
 * @param {string} v
 * @param {string} key
 */
function shownString(v, key) {
  const k = key.toLowerCase();
  if (k === 'command') return v.length <= 300 && !/[=\r\n]/.test(v) && !looksLikeToken(v) ? v : '<hidden>';
  if (k === 'type' || k === 'transport') return /^[A-Za-z][A-Za-z-]{0,39}$/.test(v) ? v : '<hidden>';
  if (k === 'url' || k === 'serverurl' || k === 'httpurl') {
    let u;
    try {
      u = new URL(v);
    } catch {
      return '<hidden>';
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return '<hidden>';
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.some((s) => secretSegment(decodeURIComponentSafe(s)))) return `${u.origin}/<hidden>`;
    return `${u.origin}${u.pathname === '/' ? '' : u.pathname}${u.search || u.hash ? '?<hidden>' : ''}`;
  }
  return '<hidden>';
}

// ------------------------------------------------------------------ servers in a config file

/**
 * @typedef {object} FoundServer
 * @property {string} name the entry's name in that file
 * @property {any} raw the entry as written there
 * @property {string} [note] where in the file, e.g. "this folder" for Claude Code's per-project servers
 */

/**
 * The server entries of a parsed config file.
 * @param {ConfigLocation} loc
 * @param {any} data
 * @param {Where} w
 * @returns {FoundServer[]}
 */
export function serversIn(loc, data, w) {
  if (!isPlainObject(data)) return [];
  /** @type {FoundServer[]} */
  const out = [];
  const take = (/** @type {any} */ obj, /** @type {string|undefined} */ note) => {
    if (!isPlainObject(obj)) return;
    for (const [name, raw] of Object.entries(obj)) out.push(note ? { name, raw, note } : { name, raw });
  };
  if (loc.format === 'toml') {
    take(data.mcp_servers);
  } else if (loc.format === 'claude') {
    take(data.mcpServers);
    const projects = isPlainObject(data.projects) ? data.projects : {};
    const here = Object.keys(projects).find((k) => samePath(k, w.cwd, w));
    if (here) take(projects[here].mcpServers, 'this folder');
  } else {
    take(data[loc.container || 'mcpServers']);
    // VS Code's workspace .mcp.json is portable ("mcpServers"); a .vscode/mcp.json written by hand may use either key
    if (loc.container === 'servers') take(data.mcpServers);
  }
  return out;
}

/** @param {string} a @param {string} b @param {Where} w */
function samePath(a, b, w) {
  const norm = (/** @type {string} */ s) => w.p.resolve(s).replace(/[\\/]+$/, '');
  return w.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * @typedef {object} ServerShape
 * @property {'http'|'sse'|'stdio'|'unknown'} transport
 * @property {string|null} url
 * @property {string|null} command
 * @property {string[]} args
 */

/**
 * What a config entry runs or connects to. Headers and environment values are never read.
 * @param {any} raw
 * @param {string} [client]
 * @returns {ServerShape}
 */
export function describeServer(raw, client = '') {
  /** @type {ServerShape} */
  const shape = { transport: 'unknown', url: null, command: null, args: [] };
  if (!isPlainObject(raw)) return shape;
  const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const type = String(raw.type || raw.transport || '').toLowerCase();
  const url = str(raw.httpUrl) || str(raw.url) || str(raw.serverUrl);
  if (url) {
    shape.url = url;
    if (str(raw.httpUrl)) shape.transport = 'http';
    else if (type.includes('sse')) shape.transport = 'sse';
    else if (client === 'gemini' && !type) shape.transport = 'sse'; // Gemini CLI: "url" is an SSE endpoint
    else shape.transport = 'http';
    return shape;
  }
  const command = str(raw.command);
  if (command) {
    shape.transport = 'stdio';
    shape.command = command;
    shape.args = Array.isArray(raw.args) ? raw.args.filter((/** @type {unknown} */ a) => typeof a === 'string') : [];
  }
  return shape;
}

// ------------------------------------------------------------------ what scan may send

// Names that only resolve inside a private network or on one computer (RFC 6762, RFC 8375, Kubernetes, Consul and
// common internal suffixes), plus the reserved and example names.
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|priv|vpn|svc|consul|onion|test|example|invalid|home\.arpa)$/;
// Wildcard DNS services that answer with the IP address written in the name (10.0.0.1.nip.io, 10-0-0-1.sslip.io).
const IP_IN_NAME = /(^|\.)(nip\.io|sslip\.io|xip\.io|traefik\.me)$/;
// Names that always point at this computer.
const LOOPBACK_NAMES = /(^|\.)(localtest\.me|lvh\.me|vcap\.me)$/;

/**
 * True for an address that only makes sense on this computer or a private network, or that is reserved and never a
 * public server: loopback, private, link-local, shared (CGNAT), benchmarking, documentation, multicast and reserved
 * IPv4 ranges; the IPv6 equivalents, IPv4-mapped and IPv4-compatible forms and NAT64 prefixes; single-label names and
 * internal suffixes; wildcard DNS names that carry such an IP. These are never sent to mcp.tc.
 * @param {string} host
 */
export function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || (!h.includes('.') && !h.includes(':'))) return true; // single label: "localhost", "intranet", "devbox"
  if (h.includes(':')) return privateV6(h);
  if (/^[0-9.]+$/.test(h)) return privateV4(h);
  if (PRIVATE_SUFFIX.test(h) || LOOPBACK_NAMES.test(h)) return true;
  if (IP_IN_NAME.test(h)) {
    // like the address inside the name; a name that carries none is not a public server either
    const ip = ipInName(h.replace(IP_IN_NAME, ''));
    return ip === null || privateV4(ip);
  }
  return false;
}

/**
 * The IPv4 address written in a wildcard DNS name ("app.10.0.0.1", "10-0-0-1", "0a000001"), or null.
 * @param {string} rest the name without its nip.io-style suffix
 */
function ipInName(rest) {
  const dotted = /(?:^|[.-])((?:\d{1,3}\.){3}\d{1,3})$/.exec(rest);
  if (dotted) return dotted[1];
  const dashed = /(?:^|[.-])(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(rest);
  if (dashed) return dashed.slice(1, 5).join('.');
  const hex = /(?:^|[.-])([0-9a-f]{8})$/.exec(rest);
  if (hex) return [0, 2, 4, 6].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).join('.');
  return null;
}

/**
 * @param {string} h dotted IPv4 address
 */
function privateV4(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return true; // not a well-formed address: never sent
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([a, b, c, Number(m[4])].some((x) => x > 255)) return true;
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/**
 * @param {string} h IPv6 address without brackets (a zone id is allowed)
 */
function privateV6(h) {
  const groups = expandV6(h.replace(/%.*$/, ''));
  if (!groups) return true; // not a well-formed address: never sent
  const [g0, g1, g2, g3, g4, g5] = groups;
  const zero = (/** @type {number[]} */ list) => list.every((x) => x === 0);
  if (zero([g0, g1, g2, g3, g4])) {
    if (g5 === 0xffff) return true; // IPv4-mapped: a local address in another spelling
    if (g5 === 0) return true; // ::, ::1 and the IPv4-compatible ::a.b.c.d
  }
  if (g0 === 0x64 && g1 === 0xff9b && (zero([g2, g3, g4, g5]) || g2 === 1)) return true; // NAT64 (64:ff9b::/96, 64:ff9b:1::/48)
  if (g0 === 0x100 && zero([g1, g2, g3])) return true; // discard prefix
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link-local, old site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2002) return privateV4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255].join('.')); // 6to4 carries an IPv4 address
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 address, or null.
 * @param {string} s
 * @returns {number[]|null}
 */
function expandV6(s) {
  let text = s;
  // a trailing dotted IPv4 part becomes two groups
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const n = v4.slice(2, 6).map(Number);
    if (n.some((x) => x > 255)) return null;
    text = `${v4[1]}${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = (/** @type {string} */ p) => (p === '' ? [] : p.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/**
 * Names that are public in DNS but describe a private network: a Tailscale tailnet (machine.tailnet.ts.net) names
 * the person's network and machine. scan never sends them.
 * @param {string} host
 */
export function isRevealingHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return /(^|\.)ts\.net$/.test(h) || /(^|\.)beta\.tailscale\.net$/.test(h);
}

/**
 * A server URL reduced to what may be sent: no user name, password, query or fragment, and no path at all when a
 * path segment looks like a key (some services put the key in the path). Null when it must not be sent: an address
 * on this computer or a private network (or a tailnet name), a plain http:// URL (public MCP servers use https; an
 * http one is almost always a server on a private network), or a URL with variables in it.
 * @param {string} raw
 * @returns {{url: string, trimmed: string[]}|{url: null, reason: string}}
 */
export function urlForLookup(raw) {
  if (/\$\{|%7B|\{\{/i.test(raw) || /<[^<>\s]{1,60}>|(?<![A-Za-z0-9_])YOUR_[A-Z0-9_]+/.test(raw)) return { url: null, reason: 'has_variables' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { url: null, reason: 'not_a_url' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { url: null, reason: 'not_http' };
  if (isPrivateHost(u.hostname) || isRevealingHost(u.hostname)) return { url: null, reason: 'local_address' };
  if (u.protocol !== 'https:') return { url: null, reason: 'not_https' };
  /** @type {string[]} */
  const trimmed = [];
  if (u.username || u.password) trimmed.push('credentials');
  if (u.search) trimmed.push('query');
  if (u.hash) trimmed.push('fragment');
  u.username = '';
  u.password = '';
  u.search = '';
  u.hash = '';
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.some((s) => secretSegment(decodeURIComponentSafe(s)))) {
    trimmed.push('path');
    return { url: u.origin, trimmed };
  }
  return { url: u.pathname === '/' ? u.origin : `${u.origin}${u.pathname}`, trimmed };
}

/** @param {string} s */
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A path segment that looks like a key: a long random-looking token, a UUID, or "name=value".
 * @param {string} s
 */
export function secretSegment(s) {
  if (s.includes('=')) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^(sk|pk|rk|ghp|gho|ghu|ghs|xox[a-z]?|key|tok|api)[-_]/i.test(s) && s.length >= 12) return true;
  return looksLikeToken(s);
}

/**
 * @typedef {{type: 'url', url: string, trimmed: string[]}
 *   | {type: 'package', registry: 'npm'|'pypi'|'oci', name: string}
 *   | {type: 'repo', url: string}
 *   | {type: 'listing', slug: string}
 *   | {type: 'skip', reason: string}} LookupTarget
 */

/**
 * @typedef {object} TargetOptions
 * @property {(url: string) => string|null} [listingSlug] the listing slug when a URL is an mcp.tc listing page (a page,
 *   not an MCP endpoint: nothing is looked up for it)
 */

/**
 * A remote URL as a lookup target.
 * @param {string} url
 * @param {TargetOptions} opts
 * @returns {LookupTarget}
 */
function urlTarget(url, opts) {
  const slug = opts.listingSlug ? opts.listingSlug(url) : null;
  if (slug) return { type: 'listing', slug };
  const r = urlForLookup(url);
  return r.url ? { type: 'url', url: r.url, trimmed: r.trimmed } : { type: 'skip', reason: r.reason };
}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * What a local command can be looked up by: its npm, PyPI or container package, a repository, or a remote URL it
 * bridges to (mcp-remote). Only the package name or URL leaves the computer, never the other arguments.
 * @param {string} command
 * @param {string[]} args
 * @param {TargetOptions} [opts]
 * @returns {LookupTarget}
 */
export function packageFromCommand(command, args, opts = {}) {
  const base = command.split(/[\\/]/).pop()?.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '') || '';
  const rest = args.slice();
  // Windows configs often wrap the runner: cmd /c npx -y pkg
  if (base === 'cmd' && rest.length >= 2 && /^\/c$/i.test(rest[0])) return packageFromCommand(rest[1], rest.slice(2), opts);
  switch (base) {
    case 'npx':
    case 'bunx':
      return npmTarget(rest, ['-p', '--package'], opts);
    case 'npm':
      if (rest[0] === 'exec' || rest[0] === 'x') return npmTarget(rest.slice(1), ['-p', '--package'], opts);
      return { type: 'skip', reason: 'local_command' };
    case 'pnpm':
    case 'yarn':
      if (rest[0] === 'dlx') return npmTarget(rest.slice(1), ['-p', '--package'], opts);
      return { type: 'skip', reason: 'local_command' };
    case 'bun':
      if (rest[0] === 'x') return npmTarget(rest.slice(1), ['-p', '--package'], opts);
      return { type: 'skip', reason: 'local_command' };
    case 'uvx':
      return pypiTarget(rest, ['--from']);
    case 'uv':
      if (rest[0] === 'tool' && rest[1] === 'run') return pypiTarget(rest.slice(2), ['--from']);
      return { type: 'skip', reason: 'local_command' };
    case 'pipx':
      if (rest[0] === 'run') return pypiTarget(rest.slice(1), ['--spec']);
      return { type: 'skip', reason: 'local_command' };
    case 'docker':
    case 'podman':
      if (rest[0] === 'run') return imageTarget(rest.slice(1));
      return { type: 'skip', reason: 'local_command' };
    default:
      return { type: 'skip', reason: 'local_command' };
  }
}

// flags of npx/uvx/pipx/docker that take a value (the value is skipped, never sent)
const NPM_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '-w', '--workspace', '--prefix', '--node-options']);
const PY_VALUE_FLAGS = new Set(['--from', '--with', '--with-editable', '--with-requirements', '-p', '--python', '--index', '--index-url', '--extra-index-url', '--default-index', '-i', '--spec', '--pip-args', '--constraints', '-c']);
const DOCKER_VALUE_FLAGS = new Set(['-e', '--env', '--env-file', '-v', '--volume', '--mount', '--name', '--network', '--net', '-p', '--publish', '-w', '--workdir', '--entrypoint', '-u', '--user', '--platform', '--pull', '-l', '--label', '--add-host', '--cpus', '-m', '--memory', '--hostname', '-h', '--device', '--cap-add', '--cap-drop', '--security-opt', '--tmpfs', '--ulimit', '--log-driver', '--log-opt', '--restart', '--gpus', '--ipc', '--pid', '--shm-size', '--dns', '--label-file', '--cidfile', '--runtime', '--stop-signal', '--stop-timeout', '--health-cmd', '--group-add', '--userns', '--uts', '--volumes-from', '--link', '--expose', '--memory-swap', '--cpuset-cpus', '--isolation']);

/**
 * @param {string[]} args
 * @param {string[]} packageFlags
 * @param {TargetOptions} opts
 * @returns {LookupTarget}
 */
function npmTarget(args, packageFlags, opts) {
  /** @type {string|null} */
  let fromFlag = null;
  /** @type {string|null} */
  let spec = null;
  /** @type {string[]} */
  let after = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      spec = args[i + 1] ?? null;
      after = args.slice(i + 2);
      break;
    }
    const eq = /^(--?[A-Za-z0-9-]+)=(.*)$/.exec(a);
    if (eq) {
      if (packageFlags.includes(eq[1]) && fromFlag === null) fromFlag = eq[2];
      continue;
    }
    if (a.startsWith('-')) {
      if (NPM_VALUE_FLAGS.has(a)) {
        if (packageFlags.includes(a) && fromFlag === null) fromFlag = args[i + 1] ?? null;
        i++;
      }
      continue;
    }
    spec = a;
    after = args.slice(i + 1);
    break;
  }
  const chosen = fromFlag || spec;
  if (!chosen) return { type: 'skip', reason: 'no_package' };
  const t = npmSpec(chosen);
  // the mcp-remote bridge: the server is the URL it connects to
  if (t.type === 'package' && t.name === 'mcp-remote') {
    const url = after.find((x) => /^https?:\/\//i.test(x));
    if (!url) return { type: 'skip', reason: 'no_package' };
    return urlTarget(url, opts);
  }
  return t;
}

/**
 * @param {string} spec an npm package spec
 * @returns {LookupTarget}
 */
function npmSpec(spec) {
  let s = spec.trim();
  if (/^(file:|link:|\.{0,2}[\\/]|[A-Za-z]:\\|~)/.test(s)) return { type: 'skip', reason: 'local_path' };
  const gh = /^(?:github:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:#.*)?$/.exec(s);
  if (gh && !s.startsWith('@')) return { type: 'repo', url: `https://github.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}` };
  if (/^git\+|^https?:\/\//i.test(s)) return repoFromUrl(s.replace(/^git\+/, ''));
  if (s.startsWith('npm:')) s = s.slice(4);
  // drop the version: @scope/name@1.2.3, name@latest
  s = s.startsWith('@') ? s.replace(/^(@[^/@]+\/[^@]+)@.*$/, '$1') : s.replace(/@.*$/, '');
  if (!NPM_NAME.test(s) || s.length > 214) return { type: 'skip', reason: 'no_package' };
  return { type: 'package', registry: 'npm', name: s.toLowerCase() };
}

/**
 * @param {string} raw
 * @returns {LookupTarget}
 */
function repoFromUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { type: 'skip', reason: 'no_package' };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const m = /^\/([^/]+)\/([^/#?]+)/.exec(u.pathname);
  if (['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'].includes(host) && m) {
    return { type: 'repo', url: `https://${host}/${m[1]}/${m[2].replace(/\.git$/, '')}` };
  }
  return { type: 'skip', reason: 'no_package' };
}

/**
 * @param {string[]} args
 * @param {string[]} fromFlags
 * @returns {LookupTarget}
 */
function pypiTarget(args, fromFlags) {
  /** @type {string|null} */
  let from = null;
  /** @type {string|null} */
  let tool = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      tool = args[i + 1] ?? null;
      break;
    }
    const eq = /^(--?[A-Za-z0-9-]+)=(.*)$/.exec(a);
    if (eq) {
      if (fromFlags.includes(eq[1]) && from === null) from = eq[2];
      continue;
    }
    if (a.startsWith('-')) {
      if (PY_VALUE_FLAGS.has(a)) {
        if (fromFlags.includes(a) && from === null) from = args[i + 1] ?? null;
        i++;
      }
      continue;
    }
    tool = a;
    break;
  }
  const chosen = from || tool;
  if (!chosen) return { type: 'skip', reason: 'no_package' };
  let s = chosen.trim();
  if (/^git\+|^https?:\/\//i.test(s)) return repoFromUrl(s.replace(/^git\+/, '').replace(/@[^/]*$/, ''));
  if (/^(file:|\.{0,2}[\\/]|[A-Za-z]:\\|~)/.test(s)) return { type: 'skip', reason: 'local_path' };
  // drop extras and versions: pkg[extra]==1.0, pkg>=2, pkg@1.0
  s = s.replace(/\[.*?\]/g, '').split(/[=<>!~@;\s]/)[0];
  if (!PYPI_NAME.test(s) || s.length > 100) return { type: 'skip', reason: 'no_package' };
  return { type: 'package', registry: 'pypi', name: s.toLowerCase() };
}

/**
 * Container images: only a name without a registry host can be looked up (mcp/fetch), without tag or digest.
 * @param {string[]} args
 * @returns {LookupTarget}
 */
function imageTarget(args) {
  let image = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (!a.includes('=') && DOCKER_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    image = a;
    break;
  }
  if (!image) return { type: 'skip', reason: 'no_package' };
  let name = image.replace(/@sha256:[a-f0-9]{64}$/i, '');
  const parts = name.split('/');
  if (parts.length > 1 && /[.:]/.test(parts[0]) || parts[0] === 'localhost') {
    if (/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)$/i.test(parts[0])) parts.shift();
    else return { type: 'skip', reason: 'image_registry' };
  }
  name = parts.join('/');
  name = name.replace(/:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, '');
  if (!name.includes('/') || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(name)) {
    return { type: 'skip', reason: 'no_package' };
  }
  return { type: 'package', registry: 'oci', name };
}

/**
 * What to look up for a config entry.
 * @param {ServerShape} shape
 * @param {TargetOptions} [opts]
 * @returns {LookupTarget}
 */
export function lookupTarget(shape, opts = {}) {
  if (shape.url) return urlTarget(shape.url, opts);
  if (shape.command) return packageFromCommand(shape.command, shape.args, opts);
  return { type: 'skip', reason: 'unknown_shape' };
}

// ------------------------------------------------------------------ a small TOML reader (Codex's config.toml)

/**
 * Parse the TOML subset config files use: tables, dotted and quoted keys, strings, numbers, booleans, arrays and
 * inline tables. Lines it can't read are skipped (scan only needs the [mcp_servers.*] tables).
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseToml(text) {
  /** @type {Record<string, any>} */
  const root = {};
  /** @type {Record<string, any>|null} */
  let table = root;
  const src = text.replace(/\r\n/g, '\n');
  let i = 0;
  const n = src.length;
  const skipSpace = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };
  const skipLine = () => {
    while (i < n && src[i] !== '\n') i++;
    i++;
  };
  const skipWsAndComments = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === '#') skipLine();
      else break;
    }
  };
  const key = () => {
    /** @type {string[]} */
    const parts = [];
    for (;;) {
      skipSpace();
      if (src[i] === '"' || src[i] === "'") parts.push(/** @type {string} */ (str()));
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
        if (!m) throw new SyntaxError('bad key');
        parts.push(m[0]);
        i += m[0].length;
      }
      skipSpace();
      if (src[i] === '.') {
        i++;
        continue;
      }
      return parts;
    }
  };
  /** @returns {string} */
  const str = () => {
    const q = src[i];
    if (src.startsWith(q.repeat(3), i)) {
      const end = src.indexOf(q.repeat(3), i + 3);
      if (end === -1) throw new SyntaxError('unterminated string');
      let s = src.slice(i + 3, end).replace(/^\n/, '');
      i = end + 3;
      if (q === '"') s = unescape(s);
      return s;
    }
    let j = i + 1;
    let s = '';
    while (j < n && src[j] !== q && src[j] !== '\n') {
      if (q === '"' && src[j] === '\\') {
        s += src.slice(j, j + 2);
        j += 2;
      } else s += src[j++];
    }
    if (src[j] !== q) throw new SyntaxError('unterminated string');
    i = j + 1;
    return q === '"' ? unescape(s) : s;
  };
  /** @returns {any} */
  const value = () => {
    skipSpace();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipWsAndComments();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        skipWsAndComments();
        if (src[i] === ',') i++;
        else if (src[i] === ']') {
          i++;
          return arr;
        } else throw new SyntaxError('bad array');
      }
    }
    if (c === '{') {
      i++;
      /** @type {Record<string, any>} */
      const obj = {};
      for (;;) {
        skipSpace();
        if (src[i] === '}') {
          i++;
          return obj;
        }
        const k = key();
        if (src[i] !== '=') throw new SyntaxError('bad inline table');
        i++;
        setPath(obj, k, value());
        skipSpace();
        if (src[i] === ',') i++;
        else if (src[i] === '}') {
          i++;
          return obj;
        } else throw new SyntaxError('bad inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 128));
    if (!m) throw new SyntaxError('bad value');
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    const num = Number(m[0].replace(/_/g, ''));
    return Number.isFinite(num) ? num : m[0];
  };
  while (i < n) {
    skipWsAndComments();
    if (i >= n) break;
    const lineStart = i;
    try {
      if (src[i] === '[') {
        const arrayTable = src[i + 1] === '[';
        i += arrayTable ? 2 : 1;
        const k = key();
        if (src[i] !== ']') throw new SyntaxError('bad table');
        i += arrayTable ? 2 : 1;
        table = arrayTable ? null : ensurePath(root, k);
        skipLine();
        continue;
      }
      const k = key();
      if (src[i] !== '=') throw new SyntaxError('bad pair');
      i++;
      const v = value();
      if (table) setPath(table, k, v);
      skipSpace();
      if (src[i] === '#' || src[i] === '\n' || i >= n) skipLine();
      else throw new SyntaxError('junk after value');
    } catch {
      // a table header it can't read: ignore its keys too, so they never land in the table above
      if (src[lineStart] === '[') table = null;
      i = lineStart;
      skipLine();
    }
  }
  return root;
}

/** @param {string} s */
function unescape(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e) => {
    if (e[0] === 'u' || e[0] === 'U') {
      const cp = parseInt(e.slice(1), 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[/** @type {'n'} */ (e)] ?? e;
  });
}

/**
 * @param {Record<string, any>} obj
 * @param {string[]} parts
 */
function ensurePath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (p === '__proto__' || p === 'constructor' || p === 'prototype') throw new SyntaxError('bad key');
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  return cur;
}

/**
 * @param {Record<string, any>} obj
 * @param {string[]} parts
 * @param {any} v
 */
function setPath(obj, parts, v) {
  const last = parts[parts.length - 1];
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') throw new SyntaxError('bad key');
  ensurePath(obj, parts.slice(0, -1))[last] = v;
}
