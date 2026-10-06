// mcp-tc add: add a listed server to an MCP client, following the setup steps mcp.tc publishes for that client
// (get_server with `client`). mcp-tc has no config templates of its own: when mcp.tc updates a client's syntax, add
// follows without a new release. Every snippet uses the server's own URL or package; a listing link never goes into
// a client config.
//
//   Claude Code, Gemini CLI, Codex   show the client's own command, run it after confirmation (no shell); only
//                                    "<client> mcp add" (and "codex mcp login") commands are ever run
//   Cursor, VS Code, Claude Desktop,  merge the entry into the client's JSON file: diff, confirmation, backup,
//   Devin Desktop                     atomic write; other servers in the file stay as they are
//   claude.ai, ChatGPT, Any client    print the steps and the link: there is nothing to write on this computer
//
// Placeholders: mcp.tc's snippets mark the values you supply as <YOUR_API_KEY>, <...>, YOUR_X, /path/to/... or
// {name}. In a terminal, add asks for each value (keys are not echoed) and writes it only into the client's own config:
// never into a project file or any file inside a git repository (decided from where the file really is, links
// followed), never to mcp.tc, never to the screen or the JSON output. A command is never run with a placeholder left in
// it, and a file written with one says so instead of reporting the server as added. VS Code asks for keys itself
// ("inputs" with password: true). Claude Code: a key passed with `claude mcp add --header` is visible to other users
// of the same machine in the process list while the command runs. When that matters, prefer the client's own prompt,
// or edit its user file yourself.
//
// Diffs are built from redacted copies of the file: other servers' values show as <hidden>, only the new entry is
// shown as it is. Backups go to a folder of mcp-tc's own (see backupDir() in lib/clients.js), never next to the file,
// where a copy of a project file would slip past its .gitignore rule. If the file changes while add waits for an
// answer, nothing is written.
//
// On Windows, client programs are started by their full path, found in the absolute folders of PATH only: Windows
// looks for a bare program name in the current folder first, where a cloned repository could have planted one.
//
// What add sends to mcp.tc: one get_server call (POST /mcp) with the listing slug and the client id, and a second one
// with the slug alone when mcp.tc has no steps for that client (to name the clients it has). Nothing about your
// config files, your other servers or your keys.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { clientOptions, mcpCall } from '../lib/directory.js';
import { listingQuery } from '../lib/target.js';
import { clean } from '../lib/output.js';
import { CliError, EXIT, UsageError } from '../lib/errors.js';
import { ask as promptAsk, confirm as promptConfirm } from '../lib/prompt.js';
import {
  CLIENTS,
  CLIENT_IDS,
  SECRET_NAME,
  backupDir,
  backupFile,
  displayPath,
  isInside,
  isPlainObject,
  legacyFiles,
  mergeServer,
  projectFile,
  readBytes,
  readJsonForWrite,
  realLocation,
  redactConfig,
  repoForWrite,
  serialize,
  unifiedDiff,
  userFile,
  where,
  writeFileAtomic,
  linkedTarget,
} from '../lib/clients.js';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'add',
  summary: "Add a server to an MCP client with mcp.tc's setup steps",
  usage: 'add <slug> --client <id> [--dry-run] [--yes] [--project] [--global] [--file <path>]',
  description:
    "Uses the steps mcp.tc publishes for the client, with the server's own URL or package. For Claude Code, Gemini CLI and Codex it shows the client's command and runs it after you confirm. For Cursor, VS Code, Claude Desktop and Devin Desktop it adds the server to your user config file: it shows the change as a diff (other servers' values hidden), asks, saves a backup in mcp-tc's own folder (it prints where), then writes the file without touching your other servers. For claude.ai, ChatGPT and json (any other client) it prints the steps. When the setup has values to fill in (an API key, a folder path, an account name) and you run add in a terminal, it asks for them; a key goes only into the client's own config on this computer, never into a project file or a file inside a git repository. A command is never run with a value missing. For Claude Code, a key passed with claude mcp add --header is visible to other users of the same machine in the process list while the command runs; when that matters, prefer the client's own prompt or edit its user file. Run with --dry-run first to see what would change.",
  args: [{ name: 'slug', required: true }],
  options: {
    client: { type: 'string', valueName: 'id', choices: [...CLIENT_IDS], description: `Client: ${CLIENT_IDS.join(', ')}` },
    'dry-run': { type: 'boolean', description: 'Show what would change, and change nothing' },
    yes: { type: 'boolean', short: 'y', description: 'Do not ask; also replaces an entry with the same name (after a backup)' },
    project: { type: 'boolean', description: 'Cursor and VS Code: write .cursor/mcp.json or .vscode/mcp.json in this folder instead of your user file' },
    global: { type: 'boolean', description: 'Claude Code and Gemini CLI: add it for all your projects (--scope user, -s user)' },
    file: { type: 'string', valueName: 'path', description: 'Cursor, VS Code, Claude Desktop, Devin Desktop: write this config file instead' },
  },
  examples: [
    'mcp-tc add deepwiki --client cursor --dry-run',
    'mcp-tc add deepwiki --client claude-code',
    'mcp-tc add memory --client claude-desktop',
    'mcp-tc add notion --client vscode --project',
    'mcp-tc add ref-tools --client claude-ai',
  ],
  exits: [
    [0, 'done: added, already there, steps printed, or a dry run'],
    [1, 'error, including a client command that failed, a file that could not be written, a file that changed while add was waiting, or a link that leads outside the project folder'],
    [2, 'usage error, including values add needs but could not ask for (--yes, or no terminal) and a key that would go into a project file'],
    [3, 'no listing with that slug, or mcp.tc has no steps for that client'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) after the retries'],
  ],
};

const SCOPE_FLAG = { 'claude-code': ['--scope', 'user'], gemini: ['-s', 'user'] };
const FLAG = /^--?[A-Za-z][\w-]*$/;

