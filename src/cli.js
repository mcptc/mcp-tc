// Dispatcher: global flags, command discovery, help, version, the JSON envelope and exit codes.
//
// Commands are files in src/commands/<name>.js that export
//   meta   {name, summary, usage, description?, options?, args?, examples?}   (see lib/args.js)
//   run    async (ctx) => result object
//   render optional (result, out, ctx) => void, for people (without it the result prints as JSON)
// ctx = {command, args, positionals, json, out, base, env, stdin, stdout, stderr, cwd, now, platform, spawn,
//        version, setExitCode(code)}. A command throws CliError for failures; for an outcome that is not a failure
// but needs another exit code (dns-check found nothing, check found problems, submit is waiting), it calls
// ctx.setExitCode(code) and returns its result as usual: the JSON envelope then still says "ok": true.
//
// --json prints exactly one document on stdout:
//   {"ok": true, "command": "<name>", ...result}
//   {"ok": false, "command": "<name>", "error": {"code": "<snake_case>", "message": "<sentence>", ...details}}
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { GLOBAL_OPTIONS, exitCodes, formatHelp, parse, suggest } from './lib/args.js';
import { baseUrl } from './lib/directory.js';
import { CliError, EXIT, UsageError, errorObject, exitCodeOf } from './lib/errors.js';
import { clean, createOutput } from './lib/output.js';
import { REPO_URL, VERSION } from './version.js';

const COMMANDS_DIR = new URL('./commands/', import.meta.url);
const NAME_RE = /^[a-z][a-z0-9-]*$/;
/** Order of the command list in `mcp-tc help`; commands not named here follow alphabetically. */
const ORDER = ['search', 'info', 'categories', 'open', 'add', 'scan', 'badge', 'dns-check', 'submit', 'doctor', 'check', 'create', 'card'];

/**
 * @typedef {object} IO
 * @property {NodeJS.WritableStream & {isTTY?: boolean, columns?: number}} [stdout]
 * @property {NodeJS.WritableStream} [stderr]
 * @property {NodeJS.ReadableStream & {isTTY?: boolean}} [stdin]
 * @property {Record<string, string|undefined>} [env]
 * @property {string} [cwd]
 * @property {NodeJS.Platform} [platform]
 * @property {typeof nodeSpawn} [spawn]
 * @property {() => Date} [now]
 */

/** Names of the available commands (file names in src/commands). */
export function commandNames() {
  let files = [];
  try {
    files = readdirSync(COMMANDS_DIR);
  } catch {
    return [];
  }
  const names = files.filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).filter((n) => NAME_RE.test(n));
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** @param {string} n */
function rank(n) {
  const i = ORDER.indexOf(n);
  return i === -1 ? ORDER.length : i;
}

/**
 * Load one command module.
 * @param {string} name
 */
export async function loadCommand(name) {
  if (!NAME_RE.test(name) || !commandNames().includes(name)) return null;
  const mod = await import(new URL(`${name}.js`, COMMANDS_DIR).href);
  if (!mod.meta || typeof mod.run !== 'function') {
    throw new CliError('broken_command', `The command "${name}" is not built correctly (missing meta or run).`, EXIT.ERROR);
  }
  return mod;
}

/**
 * Run the CLI. Returns the exit code; never calls process.exit, so output is flushed.
 * @param {string[]} argv arguments after the program name
 * @param {IO} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;

  // Global flags before the command
  const globals = { json: false, noColor: false, help: false, version: false };
  let i = 0;
  /** @type {string|null} */
  let badGlobal = null;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') globals.json = true;
    else if (a === '--no-color') globals.noColor = true;
    else if (a === '--help' || a === '-h') globals.help = true;
    else if (a === '--version' || a === '-v') globals.version = true;
    else if (a.startsWith('-')) {
      badGlobal = a;
      break;
    } else break;
  }
  // --json and --no-color after the command count too (not after "--", where everything is an argument);
  // this also makes the error for an unknown command JSON
  const flags = argv.indexOf('--') === -1 ? argv : argv.slice(0, argv.indexOf('--'));
  if (flags.includes('--json')) globals.json = true;
  if (flags.includes('--no-color')) globals.noColor = true;
  const out = createOutput({ stdout, stderr, env, json: globals.json, noColor: globals.noColor });
  const debug = env.MCPTC_DEBUG === '1';
  let commandName = badGlobal ? null : argv[i] ?? null;

  /** @param {unknown} err @param {string|null} cmd */
  const fail = (err, cmd) => {
    if (debug && err instanceof Error && err.stack) stderr.write(`${err.stack}\n`);
    if (globals.json) {
      out.writeJson({ ok: false, command: cmd, error: errorObject(err) });
    } else {
      const e = errorObject(err);
      // messages can quote text from mcp.tc or a server: no escape sequences reach the terminal
      stderr.write(`${out.errStyle.red('Error:')} ${clean(e.message)}\n`);
    }
    return exitCodeOf(err);
  };

  try {
    if (badGlobal) {
      const close = suggest(badGlobal.replace(/^-+/, ''), Object.keys(GLOBAL_OPTIONS));
      throw new UsageError(
        `Unknown option ${badGlobal} before the command.${close ? ` Did you mean --${close}?` : ''} Command options go after the command, as in: mcp-tc search github --limit 5`,
        { option: badGlobal },
      );
    }
    if (commandName === null) {
      if (globals.version && !globals.help) return printVersion(out, globals.json);
      await printGeneralHelp(out, globals.json);
      return EXIT.OK;
    }
    if (commandName === 'help') {
      const target = argv.slice(i + 1).find((a) => !a.startsWith('-'));
      if (!target) {
        await printGeneralHelp(out, globals.json);
        return EXIT.OK;
      }
      const mod = await loadCommand(target);
      if (!mod) throw unknownCommand(target);
      printCommandHelp(out, mod.meta, globals.json);
      return EXIT.OK;
    }
    if (commandName === 'version') return printVersion(out, globals.json);

    const mod = await loadCommand(commandName);
    if (!mod) throw unknownCommand(commandName);
    const meta = mod.meta;
    commandName = meta.name || commandName;

    if (globals.help) {
      printCommandHelp(out, meta, globals.json);
      return EXIT.OK;
    }
    const rest = argv.slice(i + 1);
    // --help anywhere before "--" wins over other errors in the arguments
    const end = rest.indexOf('--') === -1 ? rest.length : rest.indexOf('--');
    if (rest.slice(0, end).some((a) => a === '--help' || a === '-h')) {
      printCommandHelp(out, meta, globals.json);
      return EXIT.OK;
    }
    const { values, positionals } = parse(rest, meta);
    if (values.version) return printVersion(out, globals.json);

    let exitCode = EXIT.OK;
    const ctx = {
      command: commandName,
      args: values,
      positionals,
      json: globals.json,
      out,
      get base() {
        return baseUrl(env);
      },
      env,
      // a getter: touching process.stdin creates a handle, so only commands that ask get one
      get stdin() {
        return io.stdin || process.stdin;
      },
      stdout,
      stderr,
      cwd: io.cwd || process.cwd(),
      now: io.now || (() => new Date()),
      platform: io.platform || process.platform,
      spawn: io.spawn || nodeSpawn,
      version: VERSION,
      /** @param {number} code */
      setExitCode(code) {
        exitCode = code;
      },
    };
    const result = (await mod.run(ctx)) ?? {};
    if (globals.json) {
      out.writeJson(Object.assign({ ok: true, command: commandName }, result, { ok: true, command: commandName }));
    } else if (typeof mod.render === 'function') {
      await mod.render(result, out, ctx);
    } else {
      out.print(JSON.stringify(result, null, 2));
    }
    return exitCode;
  } catch (err) {
    return fail(err, commandName);
  }
}

