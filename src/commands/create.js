// mcp-tc create: start a new MCP server project from a template, on the MCP TypeScript SDK v2.
//
// Templates live in templates/: shared/ holds the files every project gets, express/, workers/ and stdio/ add or
// replace files for each kind. Text files are rendered with {{name}} placeholders and {{#flag}}...{{/flag}} or
// {{^flag}}...{{/flag}} sections (a tag alone on its line takes the line with it). package.json and src/icon.ts are
// written here, with the versions pinned in lib/versions.js.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliError, EXIT, UsageError } from '../lib/errors.js';
import { ask } from '../lib/prompt.js';
import { VERSIONS, WORKERS_COMPATIBILITY_DATE } from '../lib/versions.js';

const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));
export const KINDS = Object.freeze(['express', 'workers', 'stdio']);
export const AUTHS = Object.freeze(['none', 'bearer']);
const PORTS = Object.freeze({ express: 3000, workers: 8787 });
/** Files written as bytes, not rendered. */
const BINARY = /\.(png|jpe?g|webp|gif|ico)$/i;
/** Template files that only some projects get. */
const ONLY_FOR = Object.freeze({ 'src/auth.ts': (/** @type {Choice} */ c) => c.auth === 'bearer' });

/**
 * @typedef {object} Choice
 * @property {'express'|'workers'|'stdio'} template
 * @property {'none'|'bearer'} auth
 */

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'create',
  summary: 'Start a new MCP server project (TypeScript SDK v2)',
  usage: 'create <name> [--template express|workers|stdio] [--auth none|bearer] [--dir <path>] [--yes]',
  description:
    'Writes a ready-to-run MCP server into a new folder: a Streamable HTTP server on Express (express), a Cloudflare Workers handler (workers), or a local server that clients start as a program and that you can publish on npm (stdio). Each has one read-only example tool with annotations, a README with the steps to try it (curl tests for express and workers, the MCP Inspector for stdio) and to get listed on mcp.tc, and a placeholder icon. --auth bearer (express and workers) adds token checks with an audience check and the OAuth protected resource metadata (RFC 9728); you bring the identity provider. <name> is the npm package name; the folder is named after it unless you pass --dir. The folder must be new or empty. In a terminal, create asks for the template and sign-in you did not pass; --yes uses the defaults (express, none) instead. Nothing is installed: run npm install in the new folder.',
  args: [{ name: 'name', required: true }],
  options: {
    template: { type: 'string', valueName: 'kind', choices: [...KINDS], description: 'express (default), workers or stdio' },
    auth: { type: 'string', valueName: 'mode', choices: [...AUTHS], description: 'none (default) or bearer: require OAuth access tokens (express and workers)' },
    dir: { type: 'string', valueName: 'path', description: 'Folder to create the project in (default: ./<name without scope>)' },
    yes: { type: 'boolean', short: 'y', description: 'Do not ask: use the defaults for anything not given' },
  },
  examples: [
    'mcp-tc create weather-mcp',
    'mcp-tc create weather-mcp --template workers --auth bearer',
    'mcp-tc create @acme/notes-mcp --template stdio --dir notes',
    'mcp-tc create weather-mcp --yes --json',
  ],
  exits: [
    [0, 'the project was written'],
    [1, 'the project could not be written (nothing is left behind), or Ctrl+D at a question'],
    [2, 'usage error, including an invalid package name or a folder that is not empty'],
    [130, 'Ctrl+C at a question: nothing was written'],
  ],
};

/**
 * Problems with an npm package name for a new package, or an empty list when it is fine. Stricter than npm in one
 * way: each part must start with a lowercase letter or a digit, so the name also works as a folder and a command.
 * @param {string} name
 * @returns {string[]}
 */
export function packageNameProblems(name) {
  /** @type {string[]} */
  const problems = [];
  if (typeof name !== 'string' || name.length === 0) return ['The name is empty.'];
  if (name.trim() !== name) problems.push('The name has spaces at the start or end.');
  if (name.length > 214) problems.push('The name is longer than 214 characters.');
  if (name !== name.toLowerCase()) problems.push('The name must be lowercase.');
  const m = /^@([^/]+)\/([^/]+)$/.exec(name);
  if (name.startsWith('@') && !m) problems.push('A scoped name looks like @scope/name.');
  const parts = m ? [m[1], m[2]] : [name];
  for (const part of parts) {
    if (/^[._]/.test(part)) problems.push(`"${part}" starts with a dot or an underscore.`);
    else if (!/^[a-z0-9][a-z0-9._-]*$/i.test(part)) {
      problems.push(`"${part}" may only contain lowercase letters, digits, hyphens, dots and underscores, and must start with a letter or digit.`);
    }
  }
  const bare = m ? m[2] : name;
  if (!m && (builtinModules.includes(bare) || builtinModules.includes(`node:${bare}`))) problems.push(`"${bare}" is the name of a Node.js built-in module.`);
  if (['node_modules', 'favicon.ico'].includes(bare)) problems.push(`"${bare}" is not allowed as a package name.`);
  return [...new Set(problems)];
}