/**
 * @typedef {object} Guide get_server setup entry
 * @property {string} client
 * @property {string} label
 * @property {string|null} [quick]
 * @property {string[]} steps
 * @property {string|null} [code]
 * @property {string|null} [link]
 * @property {string|null} [note]
 */

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const input = String(ctx.positionals[0] || '').trim();
  if (input.length > 200) throw new UsageError('That is too long for a slug or link (200 characters at most).', {}, 'invalid_argument');
  const client = ctx.args.client;
  if (!client) {
    throw new UsageError(`Missing --client. Choose one of: ${CLIENT_IDS.join(', ')}. Example: mcp-tc add ${input || 'deepwiki'} --client cursor`, {}, 'missing_client');
  }
  const spec = CLIENTS[client];
  if (ctx.args.project && ctx.args.file) throw new UsageError('Use --project or --file, not both.');
  if (ctx.args.project && client !== 'cursor' && client !== 'vscode') {
    throw new UsageError(`--project works with cursor and vscode only: ${spec.label} has no project file.`);
  }
  if (ctx.args.file && spec.kind !== 'file') throw new UsageError(`--file works with cursor, vscode, claude-desktop and devin, not ${client}.`);
  if (ctx.args.global && client !== 'claude-code' && client !== 'gemini' && client !== 'codex') {
    throw new UsageError('--global works with claude-code and gemini (Codex already adds servers for all projects).');
  }

  const ref = listingQuery(input, ctx.base); // refuses URL- or key-shaped input before any request
  const opts = clientOptions(ctx);
  const d = await mcpCall('get_server', { slug: ref.slug, client }, opts);
  const found = (Array.isArray(d.setup) ? d.setup : []).find((/** @type {any} */ g) => g && g.client === client);
  if (!found) throw await noSetup(d, client, opts);
  const guide = cleanGuide(found);

  const base = {
    slug: String(d.slug),
    name: clean(d.name || d.slug, { oneLine: true }).slice(0, 120),
    link: d.link || null,
    client,
    client_label: spec.label,
    dry_run: Boolean(ctx.args['dry-run']),
  };
  if (spec.kind === 'cli') {
    const r = await runCommands(ctx, d, guide, base);
    if (r) return r;
  } else if (spec.kind === 'file') {
    const r = await writeFile(ctx, d, guide, base);
    if (r) return r;
  }
  return steps(guide, base);
}

/**
 * Step text from mcp.tc, made safe for a terminal and for --json: a carriage return could move the cursor back and
 * print one command over another, so CRLF and a lone CR both become a newline; other control characters, bidi marks
 * and escape sequences go.
 * @param {any} g
 * @returns {Guide}
 */
function cleanGuide(g) {
  const t = (/** @type {unknown} */ v) => (typeof v === 'string' ? clean(v.replace(/\r\n?/g, '\n')) : v ?? null);
  return {
    ...g,
    label: /** @type {string} */ (t(g.label)),
    quick: /** @type {string|null} */ (t(g.quick)),
    steps: Array.isArray(g.steps) ? g.steps.map((/** @type {unknown} */ s) => /** @type {string} */ (t(String(s)))) : [],
    code: /** @type {string|null} */ (t(g.code)),
    link: /** @type {string|null} */ (t(g.link)),
    note: /** @type {string|null} */ (t(g.note)),
  };
}

/**
 * The error for a client mcp.tc has no steps for, naming the clients it does have and, for a server with no install
 * command at all, where its own instructions are.
 * @param {any} d
 * @param {string} client
 * @param {any} opts
 */
async function noSetup(d, client, opts) {
  /** @type {string[]} */
  let available = [];
  try {
    const all = await mcpCall('get_server', { slug: d.slug }, opts);
    available = (all.setup || []).map((/** @type {any} */ g) => clean(String(g.client), { oneLine: true }));
  } catch {
    available = [];
  }
  const vendor = clean(d.repository || d.docs || d.homepage || '', { oneLine: true }) || null;
  const label = CLIENTS[client].label;
  const name = clean(d.name || d.slug, { oneLine: true });
  if (d.kind === 'local' && !d.install_command) {
    return new CliError(
      'no_setup',
      `mcp.tc has no install command for ${name}, so there are no ${label} steps to follow. Install it from its own instructions${vendor ? `: ${vendor}` : ` (see ${clean(d.link, { oneLine: true })})`}.`,
      EXIT.NOT_FOUND,
      { available, vendor_url: vendor },
    );
  }
  const why = d.kind === 'local' && (client === 'claude-ai' || client === 'chatgpt') ? ` ${label} connects only to remote servers, and this one runs on your computer.` : '';
  return new CliError(
    'no_setup',
    `mcp.tc has no ${label} steps for ${name}.${why}${available.length ? ` Steps exist for: ${available.join(', ')}.` : ''}`,
    EXIT.NOT_FOUND,
    { available, vendor_url: vendor },
  );
}

// ------------------------------------------------------------------ steps only

/**
 * @param {Guide} guide
 * @param {Record<string, any>} base
 * @param {string[]} [warnings]
 */
function steps(guide, base, warnings = []) {
  return { ...base, action: 'steps', steps: guide.steps || [], code: guide.code ?? null, setup_link: guide.link ?? null, note: guide.note ?? null, warnings };
}

// ------------------------------------------------------------------ clients with their own command

/**
 * Split a command line the way a POSIX shell would, but only when that is unambiguous: plain words, single quotes,
 * and double quotes without $, backquotes, backslashes or "!". Anything else (pipes, &&, ;, redirections, $(...),
 * globs, a leading ~) is refused, so nothing is ever left to a shell.
 * @param {string} line
 * @returns {{argv: string[]}|{error: string}}
 */
export function splitCommand(line) {
  /** @type {string[]} */
  const argv = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      if (has) argv.push(cur);
      cur = '';
      has = false;
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return { error: 'a quote that is not closed' };
      cur += line.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        if ('$`\\!'.includes(line[j])) return { error: `"${line[j]}" inside double quotes` };
        cur += line[j++];
      }
      if (j >= line.length) return { error: 'a quote that is not closed' };
      has = true;
      i = j + 1;
    } else if (/[A-Za-z0-9@%_+=:,./~-]/.test(c)) {
      if (c === '~' && !has) return { error: 'a "~" the shell would expand' };
      cur += c;
      has = true;
      i++;
    } else {
      return { error: `shell syntax ("${c}")` };
    }
  }
  if (has) argv.push(cur);
  return { argv };
}

/**
 * A word as it would be typed in a POSIX shell.
 * @param {string} a
 */
