// Argument parsing on top of node:util parseArgs, with per-command option specs and clear usage errors.
//
// A command's meta.options maps each long option name to a spec:
//   { type: 'string' | 'boolean', short?: 'x', multiple?: true, valueName?: 'slug', description: '...',
//     choices?: ['a', 'b'], int?: { min?: number, max?: number }, default?: string | boolean }
// meta.args lists positionals: [{ name: 'query', required?: true, variadic?: true }].
import { parseArgs } from 'node:util';
import { UsageError } from './errors.js';
import { wrap } from './output.js';

/** Help text is wrapped to this many columns. */
const HELP_WIDTH = 88;

/** Options every command accepts. cli.js acts on them. */
export const GLOBAL_OPTIONS = Object.freeze({
  json: { type: 'boolean', description: 'Print one JSON document on stdout (for scripts and agents)' },
  'no-color': { type: 'boolean', description: 'No colors (also off when NO_COLOR is set or output is not a terminal)' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
  version: { type: 'boolean', short: 'v', description: 'Print the version' },
});

/**
 * @typedef {object} OptionSpec
 * @property {'string'|'boolean'} type
 * @property {string} [short]
 * @property {boolean} [multiple]
 * @property {string} [valueName]
 * @property {string} [description]
 * @property {string[]} [choices]
 * @property {{min?: number, max?: number}} [int]
 * @property {string|boolean} [default]
 */

/**
 * @typedef {object} ArgSpec
 * @property {string} name
 * @property {boolean} [required]
 * @property {boolean} [variadic]
 */

/**
 * @typedef {object} CommandMeta
 * @property {string} name
 * @property {string} summary one line for the command list
 * @property {string} [usage] e.g. "search <query> [options]" (without "mcp-tc ")
 * @property {string} [description] longer help text, plain sentences
 * @property {Record<string, OptionSpec>} [options]
 * @property {ArgSpec[]} [args]
 * @property {string[]} [examples] full command lines
 * @property {[number, string][]} [exits] exit codes this command uses and what each means; formatHelp() adds the
 *   ones every command shares (1 error, 2 usage) when they are missing
 */

/** Exit codes every command can return. */
export const COMMON_EXITS = Object.freeze([
  /** @type {[number, string]} */ ([1, 'error: network, a server error, anything unexpected']),
  /** @type {[number, string]} */ ([2, 'usage error: bad options or arguments, or a question with no terminal to ask in']),
]);

/**
 * The exit codes for a command's help: its own, plus the shared ones it doesn't describe itself, in order.
 * @param {CommandMeta} meta
 * @returns {[number, string][]}
 */
export function exitCodes(meta) {
  const own = meta.exits || [];
  const all = [...own, ...COMMON_EXITS.filter(([c]) => !own.some(([o]) => o === c))];
  return all.sort((a, b) => a[0] - b[0]);
}

/**
 * Edit distance, for "did you mean" suggestions.
 * @param {string} a
 * @param {string} b
 */
export function distance(a, b) {
  const m = a.length;
  const n = b.length;
  /** @type {number[]} */
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * The closest candidate, or null when none is close enough.
 * @param {string} input
 * @param {Iterable<string>} candidates
 */
export function suggest(input, candidates) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    // a prefix of at least two letters ("sea" for "search") counts as a match
    const d = input.length >= 2 && c.startsWith(input) ? 0 : distance(input, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(input.length / 3)) ? best : null;
}

/**
 * Parse argv for one command. Throws UsageError for anything it can't accept.
 * @param {string[]} argv the arguments after the command name
 * @param {CommandMeta} meta
 * @returns {{values: Record<string, any>, positionals: string[]}}
 */
export function parse(argv, meta) {
  const specs = { ...GLOBAL_OPTIONS, ...(meta.options || {}) };
  /** @type {Record<string, {type: 'string'|'boolean', short?: string, multiple?: boolean, default?: any}>} */
  const config = {};
  for (const [name, s] of Object.entries(specs)) {
    config[name] = { type: s.type };
    if (s.short) config[name].short = s.short;
    if (s.multiple) config[name].multiple = true;
    if (s.default !== undefined) config[name].default = s.default;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: config, strict: true, allowPositionals: true });
  } catch (err) {
    throw toUsageError(err, specs, meta);
  }
  /** @type {Record<string, any>} */
  const values = { ...parsed.values };
  for (const [name, s] of Object.entries(specs)) {
    const v = values[name];
    if (v === undefined || s.type !== 'string') continue;
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      if (s.choices && !s.choices.includes(item)) {
        throw new UsageError(`--${name} must be one of: ${s.choices.join(', ')}.`, { option: name });
      }
    }
    if (s.int) {
      const conv = list.map((item) => toInt(name, item, s.int || {}));
      values[name] = Array.isArray(v) ? conv : conv[0];
    }
  }
  checkPositionals(parsed.positionals, meta);
  return { values, positionals: parsed.positionals };
}

/**
 * @param {string} name
 * @param {string} raw
 * @param {{min?: number, max?: number}} range
 */
function toInt(name, raw, range) {
  if (!/^\s*\d+\s*$/.test(raw)) {
    throw new UsageError(`--${name} must be a whole number${rangeText(range)}.`, { option: name });
  }
  const n = Number(raw);
  if ((range.min !== undefined && n < range.min) || (range.max !== undefined && n > range.max)) {
    throw new UsageError(`--${name} must be a whole number${rangeText(range)}.`, { option: name });
  }
  return n;
}