/**
 * Names derived from the package name.
 * @param {string} name a valid package name
 */
export function deriveNames(name) {
  const scoped = name.startsWith('@');
  const bare = scoped ? name.slice(name.indexOf('/') + 1) : name;
  const words = bare.split(/[-._]+/).filter(Boolean);
  const title = words.map((w) => (/^(mcp|api|ai|http|sdk|ui|id|url)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ') || bare;
  const workerName = bare.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63).replace(/-$/, '') || 'mcp-server';
  return { name, scoped, serverName: bare, binName: bare, dirName: bare, title, workerName };
}

/**
 * Render a template: {{var}} placeholders and {{#flag}} / {{^flag}} sections. Unknown names throw, so a typo in a
 * template fails the tests instead of shipping.
 * @param {string} text
 * @param {Record<string, string|number>} vars
 * @param {Record<string, boolean>} flags
 * @returns {string}
 */
export function renderTemplate(text, vars, flags) {
  // a section tag alone on its line takes the whole line with it
  const src = text.replace(/^[ \t]*(\{\{[#^/][A-Za-z]+\}\})[ \t]*\r?\n/gm, '$1');
  return renderPart(src, vars, flags);
}

/**
 * @param {string} src
 * @param {Record<string, string|number>} vars
 * @param {Record<string, boolean>} flags
 * @returns {string}
 */
function renderPart(src, vars, flags) {
  let out = '';
  let i = 0;
  const tag = /\{\{([#^/]?)([A-Za-z]+)\}\}/g;
  let m;
  while ((m = tag.exec(src))) {
    out += src.slice(i, m.index);
    const [whole, sigil, key] = m;
    if (sigil === '') {
      if (!(key in vars)) throw new Error(`Template placeholder {{${key}}} has no value.`);
      out += String(vars[key]);
      i = m.index + whole.length;
      continue;
    }
    if (sigil === '/') throw new Error(`Template section {{/${key}}} closes nothing.`);
    if (!(key in flags)) throw new Error(`Template section {{${sigil}${key}}} names an unknown flag.`);
    const close = `{{/${key}}}`;
    const start = m.index + whole.length;
    const end = findClose(src, key, start);
    if (end === -1) throw new Error(`Template section {{${sigil}${key}}} is not closed.`);
    const body = src.slice(start, end);
    if (Boolean(flags[key]) === (sigil === '#')) out += renderPart(body, vars, flags);
    i = end + close.length;
    tag.lastIndex = i;
  }
  return out + src.slice(i);
}

/**
 * Index of the {{/key}} that closes a section opened just before `from`, skipping nested sections of the same name.
 * @param {string} src
 * @param {string} key
 * @param {number} from
 */
function findClose(src, key, from) {
  const re = new RegExp(`\\{\\{([#^/])${key}\\}\\}`, 'g');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(src))) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return -1;
}

/**
 * The template files for a choice: shared/ first, then the kind's own files replacing those with the same path.
 * @param {Choice} choice
 * @returns {{source: string, target: string}[]} target is relative to the project, with forward slashes
 */
export function templateFiles(choice) {
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const root of ['shared', choice.template]) {
    const base = join(TEMPLATES, root);
    for (const rel of walk(base)) {
      const target = rel.split(sep).join('/').replace(/(^|\/)_gitignore$/, '$1.gitignore');
      files.set(target, join(base, rel));
    }
  }
  return [...files.entries()]
    .filter(([target]) => !ONLY_FOR[/** @type {keyof typeof ONLY_FOR} */ (target)] || ONLY_FOR[/** @type {keyof typeof ONLY_FOR} */ (target)](choice))
    .map(([target, source]) => ({ source, target }))
    .sort((a, b) => a.target.localeCompare(b.target));
}

/**
 * Relative paths of every file under a folder.
 * @param {string} base
 * @param {string} [sub]
 * @returns {string[]}
 */
function walk(base, sub = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(join(base, sub), { withFileTypes: true })) {
    const rel = sub ? join(sub, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...walk(base, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * package.json for the new project, with exact versions from lib/versions.js.
 * @param {Choice} choice
 * @param {ReturnType<typeof deriveNames>} names
 */
export function packageJson(choice, names) {
  /** @type {Record<string, string>} */
  const deps = {};
  /** @type {Record<string, string>} */
  const dev = {};
  const pin = (/** @type {Record<string, string>} */ to, /** @type {string} */ pkg) => {
    to[pkg] = VERSIONS[pkg];
  };
  pin(deps, '@modelcontextprotocol/server');
  pin(deps, 'zod');
  if (choice.template === 'express') {
    pin(deps, '@modelcontextprotocol/express');
    pin(deps, '@modelcontextprotocol/node');
    pin(deps, 'express');
  }
  if (choice.template === 'workers') {
    pin(dev, 'typescript');
    pin(dev, 'wrangler');
  } else {
    pin(dev, '@types/node');
    if (choice.template === 'express') pin(dev, '@types/express');
    pin(dev, 'tsx');
    pin(dev, 'typescript');
  }
  const sorted = (/** @type {Record<string, string>} */ o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  /** @type {Record<string, unknown>} */
  const pkg = { name: names.name, version: '0.1.0' };
  if (choice.template !== 'stdio') pkg.private = true;
  pkg.description =
    choice.template === 'stdio' ? 'A local MCP server, built with the MCP TypeScript SDK.' : 'A remote MCP server on Streamable HTTP, built with the MCP TypeScript SDK.';
  pkg.type = 'module';
  if (choice.template === 'stdio') {
    pkg.bin = { [names.binName]: 'dist/index.js' };
    pkg.files = ['dist'];
    pkg.keywords = ['mcp', 'mcp-server', 'model-context-protocol'];
  }
  pkg.engines = { node: choice.template === 'workers' ? '>=22' : '>=20' };
  if (choice.template === 'express') {
    pkg.scripts = { dev: 'tsx watch src/index.ts', build: 'tsc', start: 'node dist/index.js', typecheck: 'tsc --noEmit', icon: 'node scripts/icon.mjs' };
  } else if (choice.template === 'workers') {
    pkg.scripts = { dev: 'wrangler dev', deploy: 'wrangler deploy', typecheck: 'tsc', icon: 'node scripts/icon.mjs' };
  } else {
    pkg.scripts = {
      dev: 'tsx src/index.ts',
      build: 'tsc',
      start: 'node dist/index.js',
      typecheck: 'tsc --noEmit',
      icon: 'node scripts/icon.mjs',
      prepublishOnly: 'npm run build',
    };
  }
  pkg.dependencies = sorted(deps);
  pkg.devDependencies = sorted(dev);
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Every file of a new project, rendered, as {path: contents}. Pure apart from reading the templates.
 * @param {string} name a valid package name
 * @param {Choice} choice
 * @returns {Promise<Map<string, string|Buffer>>}
 */
export async function buildProject(name, choice) {
  const names = deriveNames(name);
  const remote = choice.template !== 'stdio';
  const port = remote ? PORTS[/** @type {'express'|'workers'} */ (choice.template)] : 0;
  const vars = {
    name: names.name,
    serverName: names.serverName,
    binName: names.binName,
    dirName: names.dirName,
    title: names.title,
    workerName: names.workerName,
    port,
    localUrl: remote ? `http://127.0.0.1:${port}/mcp` : '',
    compatibilityDate: WORKERS_COMPATIBILITY_DATE,
    sdkVersion: VERSIONS['@modelcontextprotocol/server'],
  };
  const flags = {
    express: choice.template === 'express',
    workers: choice.template === 'workers',
    stdio: choice.template === 'stdio',
    remote,
    bearer: choice.auth === 'bearer',
    scoped: names.scoped,
  };
  /** @type {Map<string, string|Buffer>} */
  const files = new Map();
  for (const { source, target } of templateFiles(choice)) {
    files.set(target, BINARY.test(target) ? readFileSync(source) : renderTemplate(readFileSync(source, 'utf8'), vars, flags));
  }
  files.set('package.json', packageJson(choice, names));
  const { iconModule } = await import(pathToFileURL(join(TEMPLATES, 'shared', 'scripts', 'icon.mjs')).href);
  files.set('src/icon.ts', iconModule(/** @type {Buffer} */ (files.get('assets/icon.png'))));
  return new Map([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Ask for one of a few values in a terminal; an empty answer takes the default.
 * @param {string} question
 * @param {readonly string[]} values
 * @param {string} fallback
 * @param {any} ctx
 */
async function choose(question, values, fallback, ctx) {
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await ask(`${question} (${values.join(', ')}) [${fallback}]:`, { stdin: ctx.stdin, stderr: ctx.stderr })).toLowerCase();
    if (!answer) return fallback;
    if (values.includes(answer)) return answer;
    ctx.stderr.write(`Please answer one of: ${values.join(', ')}.\n`);
  }
  throw new UsageError(`No valid answer. Pass it as an option instead, for example --template ${fallback}.`);
}

/**
 * Remove the files this run wrote into a folder that existed before, then the subfolders it made, if empty.
 * @param {string} dir
 * @param {string[]} written relative paths
 */
export function removeWritten(dir, written) {
  for (const rel of written) rmSync(join(dir, ...rel.split('/')), { force: true });
  const subdirs = [...new Set(written.flatMap((rel) => rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))];
  for (const sub of subdirs.sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(join(dir, ...sub.split('/')));
    } catch {
      // not empty or already gone
    }
  }
}

/**
 * @param {string} dir absolute
 * @returns {'missing'|'empty'|'not_empty'|'not_dir'}
 */
function dirState(dir) {
  if (!existsSync(dir)) return 'missing';
  if (!statSync(dir).isDirectory()) return 'not_dir';
  return readdirSync(dir).length === 0 ? 'empty' : 'not_empty';
}

/** Makes a random development token; node is there on every system, openssl not always. */
const TOKEN_COMMAND = `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`;

/**
 * The commands to run next, for a POSIX shell (macOS, Linux, Git Bash, WSL) or for PowerShell on Windows.
 * @param {Choice} choice
 * @param {string} rel the project folder, relative to where create ran ('.' for here)
 * @param {'posix'|'powershell'} shell
 * @returns {string[]}
 */
export function nextSteps(choice, rel, shell) {
  const steps = [];
  if (rel !== '.') {
    if (shell === 'powershell') steps.push(`cd ${/^[\w./@+\\:-]+$/.test(rel) ? rel : `'${rel.replace(/'/g, "''")}'`}`);
    else steps.push(`cd ${/^[\w./@+-]+$/.test(rel) ? rel : `'${rel.replace(/'/g, "'\\''")}'`}`);
  }
  steps.push('npm install');
  if (choice.auth === 'bearer') {
    if (shell === 'powershell') {
      steps.push(`$env:DEV_ACCESS_TOKEN = ${TOKEN_COMMAND}`);
      if (choice.template === 'workers') steps.push('"DEV_MODE=1", "DEV_ACCESS_TOKEN=$env:DEV_ACCESS_TOKEN" | Out-File -Encoding ascii .dev.vars');
    } else {
      steps.push(`export DEV_ACCESS_TOKEN=$(${TOKEN_COMMAND})`);
      if (choice.template === 'workers') steps.push(`printf 'DEV_MODE=1\\nDEV_ACCESS_TOKEN=%s\\n' "$DEV_ACCESS_TOKEN" > .dev.vars`);
    }
  }
  if (choice.template === 'stdio') steps.push('npm run build', 'npx @modelcontextprotocol/inspector node dist/index.js');
  else steps.push('npm run dev');
  return steps;
}

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const name = String(ctx.positionals[0] ?? '');
  const problems = packageNameProblems(name);
  if (problems.length) {
    throw new UsageError(`"${name}" can't be used as an npm package name: ${problems.join(' ')}`, { problems }, 'invalid_name');
  }

  // everything that can fail without an answer is checked before any question, so no answer is wasted
  const names = deriveNames(name);
  const shown = ctx.args.dir ?? names.dirName;
  const dir = resolve(ctx.cwd, shown);
  const state = dirState(dir);
  if (state === 'not_dir') throw new UsageError(`${dir} exists and is not a folder.`, { directory: dir }, 'not_a_directory');
  if (state === 'not_empty') {
    throw new UsageError(`The folder ${dir} is not empty. Pick a new folder with --dir, or empty this one first.`, { directory: dir }, 'directory_not_empty');
  }
  const noBearer = () =>
    new UsageError(
      '--auth bearer works with --template express or workers. A stdio server runs on the user\'s computer and gets no HTTP requests, so there is no token to check.',
      {},
      'auth_not_supported',
    );
  if (ctx.args.template === 'stdio' && ctx.args.auth === 'bearer') throw noBearer();

  // ask only for what is missing, only in a terminal, and never with --yes or --json (stdin is touched only then)
  const interactive = () => !ctx.args.yes && !ctx.json && Boolean(ctx.stdin && ctx.stdin.isTTY);
  const template = ctx.args.template ?? (interactive() ? await choose('Template', KINDS, 'express', ctx) : 'express');
  let auth = ctx.args.auth;
  if (template === 'stdio' && auth === 'bearer') throw noBearer();
  if (auth === undefined) auth = template !== 'stdio' && interactive() ? await choose('Sign-in', AUTHS, 'none', ctx) : 'none';
  /** @type {Choice} */
  const choice = { template, auth };

  const files = await buildProject(name, choice);
  /** @type {string[]} */
  const written = [];
  /** @type {string|undefined} the first folder this run created, if it created any */
  let made;
  try {
    made = mkdirSync(dir, { recursive: true });
    for (const [rel, content] of files) {
      const path = join(dir, ...rel.split('/'));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { flag: 'wx' });
      written.push(rel);
    }
  } catch (err) {
    // leave nothing half-made: remove what this run wrote (and the folder, if this run created it)
    try {
      if (made) rmSync(made, { recursive: true, force: true });
      else removeWritten(dir, written);
    } catch {
      // nothing was created there, or it is already gone
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError('write_failed', `Could not write the project into ${dir}: ${reason}`, EXIT.ERROR, { directory: dir });
  }

  const localUrl = template === 'stdio' ? null : `http://127.0.0.1:${PORTS[/** @type {'express'|'workers'} */ (template)]}/mcp`;
  const shell = ctx.platform === 'win32' ? 'powershell' : 'posix';
  const steps = nextSteps(choice, relative(ctx.cwd, dir) || '.', shell);
  /** @type {Record<string, string>} */
  const sdk = {};
  for (const pkg of Object.keys(VERSIONS)) if (pkg.startsWith('@modelcontextprotocol/') && String(files.get('package.json')).includes(`"${pkg}"`)) sdk[pkg] = VERSIONS[pkg];
  return {
    name,
    template,
    auth,
    directory: dir,
    files: [...files.keys()],
    sdk,
    local_url: localUrl,
    next_steps: steps,
    shell,
    check_command: localUrl ? `npx mcp-tc check ${localUrl}` : 'npx mcp-tc check . --stdio',
    readme: join(dir, 'README.md'),
  };
}

const KIND_TEXT = Object.freeze({
  express: 'Streamable HTTP on Express',
  workers: 'Streamable HTTP on Cloudflare Workers',
  stdio: 'local server on stdio, publishable on npm',
});

/**
 * @param {any} r
 * @param {import('../lib/output.js').Output} out
 * @param {any} [ctx]
 */
export function render(r, out, ctx) {
  const rel = ctx && ctx.cwd ? relative(ctx.cwd, r.directory) : '';
  const where = rel && !rel.startsWith('..') ? `./${rel}` : r.directory;
  out.print(`Created ${out.style.bold(out.clean(r.name))} in ${out.clean(where)}`);
  out.print(
    out.fields([
      ['Template', `${r.template} (${KIND_TEXT[/** @type {keyof typeof KIND_TEXT} */ (r.template)]})`],
      ['Sign-in', r.auth === 'bearer' ? 'bearer tokens (fill in src/auth.ts before going live)' : 'none'],
      ['SDK', Object.entries(r.sdk).map(([k, v]) => `${k} ${v}`).join(', ')],
    ], { indent: 2 }),
  );
  out.print('');
  out.print('Files:');
  for (const f of r.files) out.print(`  ${f}`);
  out.print('');
  out.print(r.shell === 'powershell' ? 'Next steps (PowerShell):' : 'Next steps:');
  for (const s of r.next_steps) out.print(`  ${s}`);
  out.print('');
  if (r.local_url) {
    out.print(`The server then answers on ${r.local_url}. In another terminal, check it the way mcp.tc reads servers:`);
  } else {
    out.print('The Inspector starts the server and lets you call its tools. When you close it, check the server the way mcp.tc reads servers (this starts dist/index.js over stdio):');
  }
  out.print(`  ${r.check_command}`);
  out.print('');
  out.print(
    r.template === 'stdio'
      ? 'README.md has the Inspector steps, client setup, publishing to npm, and the steps to get listed on mcp.tc.'
      : 'README.md has curl tests, settings, and the steps to get listed on mcp.tc.',
  );
}