export function shellQuote(a) {
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(a)) return a;
  if (!a.includes("'")) return `'${a}'`;
  if (!/["$`\\!]/.test(a)) return `"${a}"`;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * The only commands add runs: "<client> mcp add", plus "codex mcp login" for a server that signs in. Anything else in
 * a setup (removing a server, running the client with a prompt) is shown as a step and never run.
 * @param {string} bin
 * @param {string[]} argv
 */
export function allowedCommand(bin, argv) {
  return argv[0] === bin && argv[1] === 'mcp' && (argv[2] === 'add' || (bin === 'codex' && argv[2] === 'login'));
}

/**
 * The scope option the client itself reads in an "mcp add" command (-s or --scope, with its value), looking only at
 * the client's own options: the words after "mcp add" and before "--". A "-s" among the server's own arguments
 * (after "--") belongs to the server, not to the client.
 * @param {string[]} argv
 * @returns {{index: number, value: string|null, inline: boolean}|null}
 */
export function ownScope(argv) {
  const end = argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--');
  for (let i = 3; i < end; i++) {
    const a = argv[i];
    if (a === '-s' || a === '--scope') return { index: i, value: i + 1 < end ? argv[i + 1] : null, inline: false };
    const m = /^(?:-s|--scope)=(.*)$/.exec(a);
    if (m) return { index: i, value: m[1], inline: true };
  }
  return null;
}

/**
 * @param {any} ctx
 * @param {any} d get_server result
 * @param {Guide} guide
 * @param {Record<string, any>} base
 */
async function runCommands(ctx, d, guide, base) {
  const spec = CLIENTS[base.client];
  const bin = /** @type {string} */ (spec.bin);
  const code = typeof guide.code === 'string' ? guide.code : '';
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  /** @type {string[][]} */
  const commands = [];
  for (const line of lines) {
    const r = splitCommand(line);
    if ('error' in r) return steps(guide, base, [clean(`The ${spec.label} command uses ${r.error}, so mcp-tc does not run it. Copy it from the steps below.`, { oneLine: true })]);
    if (r.argv[0] !== bin) return steps(guide, base, [`The ${spec.label} step is not a "${bin}" command, so mcp-tc does not run it.`]);
    if (!allowedCommand(bin, r.argv)) {
      const what = clean(r.argv.slice(0, 3).join(' '), { oneLine: true }).slice(0, 80);
      return steps(guide, base, [`The ${spec.label} steps include "${what}", and mcp-tc only runs "${bin} mcp add"${bin === 'codex' ? ' and "codex mcp login"' : ''} commands, so it runs nothing. Follow the steps below yourself.`]);
    }
    commands.push(r.argv);
  }
  if (!commands.length) return null;
  const adds = commands.filter((a) => a[2] === 'add');
  if (ctx.args.global && Object.hasOwn(SCOPE_FLAG, base.client)) {
    const flag = SCOPE_FLAG[/** @type {'gemini'} */ (base.client)];
    for (const argv of adds) {
      const sc = ownScope(argv);
      if (!sc) argv.splice(3, 0, ...flag);
      else if (sc.inline) argv[sc.index] = `${argv[sc.index].split('=')[0]}=user`;
      else if (sc.value === null) argv.splice(sc.index + 1, 0, 'user');
      else argv[sc.index + 1] = 'user';
    }
  }
  for (const argv of commands) refuseListingLink(argv, ctx.base);

  if (base.client === 'codex') {
    const gap = codexHeaderGap(d, commands, guide);
    if (gap) return steps(guide, base, [gap]);
  }

  const holders = placeholders(commands, d);
  const shown = commands.map((argv) => argv.map(shellQuote).join(' '));
  const scopes = adds.map((a) => ownScope(a));
  // Gemini CLI keeps a server in .gemini/settings.json in this folder unless told -s user; Claude Code keeps it in
  // .mcp.json in this folder with --scope project (its default, local, is private to this user)
  const repoScope =
    base.client === 'gemini' ? scopes.some((sc) => !sc || sc.value !== 'user') : base.client === 'claude-code' ? scopes.some((sc) => sc !== null && sc.value === 'project') : false;
  const plan = {
    ...base,
    commands: shown.map((text) => ({ text, exit_code: /** @type {number|null} */ (null) })),
    placeholders: holders.map((h) => h.token),
    global: Boolean(ctx.args.global),
    next_steps: nextSteps(guide.steps, 'bash'),
    note: guide.note ?? null,
    complete: /** @type {boolean|null} */ (null),
    warnings: /** @type {string[]} */ ([]),
  };
  if (holders.some((h) => h.secret) && repoScope) {
    const where = base.client === 'gemini' ? '.gemini/settings.json' : '.mcp.json (--scope project)';
    throw new UsageError(
      `${spec.label} would save this server, with your key, in ${where} in this folder, which can end up in a repository. Run it with --global to keep it in your user settings instead.`,
      { commands: shown },
      'key_in_project_file',
    );
  }

  if (!ctx.json) {
    ctx.out.print(`${spec.label}: ${commands.length > 1 ? 'these commands add' : 'this command adds'} ${base.name}:`);
    for (const s of shown) ctx.out.print(`  $ ${ctx.out.clean(s, { oneLine: true })}`);
  }
  if (base.dry_run) return { ...plan, action: 'would_run' };

  /** @type {Record<string, string>} */
  let values = {};
  if (holders.length) {
    if (ctx.args.yes || !ctx.stdin.isTTY) {
      throw new UsageError(
        `This command needs ${holders.map((h) => h.token).join(', ')}. Run mcp-tc add in a terminal without --yes to type ${holders.length > 1 ? 'them' : 'it'} (${holders.some((h) => h.secret) ? 'keys stay' : 'it stays'} on this computer), or replace the placeholder${holders.length > 1 ? 's' : ''} and run the command yourself.`,
        { commands: shown, placeholders: holders.map((h) => h.token) },
        'needs_values',
      );
    }
    values = await askValues(ctx, holders, true);
  }
  const ok = await (ctx.confirm || promptConfirm)(commands.length > 1 ? 'Run these commands?' : 'Run it?', { yes: ctx.args.yes, stdin: ctx.stdin, stderr: ctx.stderr });
  if (!ok) throw new CliError('cancelled', 'Cancelled: nothing was run.', EXIT.ERROR);

  for (let i = 0; i < commands.length; i++) {
    const argv = commands[i].map((a) => fill(a, values));
    const r = await spawnOnce(ctx, argv);
    if (r.error) {
      const missing = /** @type {any} */ (r.error).code === 'ENOENT';
      const win = ctx.platform === 'win32';
      throw new CliError(
        missing ? 'client_not_found' : 'command_failed',
        missing
          ? `Could not start "${bin}": ${spec.label} is not installed or not on your PATH.${win ? ` On Windows, mcp-tc looks for ${bin}.exe or ${bin}.com in the folders on your PATH, never in the current folder, and it can't start commands that npm installed (.cmd files), because it never uses a shell.` : ''} Run the command yourself: ${clean(shown[i], { oneLine: true })}`
          : `Could not start "${bin}": ${r.error.message}`,
        EXIT.ERROR,
        { command: shown[i] },
      );
    }
    plan.commands[i].exit_code = r.code ?? null;
    if (r.code !== 0) {
      throw new CliError('command_failed', `"${bin}" stopped with exit code ${r.code ?? r.signal}. Nothing else was run.`, EXIT.ERROR, {
        command: shown[i],
        exit_code: r.code ?? null,
      });
    }
  }
  return { ...plan, complete: true, action: 'ran' };
}

/**
 * Codex and a server that needs a key in a header other than Authorization: `codex mcp add` has no option for it,
 * and mcp.tc's Codex steps set it in config.toml (env_http_headers) instead. Running the command alone would add a
 * server that answers without the key, so add stops and prints the steps, with what to do. Null when nothing is
 * missing.
 * @param {any} d
 * @param {string[][]} commands
 * @param {Guide} guide
 * @returns {string|null}
 */
function codexHeaderGap(d, commands, guide) {
  if (!d || d.kind !== 'remote' || d.auth !== 'api_key') return null;
  const needed = (Array.isArray(d.headers) ? d.headers : [])
    .filter((/** @type {any} */ h) => h && typeof h.name === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(h.name) && (h.required || h.secret))
    .map((/** @type {any} */ h) => String(h.name));
  if (!needed.length) return null;
  const words = commands.flat().map((w) => w.toLowerCase());
  const carried = (/** @type {string} */ name) =>
    words.some((w) => w.startsWith(`${name.toLowerCase()}:`)) || (name.toLowerCase() === 'authorization' && words.includes('--bearer-token-env-var'));
  const missing = needed.filter((n) => !carried(n));
  if (!missing.length) return null;
  const toml = (guide.steps || []).map(String).find((s) => s.startsWith('```toml\n')) || '';
  /** @type {string[]} */
  const vars = [];
  const block = /env_http_headers\s*=\s*\{([^}]*)\}/.exec(toml);
  if (block) {
    for (const m of block[1].matchAll(/"([^"]+)"\s*=\s*"([A-Za-z_][A-Za-z0-9_]{0,63})"/g)) {
      if (missing.some((n) => n.toLowerCase() === m[1].toLowerCase())) vars.push(m[2]);
    }
  }
  const bearer = /bearer_token_env_var\s*=\s*"([A-Za-z_][A-Za-z0-9_]{0,63})"/.exec(toml);
  if (bearer && missing.some((n) => n.toLowerCase() === 'authorization')) vars.push(bearer[1]);
  const headers = missing.join(' and ');
  const what = toml
    ? `Skip the codex mcp add command and add the config.toml block below to Codex's config.toml (~/.codex/config.toml, or $CODEX_HOME/config.toml)${vars.length ? `, then set ${vars.join(' and ')} to your key in the environment Codex runs in` : ''}.`
    : `Add the ${headers} header by hand, or use another client: the listing has the other ways (${clean(d.link || '', { oneLine: true })}).`;
  return clean(`Codex can't take the ${headers} header on the command line, so mcp-tc does not run the command: the server would answer without your key. ${what}`, { oneLine: true });
}