/** @param {{min?: number, max?: number}} r */
function rangeText(r) {
  if (r.min !== undefined && r.max !== undefined) return ` from ${r.min} to ${r.max}`;
  if (r.min !== undefined) return ` of at least ${r.min}`;
  if (r.max !== undefined) return ` up to ${r.max}`;
  return '';
}

/**
 * @param {string[]} positionals
 * @param {CommandMeta} meta
 */
function checkPositionals(positionals, meta) {
  const specs = meta.args || [];
  const variadic = specs.length > 0 && specs[specs.length - 1].variadic;
  const required = specs.filter((a) => a.required).length;
  const usage = `Usage: mcp-tc ${meta.usage || meta.name}`;
  if (positionals.length < required) {
    const missing = specs.filter((a) => a.required)[positionals.length];
    throw new UsageError(`Missing <${missing.name}>. ${usage}`, { argument: missing.name });
  }
  if (!variadic && positionals.length > specs.length) {
    const extra = positionals[specs.length];
    throw new UsageError(
      specs.length === 0
        ? `"mcp-tc ${meta.name}" takes no arguments, but got "${extra}". ${usage}`
        : `Too many arguments: "${extra}" was not expected. ${usage}`,
      { argument: extra },
    );
  }
}

/**
 * Turn a parseArgs error into a UsageError with our wording.
 * @param {any} err
 * @param {Record<string, OptionSpec>} specs
 * @param {CommandMeta} meta
 */
function toUsageError(err, specs, meta) {
  const msg = String(err && err.message ? err.message : err);
  // "Option '-y, --yes' does not take an argument", "Option '--n <value>' argument missing", "Unknown option '--zz'"
  const quoted = /'(?:-[^-\s',], )?(-{1,2}[^' ]+)/.exec(msg);
  const flag = quoted ? quoted[1] : '';
  const help = ` See: mcp-tc ${meta.name} --help`;
  if (err && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const bare = flag.replace(/^-+/, '').split('=')[0];
    const names = Object.keys(specs);
    const close = flag.startsWith('--') ? suggest(bare, names) : null;
    return new UsageError(`Unknown option ${flag || 'given'}.${close ? ` Did you mean --${close}?` : ''}${help}`, { option: flag });
  }
  if (err && err.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const name = flag.replace(/^-+/, '').replace(/ .*$/, '');
    // "--name" is a long option, "-n" a short one
    const entry = Object.entries(specs).find(([n, s]) => (flag.startsWith('--') ? n === name : s.short === name));
    const spec = entry ? entry[1] : undefined;
    if (spec && spec.type === 'boolean') {
      return new UsageError(`${flag} does not take a value.${help}`, { option: flag });
    }
    // parseArgs won't take "--note -x" (it can't tell a value from an option), but it takes "--note=-x"
    if (/ambiguous/i.test(msg)) {
      const long = `--${entry ? entry[0] : name}`;
      return new UsageError(`A value that starts with "-" needs an equals sign: ${long}="-...", as one argument.${help}`, { option: long }, 'ambiguous_value');
    }
    const vn = spec && spec.valueName ? spec.valueName : 'value';
    return new UsageError(`${flag.replace(/ .*$/, '')} needs a value: ${flag.replace(/ .*$/, '')} <${vn}>.${help}`, { option: flag });
  }
  return new UsageError(`${msg.replace(/\.?$/, '.')}${help}`);
}

/**
 * Plain-text help for one command.
 * @param {CommandMeta} meta
 * @param {string} [bin]
 */
export function formatHelp(meta, bin = 'mcp-tc') {
  const lines = [`Usage: ${bin} ${meta.usage || meta.name}`, '', meta.summary];
  if (meta.description) lines.push('', ...wrap(meta.description, HELP_WIDTH));
  const own = Object.entries(meta.options || {});
  if (own.length) {
    lines.push('', 'Options:', ...optionLines(own));
  }
  lines.push('', 'Global options:', ...optionLines(Object.entries(GLOBAL_OPTIONS)));
  if (meta.examples && meta.examples.length) {
    lines.push('', 'Examples:', ...meta.examples.map((e) => `  ${e}`));
  }
  const codes = exitCodes(meta);
  const cw = Math.max(...codes.map(([c]) => String(c).length)) + 4;
  lines.push('', 'Exit codes:', ...codes.flatMap(([c, text]) => wrap(text, HELP_WIDTH - cw).map((l, i) => (i === 0 ? `  ${String(c).padEnd(cw - 2)}` : ' '.repeat(cw)) + l)));
  return lines.join('\n');
}

/** @param {[string, OptionSpec][]} entries */
function optionLines(entries) {
  const left = entries.map(([name, s]) => {
    const short = s.short ? `-${s.short}, ` : '    ';
    const value = s.type === 'string' ? ` <${s.valueName || 'value'}>` : '';
    return `  ${short}--${name}${value}`;
  });
  const w = Math.max(...left.map((l) => l.length)) + 2;
  return entries.flatMap(([, s], i) => {
    const desc = wrap(s.description || '', Math.max(30, HELP_WIDTH - w));
    return desc.map((d, j) => (j === 0 ? left[i].padEnd(w) : ' '.repeat(w)) + d);
  });
}