/** @param {string} name */
function unknownCommand(name) {
  const close = suggest(name, commandNames());
  return new UsageError(`Unknown command "${name}".${close ? ` Did you mean "${close}"?` : ''} Run "mcp-tc help" for the list.`, { suggestion: close }, 'unknown_command');
}

/**
 * @param {ReturnType<typeof createOutput>} out
 * @param {boolean} json
 */
function printVersion(out, json) {
  if (json) out.writeJson({ ok: true, command: 'version', version: VERSION });
  else out.print(VERSION);
  return EXIT.OK;
}

/**
 * @param {ReturnType<typeof createOutput>} out
 * @param {boolean} json
 */
async function printGeneralHelp(out, json) {
  /** @type {{name: string, summary: string, usage: string}[]} */
  const list = [];
  for (const name of commandNames()) {
    try {
      const mod = await loadCommand(name);
      if (mod) list.push({ name, summary: mod.meta.summary || '', usage: `mcp-tc ${mod.meta.usage || name}` });
    } catch {
      // a command that fails to load is left out of the list; running it shows the error
    }
  }
  if (json) {
    out.writeJson({ ok: true, command: 'help', version: VERSION, commands: list, global_options: optionList(GLOBAL_OPTIONS) });
    return;
  }
  const w = Math.max(...list.map((c) => c.name.length), 4) + 2;
  out.print(`mcp-tc ${VERSION}: work with mcp.tc, the directory of MCP servers, from the command line.`);
  out.print('');
  out.print('Usage: mcp-tc <command> [arguments] [options]');
  out.print('');
  out.print('Commands:');
  for (const c of list) out.print(`  ${c.name.padEnd(w)}${c.summary}`);
  out.print('');
  out.print('Global options:');
  const gl = Object.entries(GLOBAL_OPTIONS).map(([n, s]) => [`${s.short ? `-${s.short}, ` : '    '}--${n}`, s.description || '']);
  const gw = Math.max(...gl.map(([l]) => l.length)) + 2;
  for (const [l, d] of gl) out.print(`  ${l.padEnd(gw)}${d}`);
  out.print('');
  out.print('Run "mcp-tc help <command>" for a command\'s options and examples.');
  out.print(`Directory: https://mcp.tc  Source and issues: ${REPO_URL}`);
}

/**
 * @param {Record<string, import('./lib/args.js').OptionSpec>} specs
 */
function optionList(specs) {
  return Object.entries(specs).map(([name, s]) => ({
    name,
    short: s.short || null,
    type: s.type,
    value: s.type === 'string' ? s.valueName || 'value' : null,
    choices: s.choices || null,
    multiple: Boolean(s.multiple),
    description: s.description || '',
  }));
}

/**
 * @param {ReturnType<typeof createOutput>} out
 * @param {import('./lib/args.js').CommandMeta} meta
 * @param {boolean} json
 */
function printCommandHelp(out, meta, json) {
  if (json) {
    out.writeJson({
      ok: true,
      command: 'help',
      help: {
        name: meta.name,
        summary: meta.summary,
        usage: `mcp-tc ${meta.usage || meta.name}`,
        description: meta.description || null,
        arguments: (meta.args || []).map((a) => ({ name: a.name, required: Boolean(a.required), variadic: Boolean(a.variadic) })),
        options: optionList(meta.options || {}),
        global_options: optionList(GLOBAL_OPTIONS),
        examples: meta.examples || [],
        exit_codes: exitCodes(meta).map(([code, meaning]) => ({ code, meaning })),
      },
    });
    return;
  }
  out.print(formatHelp(meta));
}