/**
 * Windows: the full path of a client's program, looked up in the absolute folders of PATH only. Windows searches the
 * current folder first for a bare name, and a cloned repository could ship a claude.exe there. Only .exe and .com:
 * a .cmd or .bat needs a shell, which mcp-tc never uses. Null when it is not found.
 * @param {string} name
 * @param {Record<string, string|undefined>} env
 * @param {(file: string) => boolean} [isFile]
 */
export function findWindowsProgram(name, env, isFile = fileExists) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const dirs = key ? String(env[key] || '').split(';') : [];
  for (const raw of dirs) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    // a drive or UNC path only: never ".", an empty entry or a folder relative to the current one
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(dir)) continue;
    for (const ext of ['.exe', '.com']) {
      const full = path.win32.join(dir, `${name}${ext}`);
      if (isFile(full)) return full;
    }
  }
  return null;
}

/** @param {string} file */
function fileExists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Start one command without a shell and wait for it. In --json mode its output goes to stderr, so stdout keeps only
 * the JSON document. On Windows the program is started by its full path (see findWindowsProgram), and the programs
 * it starts are told not to search the current folder either.
 * @param {any} ctx
 * @param {string[]} argv
 * @returns {Promise<{code?: number|null, signal?: string|null, error?: Error}>}
 */
function spawnOnce(ctx, argv) {
  return new Promise((resolve) => {
    let program = argv[0];
    let env = ctx.env;
    if (ctx.platform === 'win32') {
      const found = findWindowsProgram(argv[0], ctx.env || {}, ctx.isFile);
      if (!found) {
        resolve({ error: Object.assign(new Error(`${argv[0]} was not found in the folders on PATH`), { code: 'ENOENT' }) });
        return;
      }
      program = found;
      env = { ...ctx.env, NoDefaultCurrentDirectoryInExePath: '1' };
    }
    let child;
    try {
      child = ctx.spawn(program, argv.slice(1), {
        cwd: ctx.cwd,
        env,
        shell: false,
        stdio: [ctx.stdin && ctx.stdin.isTTY ? 'inherit' : 'ignore', ctx.json ? 'pipe' : 'inherit', 'inherit'],
      });
    } catch (err) {
      resolve({ error: /** @type {Error} */ (err) });
      return;
    }
    if (child.stdout) child.stdout.on('data', (/** @type {Buffer} */ b) => ctx.stderr.write(b));
    child.once('error', (/** @type {Error} */ err) => resolve({ error: err }));
    child.once('close', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => resolve({ code, signal }));
  });
}

// ------------------------------------------------------------------ clients with a JSON file

/**
 * The JSON snippet of a setup entry that has the client's container key: `code` first, then the ```json blocks of
 * the steps (VS Code's code is its `code --add-mcp` command; the file comes later).
 * @param {Guide} guide
 * @param {string} container
 * @returns {{obj: Record<string, any>, index: number}|null}
 */
export function jsonSnippet(guide, container) {
  /** @type {{text: string, index: number}[]} */
  const candidates = [];
  if (typeof guide.code === 'string') candidates.push({ text: guide.code, index: -1 });
  (guide.steps || []).forEach((s, index) => {
    const m = /^```json\n([\s\S]*)\n```$/.exec(String(s));
    if (m) candidates.push({ text: m[1], index });
  });
  for (const c of candidates) {
    let obj;
    try {
      obj = JSON.parse(c.text);
    } catch {
      continue;
    }
    if (isPlainObject(obj) && isPlainObject(obj[container])) {
      const index = c.index === -1 ? (guide.steps || []).findIndex((s) => String(s).includes(c.text)) : c.index;
      return { obj, index };
    }
  }
  return null;
}

/**
 * @param {any} ctx
 * @param {any} d
 * @param {Guide} guide
 * @param {Record<string, any>} base
 */
async function writeFile(ctx, d, guide, base) {
  const spec = CLIENTS[base.client];
  const container = /** @type {string} */ (spec.container);
  const snip = jsonSnippet(guide, container);
  if (!snip) return null; // steps only (Claude Desktop adds remote servers under Customize, Connectors)
  const names = Object.keys(snip.obj[container]);
  const name = names[0];
  if (names.length !== 1 || !/^[A-Za-z0-9._-]{1,64}$/.test(name) || !isPlainObject(snip.obj[container][name])) {
    return steps(guide, base, ['This setup is not a single server entry, so mcp-tc does not write it.']);
  }
  const entry = snip.obj[container][name];
  const inputs = Array.isArray(snip.obj.inputs) ? snip.obj.inputs.filter((/** @type {unknown} */ x) => isPlainObject(x) && typeof x.id === 'string') : [];
  refuseListingLink([entry, inputs], ctx.base);

  const w = where(ctx);
  /** @type {string|null} */
  let file;
  /** @type {'user'|'project'|'custom'} */
  let scope;
  if (ctx.args.file) {
    file = path.resolve(ctx.cwd, ctx.args.file);
    scope = 'custom';
  } else if (ctx.args.project) {
    file = projectFile(base.client, w);
    scope = 'project';
  } else {
    file = userFile(base.client, w);
    scope = 'user';
  }
  if (!file) {
    return steps(guide, base, [`${spec.label} is available for macOS and Windows only, so there is no config file to write here. Use --file <path> to write one anyway.`]);
  }
  const shownFile = displayPath(file, w);
  // where the file really is: a linked file (~/.cursor/mcp.json -> ~/dotfiles/...) or a linked folder is written at
  // its target, so every decision below is made there
  const real = realLocation(file);
  const linkedTo = linkedTarget(file, w);
  const linked = linkedTo !== null;
  const shownReal = displayPath(linkedTo ?? real, w);
  const shownWhere = linked ? `${shownFile} (a link to ${shownReal})` : shownFile;
  if (scope === 'project' && !isInside(real, realLocation(w.cwd))) {
    // a project can be a cloned repository: a link in it must not make add change a file somewhere else
    throw new CliError(
      'outside_project',
      `${shownFile} leads to ${shownReal}, outside this project folder, so mcp-tc does not write it. Check where that link points; to add the server for all your projects, run add without --project.`,
      EXIT.ERROR,
      { file, real_path: real },
    );
  }
  /** @type {string[]} */
  const warnings = [];
  const holders = placeholders([entry], d);
  const secretHolders = holders.filter((h) => h.secret);
  const repo = scope === 'project' ? w.cwd : repoForWrite(file);
  if (secretHolders.length && scope === 'project') {
    throw new UsageError(
      `${base.name} needs ${secretHolders.map((h) => h.token).join(', ')}, and ${shownFile} is a project file that can end up in a repository. mcp-tc writes keys only into your user config: run it again without --project.`,
      { file },
      'key_in_project_file',
    );
  }
  if (secretHolders.length && repo) {
    const tokens = secretHolders.map((h) => h.token).join(', ');
    warnings.push(
      `${linked ? `${shownFile} links to ${shownReal}, which is` : `${shownFile} is`} inside a git repository (${displayPath(repo, w)}), so mcp-tc leaves ${tokens} as ${secretHolders.length > 1 ? 'placeholders' : 'a placeholder'}. Keep your key out of that repository.`,
    );
  }
  if (scope === 'user' && !existsSync(file)) {
    const legacy = legacyFiles(base.client, w).find((f) => existsSync(f));
    if (legacy) warnings.push(`${shownFile} does not exist yet, but ${displayPath(legacy, w)} does. If your ${spec.label} still reads that one, run again with --file ${displayPath(legacy, w)}.`);
    else if (!existsSync(path.dirname(file))) warnings.push(`${displayPath(path.dirname(file), w)} does not exist yet: is ${spec.label} installed? mcp-tc creates the folder.`);
  }

  const cur = readJsonForWrite(file);
  if (cur.problem) throw manual(ctx, cur.problem, shownFile, snip.obj, file);
  const merged = mergeServer(cur.data, { container, name, entry, inputs, replace: Boolean(ctx.args.yes) || base.dry_run });
  if (merged.problem) throw manual(ctx, 'unexpected_shape', shownFile, snip.obj, file, merged.problem);
  if (merged.status === 'conflict') {
    throw new UsageError(
      `${shownFile} already has a server named "${name}" with other settings. mcp-tc leaves it as it is; to replace it, run again with --yes (the file is backed up first).`,
      { file, entry: name },
      'entry_exists',
    );
  }
  const replacing = merged.status === 'replaced';
  const writes = !(merged.status === 'same' && !merged.inputsAdded.length);
  if (replacing) {
    warnings.push(
      ctx.args.yes
        ? `Replacing the existing "${name}" entry in ${shownFile}; the old file is kept as a backup.`
        : `${shownFile} already has a different "${name}" entry: without --dry-run, mcp-tc replaces it only with --yes.`,
    );
  }
  for (const id of merged.inputsKept) warnings.push(`${shownFile} already has an input "${clean(id, { oneLine: true })}" with other settings; mcp-tc keeps yours.`);

  // The diff compares redacted copies, both written the same way: other servers' values show as <hidden> (a flag and
  // its value, a short password, a key under any name), only the entry add writes is shown, and a file that mcp-tc
  // reformats does not turn into a whole-file diff.
  const body = cur.text.replace(/^\uFEFF/, '');
  const hasBody = cur.exists && body.trim() !== '';
  const before = hasBody ? serialize(redactConfig(cur.data, { container }), cur) : '';
  const after = serialize(redactConfig(merged.data, { container, name: merged.status === 'same' ? undefined : name, inputs: merged.inputsAdded }), cur);
  const diff = unifiedDiff(before, after, { from: cur.exists ? shownFile : '/dev/null', to: shownFile });
  const reformat = writes && hasBody && serialize(cur.data, cur) !== body;
  if (reformat) warnings.push(`mcp-tc writes ${shownFile} back in its own layout (indentation and line breaks change, the settings don't); the backup keeps the original.`);
  const bdir = backupDir(w);
  if (writes && cur.exists) {
    const bRepo = repoForWrite(path.join(bdir, 'backup'));
    if (bRepo) warnings.push(`The backup goes to ${displayPath(bdir, w)}, which is inside a git repository (${displayPath(bRepo, w)}): keep that folder out of commits.`);
  }
  const plan = {
    ...base,
    file,
    linked_to: linkedTo,
    scope,
    entry: name,
    replaced: replacing,
    backup: /** @type {string|null} */ (null),
    diff: diff || null,
    reformat,
    placeholders: holders.map((h) => h.token),
    // keys that stay placeholders even in a terminal: the file is in a git repository
    kept: holders.filter((h) => h.secret && repo).map((h) => h.token),
    filled: /** @type {string[]} */ ([]),
    complete: /** @type {boolean|null} */ (null),
    next_steps: nextSteps(guide.steps, 'json', snip.index),
    install_link: guide.link ?? null,
    note: guide.note ?? null,
    warnings,
  };
  if (!writes) {
    return { ...plan, action: 'unchanged', diff: null, reformat: false, complete: holders.length === 0 };
  }

  if (!ctx.json) {
    ctx.out.print(`${spec.label}: add "${name}" to ${shownWhere}${scope === 'project' ? ' (this project)' : ''}`);
    ctx.out.print('');
    ctx.out.print(colorDiff(diff, ctx.out));
    ctx.out.print('');
  }
  for (const wtext of warnings) ctx.out.warn(clean(wtext));
  if (base.dry_run) return { ...plan, action: 'would_write', replaced: replacing };

  // values for the placeholders: never for a key in a repository, never without a terminal
  const askable = holders.filter((h) => !(h.secret && repo));
  /** @type {Record<string, string>} */
  let values = {};
  if (askable.length && !ctx.args.yes && ctx.stdin.isTTY) values = await askValues(ctx, askable, false);
  const ok = await (ctx.confirm || promptConfirm)(`Write ${shownFile}?`, { yes: ctx.args.yes, stdin: ctx.stdin, stderr: ctx.stderr });
  if (!ok) throw new CliError('cancelled', 'Cancelled: nothing was written.', EXIT.ERROR);

  // The file must still be what the merge and the diff were built from: a client (or the person) may have changed it
  // while add waited for an answer, and writing the old merge would drop that change. Checked and written at the real
  // location the decisions above were made for, so a link changed in the meantime can't move the write elsewhere.
  const nowBytes = readBytes(real);
  const unchanged = cur.raw === null ? nowBytes === null : nowBytes !== null && nowBytes.equals(cur.raw);
  if (!unchanged) {
    throw new CliError('changed_while_waiting', `${shownFile} changed while mcp-tc was waiting for your answer. Nothing was written: run add again to see the new diff.`, EXIT.ERROR, { file });
  }

  const filledEntry = fillDeep(entry, values);
  const final = mergeServer(cur.data, { container, name, entry: filledEntry, inputs, replace: true });
  const text = (cur.text.startsWith('\uFEFF') ? '\uFEFF' : '') + serialize(final.data, cur);
  if (cur.exists) {
    try {
      // the backup holds the bytes the merge was built from
      plan.backup = backupFile(real, ctx.now(), { dir: bdir, bytes: cur.raw ?? undefined, key: real });
    } catch (err) {
      throw new CliError('write_failed', `Could not save a backup of ${shownFile} in ${displayPath(bdir, w)} (${errText(err)}), so mcp-tc did not change the file.`, EXIT.ERROR, {
        file,
        backup_dir: bdir,
      });
    }
  }
  try {
    writeFileAtomic(real, text, { mode: cur.mode ?? 0o600 });
  } catch (err) {
    throw new CliError(
      'write_failed',
      `Could not write ${shownWhere} (${errText(err)}). The file was not changed${plan.backup ? `; a backup is at ${displayPath(plan.backup, w)}` : ''}.`,
      EXIT.ERROR,
      { file, backup: plan.backup },
    );
  }
  plan.filled = holders.map((h) => h.token).filter((t) => Object.hasOwn(values, t));
  plan.placeholders = holders.map((h) => h.token).filter((t) => !plan.filled.includes(t));
  plan.complete = plan.placeholders.length === 0;
  if (plan.filled.length && cur.mode !== null && cur.mode & 0o077 && ctx.platform !== 'win32') {
    plan.warnings.push(`${shownFile} can be read by other users on this computer. Consider: chmod 600 ${shownFile}`);
    ctx.out.warn(plan.warnings[plan.warnings.length - 1]);
  }
  return { ...plan, action: 'written' };
}

/** @param {unknown} err */
function errText(err) {
  const e = /** @type {any} */ (err);
  return clean(e && e.code ? String(e.code) : e && e.message ? String(e.message) : String(err), { oneLine: true }).slice(0, 200);
}

/**
 * A file mcp-tc won't rewrite: print the snippet to add by hand (human mode) and return the error to throw.
 * @param {any} ctx
 * @param {string} problem
 * @param {string} shownFile
 * @param {Record<string, any>} snippet
 * @param {string} file
 * @param {string} [detail]
 */
function manual(ctx, problem, shownFile, snippet, file, detail) {
  const why = {
    comments: 'has comments or trailing commas, which rewriting it would drop',
    invalid: 'is not valid JSON',
    not_object: 'does not hold a JSON object',
    too_large: 'is too large to rewrite safely',
    unreadable: 'could not be read',
    not_a_file: 'is not a regular file',
    unexpected_shape: `has an unexpected shape (${detail})`,
  }[problem] || problem;
  const text = JSON.stringify(snippet, null, 2);
  if (!ctx.json) {
    ctx.out.print(`Add this to ${shownFile} by hand:`);
    ctx.out.print('');
    ctx.out.print(ctx.out.clean(text));
    ctx.out.print('');
  }
  return new CliError(problem === 'comments' ? 'has_comments' : 'cannot_rewrite', `${shownFile} ${why}, so mcp-tc does not change it.${ctx.json ? '' : ' The snippet to add by hand is above.'}`, EXIT.ERROR, {
    file,
    snippet: text,
  });
}

/**
 * @param {string} diff
 * @param {import('../lib/output.js').Output} out
 */
function colorDiff(diff, out) {
  return diff
    .split('\n')
    .map((l) => out.clean(l))
    .map((l) => (l.startsWith('+++') || l.startsWith('---') ? out.style.bold(l) : l.startsWith('@@') ? out.style.cyan(l) : l.startsWith('+') ? out.style.green(l) : l.startsWith('-') ? out.style.red(l) : l))
    .join('\n');
}

// ------------------------------------------------------------------ placeholders, values, steps

/**
 * A value to fill in, as mcp.tc's snippets mark it.
 *   kind angle  <YOUR_API_KEY>, <your-org>: anywhere in a value
 *   kind your   YOUR_EMAIL: a whole word (also after --flag=, NAME= or "Header: ")
 *   kind path   /path/to/repo: a whole word
 *   kind brace  {tenant}: a whole word (never ${...}, which is a client's own variable)
 * @typedef {{token: string, name: string, secret: boolean, kind: 'angle'|'your'|'path'|'brace', context: string|null}} Placeholder
 */

const PH_ANGLE = /<[^<>\s]{1,60}>/g;
const PH_YOUR = /(?<![A-Za-z0-9_<])YOUR_[A-Z0-9_]+(?![A-Za-z0-9_>])/g;
const PH_PATH = /(?<![A-Za-z0-9._~/-])\/path\/to\/[A-Za-z0-9._/-]*/g;
const PH_BRACE = /(?<![A-Za-z0-9_${])\{[A-Za-z_][A-Za-z0-9_.-]{0,59}\}(?!\})/g;

/**
 * The placeholders in one string, in order.
 * @param {string} s
 * @returns {{token: string, kind: Placeholder['kind'], index: number}[]}
 */
function findIn(s) {
  /** @type {{token: string, kind: Placeholder['kind'], index: number}[]} */
  const out = [];
  for (const m of s.matchAll(PH_ANGLE)) out.push({ token: m[0], kind: 'angle', index: /** @type {number} */ (m.index) });
  // the other forms never inside an <...> one
  const masked = s.replace(PH_ANGLE, (m) => '\u0000'.repeat(m.length));
  for (const [re, kind] of /** @type {[RegExp, Placeholder['kind']][]} */ ([
    [PH_YOUR, 'your'],
    [PH_PATH, 'path'],
    [PH_BRACE, 'brace'],
  ])) {
    for (const m of masked.matchAll(re)) out.push({ token: m[0], kind, index: /** @type {number} */ (m.index) });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * True when a string holds any placeholder form.
 * @param {string} s
 */
export function hasPlaceholder(s) {
  return findIn(String(s)).length > 0;
}

/**
 * What a placeholder is a value for: the flag before it (--api-key VALUE, --api-key=VALUE), the variable (NAME=VALUE),
 * the header ("X-Api-Key: VALUE"), the query parameter, or the JSON key it sits under.
 * @param {string} s
 * @param {number} index
 * @param {string} outer
 */
function contextOf(s, index, outer) {
  const before = s.slice(0, index);
  if (before === '' || /^Bearer\s+$/i.test(before)) return outer;
  let m = /^(--?[A-Za-z][\w-]*)=$/.exec(before);
  if (m) return m[1];
  m = /^([A-Za-z_][A-Za-z0-9_]*)=$/.exec(before);
  if (m) return m[1];
  m = /^([A-Za-z0-9-]+):\s*(?:Bearer\s+)?$/i.exec(before);
  if (m) return m[1];
  m = /[?&]([A-Za-z0-9_.-]+)=$/.exec(before);
  if (m) return m[1];
  return outer;
}

/**
 * The placeholder's name, for matching mcp.tc's env_vars and headers: <YOUR_API_KEY> and YOUR_API_KEY give API_KEY,
 * /path/to/repo gives REPO, {tenant} gives TENANT.
 * @param {string} token
 * @param {Placeholder['kind']} kind
 */
function nameOf(token, kind) {
  const inner = kind === 'angle' || kind === 'brace' ? token.slice(1, -1) : kind === 'path' ? token.slice(9) : token;
  return inner.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^YOUR_/, '') || 'VALUE';
}

/**
 * The placeholders in commands or snippets, with whether each is a secret: from the flag, variable, header or key it
 * belongs to (--api-key, X-Ref-Api-Key, a password), or from what mcp.tc says about the variable or header with that
 * name. A /path/to/ placeholder is never a secret.
 * @param {unknown[]} values
 * @param {any} d get_server result (env_vars and headers say which are secret)
 * @returns {Placeholder[]}
 */
export function placeholders(values, d) {
  /** @type {Map<string, Placeholder>} */
  const found = new Map();
  const take = (/** @type {string} */ s, /** @type {string} */ outer) => {
    for (const o of findIn(s)) {
      const context = contextOf(s, o.index, outer) || null;
      const name = nameOf(o.token, o.kind);
      const secret = o.kind !== 'path' && ((context !== null && secretWord(context)) || isSecret(name, d));
      const have = found.get(o.token);
      if (have) {
        have.secret = have.secret || secret;
        if (!have.context && context) have.context = context;
      } else {
        found.set(o.token, { token: o.token, name, secret, kind: o.kind, context });
      }
    }
  };
  const visit = (/** @type {unknown} */ v, /** @type {string} */ outer) => {
    if (typeof v === 'string') take(v, outer);
    else if (Array.isArray(v)) v.forEach((x, i) => visit(x, i > 0 && typeof v[i - 1] === 'string' && FLAG.test(/** @type {string} */ (v[i - 1])) ? /** @type {string} */ (v[i - 1]) : ''));
    else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  values.forEach((v) => visit(v, ''));
  return [...found.values()];
}

/** @param {string} s a flag, variable, header or key name */
function secretWord(s) {
  return SECRET_NAME.test(s) || /key|token|secret|password/i.test(s);
}

/**
 * @param {string} name placeholder name, like API_KEY or GITHUB_TOKEN
 * @param {any} d
 */
function isSecret(name, d) {
  const norm = (/** @type {string} */ s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  for (const list of [d && d.env_vars, d && d.headers]) {
    for (const v of Array.isArray(list) ? list : []) {
      if (v && typeof v.name === 'string' && norm(v.name) === name) return Boolean(v.secret) || SECRET_NAME.test(name);
    }
  }
  return name === 'API_KEY' || SECRET_NAME.test(name);
}

/**
 * Ask for each placeholder's value in the terminal. Secret values are not echoed. A blank answer keeps the
 * placeholder (files) or stops (commands, which can't run with one). A path is made absolute (~ is your home folder):
 * the client starts the server from a folder of its own choosing.
 * @param {any} ctx
 * @param {Placeholder[]} holders
 * @param {boolean} required
 * @returns {Promise<Record<string, string>>} values by placeholder token
 */
async function askValues(ctx, holders, required) {
  const askFn = ctx.ask || promptAsk;
  /** @type {Record<string, string>} */
  const values = {};
  if (!ctx.json) ctx.out.info(`Values stay on this computer: they go only into ${CLIENTS[ctx.args.client].label}'s config, never to mcp.tc.`);
  for (const h of holders) {
    const about = h.context && h.context !== h.token ? ` (${clean(h.context, { oneLine: true })})` : '';
    const hint = h.secret ? ' (not shown)' : h.kind === 'path' ? ', a folder or file path' : '';
    const answer = String(
      await askFn(`Value for ${clean(h.token, { oneLine: true })}${about}${hint}${required ? '' : ', or Enter to keep the placeholder'}:`, {
        secret: h.secret,
        stdin: ctx.stdin,
        stderr: ctx.stderr,
      }),
    ).trim();
    if (!answer) {
      if (required) throw new UsageError(`No value for ${h.token}: nothing was run.`, {}, 'needs_values');
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (answer.length > 4096 || /[\x00-\x1F\x7F]/.test(answer) || hasPlaceholder(answer)) {
      throw new UsageError(`That value for ${h.token} has characters a config value can't hold, or is a placeholder itself.`, {}, 'invalid_value');
    }
    values[h.token] = h.kind === 'path' ? absolutePath(answer, ctx) : answer;
  }
  return values;
}

/**
 * @param {string} p
 * @param {any} ctx
 */
function absolutePath(p, ctx) {
  const w = where(ctx);
  const expanded = p === '~' ? w.home : /^~[\\/]/.test(p) ? w.p.join(w.home, p.slice(2)) : p;
  return w.p.resolve(w.cwd, expanded);
}

/**
 * A placeholder token as a pattern that matches it where findIn() would.
 * @param {string} token
 */
function tokenPattern(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (token.startsWith('<')) return new RegExp(esc, 'g');
  if (token.startsWith('/path/to/')) return new RegExp(`(?<![A-Za-z0-9._~/-])${esc}(?![A-Za-z0-9._/-])`, 'g');
  if (token.startsWith('{')) return new RegExp('(?<![A-Za-z0-9_$\\{])' + esc + '(?!\\})', 'g');
  return new RegExp(`(?<![A-Za-z0-9_<])${esc}(?![A-Za-z0-9_>])`, 'g');
}

/**
 * @param {string} s
 * @param {Record<string, string>} values by token
 */
function fill(s, values) {
  let out = s;
  for (const [token, value] of Object.entries(values)) out = out.replace(tokenPattern(token), () => value);
  return out;
}

/**
 * @param {any} v
 * @param {Record<string, string>} values
 * @returns {any}
 */
function fillDeep(v, values) {
  if (typeof v === 'string') return fill(v, values);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, values));
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, values)]));
  return v;
}

/**
 * The plain-text steps after the snippet that was used (restart, refresh, sign in), up to the first alternative.
 * @param {string[]} list
 * @param {string} lang fence language of the snippet
 * @param {number} [at] index of the snippet's step when known
 */
function nextSteps(list, lang, at) {
  const all = Array.isArray(list) ? list.map(String) : [];
  const start = at !== undefined && at >= 0 ? at : all.findIndex((s) => s.startsWith(`\`\`\`${lang}\n`));
  if (start < 0) return [];
  /** @type {string[]} */
  const out = [];
  for (const s of all.slice(start + 1)) {
    if (s.startsWith('```') || /^Or\b/.test(s)) break;
    out.push(s);
  }
  return out;
}

/**
 * Stop if a setup ever pointed a client at a listing page: a listing link is a page, not an MCP endpoint.
 * @param {unknown} value
 * @param {string} base
 */
function refuseListingLink(value, base) {
  let host = 'mcp.tc';
  try {
    host = new URL(base).host;
  } catch {
    // keep mcp.tc
  }
  const hosts = ['mcp.tc', 'www.mcp.tc', host].map((h) => h.replace(/[.]/g, '\\.'));
  const re = new RegExp(`^(?:https?://)?(?:${hosts.join('|')})/(?:(?:it|fr|de|es)/)?i/`, 'i');
  const visit = (/** @type {unknown} */ v) => {
    if (typeof v === 'string' && re.test(v.trim())) {
      throw new CliError('listing_link', 'This setup points at an mcp.tc listing page instead of the server, so mcp-tc stops. Please report it at https://mcp.tc/report.', EXIT.ERROR);
    }
    if (Array.isArray(v)) v.forEach(visit);
    else if (isPlainObject(v)) Object.values(v).forEach(visit);
  };
  visit(value);
}

// ------------------------------------------------------------------ output

/**
 * Markdown-ish step text for a terminal: **bold** and `code` marks dropped.
 * @param {string} s
 */
function plain(s) {
  return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
}

/**
 * Text from mcp.tc for one terminal line, indentation kept: a carriage return (which could print one command over
 * another) and every other control character are dropped.
 * @param {import('../lib/output.js').Output} out
 * @param {string} s
 */
function line(out, s) {
  return out.clean(String(s).replace(/[\r\n]/g, ''));
}

/**
 * @param {string[]} list
 * @param {import('../lib/output.js').Output} out
 */
function printSteps(list, out) {
  let n = 0;
  for (const s of list) {
    const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(s);
    if (fence) {
      for (const l of fence[1].split('\n')) out.print(`     ${line(out, l)}`);
      continue;
    }
    if (/^\S+$/.test(s)) {
      // a URL or value to paste, shown under the step before it
      out.print(`     ${line(out, s)}`);
      continue;
    }
    n++;
    out.print(out.paragraph(plain(String(s).replace(/\r/g, '')), { indent: 5 }).replace(/^ {5}/, `  ${String(n).padStart(2)}. `));
  }
}

/**
 * @param {string[]} list
 */
function listText(list) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list.join('');
}

/**
 * @param {any} r
 * @param {import('../lib/output.js').Output} out
 * @param {any} [ctx]
 */
export function render(r, out, ctx = {}) {
  const shown = (/** @type {string} */ f) => out.clean(displayPath(f, where(ctx)));
  const target = () => `${shown(r.file)}${r.linked_to ? ` (a link to ${shown(r.linked_to)})` : ''}`;
  if (r.action === 'steps') {
    out.print(out.style.bold(`${out.clean(r.client_label)}: ${out.clean(r.name)}`));
    for (const wtext of r.warnings || []) out.warn(out.clean(wtext));
    printSteps(r.steps || [], out);
    if (r.note) out.print(out.paragraph(`Note: ${plain(r.note)}`, { indent: 2 }));
    if (r.client === 'claude-ai' || r.client === 'chatgpt') out.print(out.style.dim('  There is nothing to install on this computer for this client.'));
    return;
  }
  const holders = (r.placeholders || []).map((/** @type {string} */ t) => out.clean(t, { oneLine: true }));
  if (r.action === 'would_run') {
    out.print(`Dry run: nothing was run.${holders.length ? ` It needs ${listText(holders)}: add asks for ${holders.length > 1 ? 'them' : 'it'} when you run it in a terminal without --yes, and runs nothing without ${holders.length > 1 ? 'them' : 'it'}.` : ''}`);
    return;
  }
  if (r.action === 'would_write') {
    const kept = (r.kept || []).map((/** @type {string} */ t) => out.clean(t, { oneLine: true }));
    const asked = holders.filter((/** @type {string} */ t) => !kept.includes(t));
    const parts = [];
    if (asked.length) parts.push(`add asks for ${listText(asked)} when you run it in a terminal without --yes (otherwise ${asked.length > 1 ? 'they stay' : 'it stays'} in the file for you to replace)`);
    if (kept.length) parts.push(`${listText(kept)} ${kept.length > 1 ? 'stay placeholders' : 'stays a placeholder'} (see the warning above)`);
    out.print(`Dry run: nothing was written.${parts.length ? ` It has ${holders.length > 1 ? 'placeholders' : 'a placeholder'}: ${parts.join('; ')}.` : ''}`);
    return;
  }
  if (r.action === 'unchanged') {
    out.print(`${shown(r.file)} already has "${out.clean(r.entry)}" with these settings. Nothing to change.`);
    if (holders.length) out.print(`Replace ${listText(holders)} in that file with your own value${holders.length > 1 ? 's' : ''} before you use it.`);
    return;
  }
  if (r.action === 'written') {
    if (holders.length) {
      out.print(`${r.replaced ? 'Replaced' : 'Wrote'} "${out.clean(r.entry)}" in ${target()}, with ${holders.length > 1 ? 'placeholders' : 'a placeholder'} still in it.`);
      out.print(`Replace ${listText(holders)} in that file with your own value${holders.length > 1 ? 's' : ''} before you use it.`);
    } else {
      out.print(r.replaced ? `Replaced "${out.clean(r.entry)}" in ${target()}.` : `Added "${out.clean(r.entry)}" to ${target()}.`);
    }
    if (r.backup) out.print(out.style.dim(`Backup: ${shown(r.backup)}`));
  } else if (r.action === 'ran') {
    out.print(`Done: ${out.clean(r.client_label)} has ${out.clean(r.name)}.`);
  }
  if (r.next_steps && r.next_steps.length) {
    out.print('');
    out.print('Next:');
    printSteps(r.next_steps, out);
  }
  if (r.note) out.print(out.paragraph(`Note: ${plain(r.note)}`));
  if (r.action === 'ran' && !r.global && (r.client === 'claude-code' || r.client === 'gemini') && /--scope user|-s user/.test(r.note || '')) {
    out.print(out.style.dim(`With mcp-tc: mcp-tc add ${out.clean(r.slug)} --client ${r.client} --global`));
  }
}
