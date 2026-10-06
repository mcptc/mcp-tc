import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startFakeDirectory, runCli } from './helpers/fake-directory.js';
import { WORDS_FILE, internalHits, internalWords, repoFiles } from './helpers/internal-words.js';
import { commandNames, loadCommand, main } from '../src/cli.js';
import { parse, formatHelp, suggest, distance, GLOBAL_OPTIONS } from '../src/lib/args.js';
import { CliError, EXIT, UsageError, errorObject } from '../src/lib/errors.js';
import { clean, createOutput, displayWidth, exitOnClosedPipe, truncate, wrap } from '../src/lib/output.js';
import { confirm, ask } from '../src/lib/prompt.js';
import { VERSION } from '../src/version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/mcp-tc.js', import.meta.url));

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(() => fake.close());

/** Run the real binary in a child process (async, so the fake server in this process keeps answering). */
function spawnCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, MCPTC_BASE_URL: fake.base, ...env }, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('package', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  it('has the agreed name, bins, files and engine', () => {
    assert.equal(pkg.name, 'mcp-tc');
    assert.equal(pkg.version, VERSION);
    assert.equal(pkg.type, 'module');
    assert.deepEqual(pkg.bin, { 'mcp-tc': 'bin/mcp-tc.js', mcptc: 'bin/mcp-tc.js' });
    assert.deepEqual(pkg.files, ['bin', 'src', 'templates', 'README.md', 'LICENSE']);
    assert.equal(pkg.engines.node, '>=20');
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  });
  it('the bin is executable and has a node shebang', () => {
    assert.ok(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n'));
    // the mode bit is set by npm on install; check that the file is at least readable
    assert.ok(statSync(BIN).isFile());
  });
});

describe('the binary', () => {
  it('--version prints the version', async () => {
    const r = await spawnCli(['--version']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), VERSION);
  });
  it('-v and the version command agree', async () => {
    assert.equal((await spawnCli(['-v'])).stdout.trim(), VERSION);
    assert.equal((await spawnCli(['version'])).stdout.trim(), VERSION);
  });
  it('runs a command against the fake directory and exits with its code', async () => {
    const r = await spawnCli(['info', 'zz-missing', '--json']);
    assert.equal(r.code, EXIT.NOT_FOUND);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, false);
    assert.equal(doc.error.code, 'not_found');
  });
  it('prints no stack trace unless MCPTC_DEBUG=1', async () => {
    const r = await spawnCli(['info', 'zz-missing']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /^Error: No listing/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    const d = await spawnCli(['info', 'zz-missing'], { MCPTC_DEBUG: '1' });
    assert.match(d.stderr, /\n\s+at /);
  });
  it('exits by itself after a request (no open handles)', async () => {
    const t0 = Date.now();
    const r = await spawnCli(['categories', '--json']);
    assert.equal(r.code, 0);
    assert.ok(Date.now() - t0 < 10_000);
  });
});

describe('output into a reader that went away (EPIPE)', () => {
  /** Run the binary with its stdout closed by the reader before it writes: every write fails with EPIPE. */
  function spawnClosed(args, cwd) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { PATH: process.env.PATH, MCPTC_BASE_URL: fake.base }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.destroy();
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }
  it('exitOnClosedPipe(): EPIPE exits with 0, other errors are thrown', () => {
    const stream = new EventEmitter();
    const codes = [];
    exitOnClosedPipe(/** @type {any} */ (stream), (c) => codes.push(c));
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.deepEqual(codes, [0]);
    assert.throws(() => stream.emit('error', Object.assign(new Error('disk on fire'), { code: 'EIO' })), /disk on fire/);
  });
  it('mcp-tc categories, help and create end quietly with code 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcptc-pipe-'));
    try {
      for (const args of [['categories'], ['help'], ['create', 'pipe-mcp', '--yes'], ['categories', '--json']]) {
        const r = await spawnClosed(args, dir);
        assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /EPIPE|Error|at /, args.join(' '));
      }
      assert.ok(existsSync(join(dir, 'pipe-mcp', 'package.json')), 'create still wrote the project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('mcp-tc create x --yes | head -3 in a shell', { skip: process.platform === 'win32' || !existsSync('/bin/bash') ? 'needs bash' : false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcptc-head-'));
    try {
      const r = await new Promise((resolve) => {
        execFile('/bin/bash', ['-c', '"$0" "$1" create head-mcp --yes | head -3; exit ${PIPESTATUS[0]}', process.execPath, BIN], { cwd: dir, env: { PATH: process.env.PATH }, timeout: 20_000 }, (err, stdout, stderr) =>
          resolve({ code: err ? err.code : 0, stdout, stderr }),
        );
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.split('\n').filter(Boolean).length, 3);
      assert.equal(r.stderr, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dispatcher', () => {
  it('finds the commands by file name', () => {
    const names = commandNames();
    for (const n of ['search', 'info', 'categories', 'open', 'badge', 'dns-check']) assert.ok(names.includes(n), n);
    assert.deepEqual(names.slice(0, 3), ['search', 'info', 'categories']);
  });

  it('every command module has meta, run, and a summary', async () => {
    for (const name of commandNames()) {
      const mod = await loadCommand(name);
      assert.equal(mod.meta.name, name, `${name}: meta.name matches the file`);
      assert.equal(typeof mod.run, 'function');
      assert.ok(mod.meta.summary && mod.meta.summary.length < 80, `${name}: summary`);
    }
  });

  it('prints help with no arguments', async () => {
    const r = await runCli([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: mcp-tc <command>/);
    for (const n of commandNames()) assert.match(r.stdout, new RegExp(`^  ${n} `, 'm'));
  });

  it('help output for every command, three ways', async () => {
    for (const name of commandNames()) {
      for (const argv of [['help', name], [name, '--help'], [name, '-h']]) {
        const r = await runCli(argv);
        assert.equal(r.code, 0, `${argv.join(' ')}`);
        assert.match(r.stdout, new RegExp(`^Usage: mcp-tc ${name}`), argv.join(' '));
        assert.match(r.stdout, /Global options:/);
        assert.equal(r.stderr, '');
      }
    }
  });

  it('--help wins over bad arguments', async () => {
    const r = await runCli(['search', '--limit', 'abc', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: mcp-tc search/);
  });

  it('help --json describes commands for agents', async () => {
    const all = (await runCli(['help', '--json'])).json();
    assert.equal(all.ok, true);
    assert.equal(all.command, 'help');
    assert.ok(all.commands.some((c) => c.name === 'search' && c.usage.startsWith('mcp-tc search')));
    const one = (await runCli(['search', '--help', '--json'])).json();
    assert.equal(one.help.name, 'search');
    assert.ok(one.help.options.some((o) => o.name === 'auth' && o.choices.includes('sign-in')));
  });

  it('unknown command: exit 2 with a suggestion', async () => {
    const r = await runCli(['serch', 'github']);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /Unknown command "serch"\. Did you mean "search"\?/);
    const j = await runCli(['serch', '--json']);
    assert.equal(j.code, 2);
    assert.deepEqual(j.json().error.code, 'unknown_command');
    assert.equal(j.json().error.suggestion, 'search');
  });

  it('unknown option: exit 2 with a suggestion', async () => {
    const r = await runCli(['search', 'x', '--limt', '3'], { base: fake.base });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Unknown option --limt\. Did you mean --limit\?/);
  });

  it('global flags work before and after the command', async () => {
    const a = await runCli(['--json', 'categories'], { base: fake.base });
    const b = await runCli(['categories', '--json'], { base: fake.base });
    assert.equal(a.code, 0);
    assert.deepEqual(a.json(), b.json());
  });

  it('refuses an unknown flag before the command', async () => {
    const r = await runCli(['--limit', '3', 'search']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Command options go after the command/);
  });

  it('a bad MCPTC_BASE_URL is a usage error', async () => {
    const r = await runCli(['categories', '--json'], { env: { MCPTC_BASE_URL: 'ftp://nope' } });
    assert.equal(r.code, 2);
    assert.equal(r.json().error.code, 'invalid_base_url');
  });
});

describe('JSON envelope', () => {
  it('success: ok, command, then the result; nothing else on stdout', async () => {
    const r = await runCli(['categories', '--json'], { base: fake.base });
    const doc = r.json();
    assert.deepEqual(Object.keys(doc).slice(0, 2), ['ok', 'command']);
    assert.equal(doc.ok, true);
    assert.equal(doc.command, 'categories');
    assert.ok(Array.isArray(doc.categories));
    assert.equal(r.stdout.trim().split('\n')[0], '{');
    assert.doesNotMatch(r.stdout, /\u001b\[/);
  });

  it('error: ok false, command, error.code and error.message', async () => {
    const r = await runCli(['info', 'zz-none', '--json'], { base: fake.base });
    const doc = r.json();
    assert.deepEqual(Object.keys(doc), ['ok', 'command', 'error']);
    assert.equal(doc.ok, false);
    assert.equal(doc.command, 'info');
    assert.equal(doc.error.code, 'not_found');
    assert.equal(typeof doc.error.message, 'string');
    assert.equal(r.stderr, '');
  });

  it('usage errors are JSON too', async () => {
    const r = await runCli(['search', '--limit', '99', '--json'], { base: fake.base });
    assert.equal(r.code, 2);
    assert.equal(r.json().error.code, 'usage');
  });

  it('rate limiting: JSON stays clean while retrying, and exit 4 after the retries', async () => {
    fake.reset();
    fake.rateLimit(1, '0');
    const ok = await runCli(['categories', '--json'], { base: fake.base });
    assert.equal(ok.code, 0);
    assert.equal(ok.stderr, '');
    fake.reset();
    fake.rateLimit(4, '0');
    const r = await runCli(['categories', '--json'], { base: fake.base });
    assert.equal(r.code, EXIT.RATE_LIMITED);
    assert.equal(r.json().error.code, 'rate_limited');
    assert.equal(fake.requests.length, 4);
    fake.reset();
  });

  it('rate limiting: people see the retry on stderr', async () => {
    fake.reset();
    fake.rateLimit(1, '0');
    const r = await runCli(['categories'], { base: fake.base });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /limiting requests \(HTTP 429\)\. Trying again in 1 s \(attempt 2 of 4\)/);
    fake.reset();
  });

  it('a Cloudflare block is a clear error, exit 1', async () => {
    fake.reset();
    fake.block(1, 'challenge');
    const r = await runCli(['categories', '--json'], { base: fake.base });
    assert.equal(r.code, 1);
    assert.equal(r.json().error.code, 'blocked');
    fake.reset();
  });

  it('a network error names the host, exit 1', async () => {
    const r = await runCli(['categories', '--json'], { env: { MCPTC_BASE_URL: 'http://127.0.0.1:1' } });
    assert.equal(r.code, 1);
    assert.equal(r.json().error.code, 'network_error');
    assert.equal(r.json().error.host, '127.0.0.1:1');
  });

  it('errorObject keeps details and never loses code and message', () => {
    assert.deepEqual(errorObject(new CliError('x_y', 'Msg.', 1, { host: 'h' })), { host: 'h', code: 'x_y', message: 'Msg.' });
    assert.deepEqual(errorObject(new CliError('a', 'B', 1, { code: 'evil', message: 'evil' })), { code: 'a', message: 'B' });
    assert.equal(errorObject(new Error('boom')).code, 'unexpected');
    assert.equal(new UsageError('u').exit, EXIT.USAGE);
  });

  it('exit codes are the documented ones', () => {
    assert.deepEqual({ ...EXIT }, { OK: 0, ERROR: 1, USAGE: 2, NOT_FOUND: 3, RATE_LIMITED: 4, UNREACHABLE: 5, PROBLEMS: 6, WAITING: 10, NOT_ACCEPTED: 11, WAIT_TIMEOUT: 12, INTERRUPTED: 130 });
  });
});

describe('args', () => {
  const meta = {
    name: 'demo',
    summary: 'Demo',
    usage: 'demo <thing> [options]',
    args: [{ name: 'thing', required: true }],
    options: {
      mode: { type: 'string', choices: ['a', 'b'], description: 'Mode' },
      n: { type: 'string', valueName: 'n', int: { min: 1, max: 5 }, description: 'Count' },
      yes: { type: 'boolean', short: 'y', description: 'Yes' },
      tag: { type: 'string', multiple: true, description: 'Tags' },
    },
  };
  it('parses options, ints, booleans and repeats', () => {
    const r = parse(['x', '--mode', 'a', '--n', '3', '-y', '--tag', 'p', '--tag', 'q', '--json'], meta);
    assert.deepEqual(r.positionals, ['x']);
    assert.equal(r.values.n, 3);
    assert.equal(r.values.yes, true);
    assert.deepEqual(r.values.tag, ['p', 'q']);
    assert.equal(r.values.json, true);
  });
  const bad = [
    [['--mode', 'c', 'x'], /--mode must be one of: a, b/],
    [['x', '--n', '0'], /--n must be a whole number from 1 to 5/],
    [['x', '--n', 'two'], /whole number/],
    [['x', '--n'], /--n needs a value: --n <n>/],
    [['x', '--yes=1'], /--yes does not take a value/],
    [[], /Missing <thing>/],
    [['x', 'y'], /Too many arguments: "y"/],
    [['x', '--nn', '1'], /Unknown option --nn\. Did you mean --n\?/],
  ];
  for (const [argv, re] of bad) {
    it(`refuses ${JSON.stringify(argv)}`, () => {
      assert.throws(() => parse(argv, meta), (e) => e instanceof UsageError && e.exit === 2 && re.test(e.message));
    });
  }
  it('takes positionals after --', () => {
    assert.deepEqual(parse(['--', '--weird'], meta).positionals, ['--weird']);
  });
  it('formats help with options, globals and examples', () => {
    const h = formatHelp({ ...meta, examples: ['mcp-tc demo x'] });
    assert.match(h, /^Usage: mcp-tc demo <thing> \[options\]/);
    assert.match(h, /--mode <value>\s+Mode/);
    assert.match(h, /-y, --yes/);
    for (const g of Object.keys(GLOBAL_OPTIONS)) assert.ok(h.includes(`--${g}`));
    assert.match(h, /Examples:\n {2}mcp-tc demo x/);
  });
  it('suggests close names only', () => {
    assert.equal(suggest('serch', ['search', 'info']), 'search');
    assert.equal(suggest('cat', ['categories', 'card']), 'categories');
    assert.equal(suggest('zzzzzz', ['search', 'info']), null);
    assert.equal(distance('kitten', 'sitting'), 3);
  });
});

describe('output', () => {
  it('clean() strips escape sequences, controls and bidi marks', () => {
    assert.equal(clean('a\u001b[31mb\u0007c\u202Ed\u200Be\uFEFF'), 'a[31mbcde');
    assert.equal(clean('line1\nline2\ttab'), 'line1\nline2\ttab');
    assert.equal(clean(' a \n b ', { oneLine: true }), 'a b');
    assert.equal(clean(null), '');
    assert.equal(clean('x\u{E0041}y'), 'xy');
  });
  it('measures and cuts by terminal columns', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('\u6F22\u5B57'), 4);
    assert.equal(displayWidth('\u001b[1mab\u001b[22m'), 2);
    assert.equal(truncate('abcdefgh', 5), 'abcd\u2026');
    assert.equal(truncate('abc', 5), 'abc');
    assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  });
  function capture(opts = {}) {
    let text = '';
    const stream = { isTTY: opts.tty || false, columns: opts.columns, write: (s) => ((text += s), true) };
    const out = createOutput({ stdout: stream, stderr: stream, env: opts.env || {}, json: opts.json, noColor: opts.noColor });
    return { out, get text() { return text; } };
  }
  it('colors only on a terminal without NO_COLOR or --no-color', () => {
    assert.equal(capture({ tty: true }).out.color, true);
    assert.equal(capture({ tty: false }).out.color, false);
    assert.equal(capture({ tty: true, env: { NO_COLOR: '' } }).out.color, false);
    assert.equal(capture({ tty: true, noColor: true }).out.color, false);
    assert.equal(capture({ tty: true, json: true }).out.color, false);
  });
  it('tables fit the width and clean their cells', () => {
    const c = capture({ tty: true, columns: 40, env: { NO_COLOR: '1' } });
    const t = c.out.table(
      [{ a: 'short', b: 'a long tagline that does not fit in forty columns at all' }, { a: 'evil\u001b[2J', b: 'x' }],
      [{ key: 'a', header: 'A' }, { key: 'b', header: 'B', flex: true }],
    );
    for (const line of t.split('\n')) assert.ok(displayWidth(line) <= 40, line);
    assert.ok(!t.includes('\u001b'));
    assert.match(t, /\u2026/);
  });
  it('print() is silent in --json mode; info() too; warn() is not', () => {
    const c = capture({ json: true });
    c.out.print('people');
    c.out.info('progress');
    c.out.warn('careful');
    assert.equal(c.text, 'Warning: careful\n');
  });
});

describe('prompt', () => {
  const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false });
  it('confirm() with --yes does not ask', async () => {
    assert.equal(await confirm('Go?', { yes: true, stdin: { isTTY: false } }), true);
  });
  it('confirm() without a terminal and without --yes is a usage error', async () => {
    await assert.rejects(confirm('Go?', { stdin: { isTTY: false } }), (e) => e.exit === EXIT.USAGE && e.code === 'needs_confirmation');
  });
  it('confirm() reads y/yes, and anything else is no', async () => {
    for (const [answer, want] of [['y\n', true], ['YES\n', true], ['\n', false], ['no\n', false], ['maybe\n', false]]) {
      const stdin = tty();
      const stderr = new PassThrough();
      const p = confirm('Write the file?', { stdin, stderr });
      setImmediate(() => stdin.write(answer));
      assert.equal(await p, want, JSON.stringify(answer));
    }
  });
  it('confirm() writes the question to stderr', async () => {
    const stdin = tty();
    const stderr = new PassThrough();
    let seen = '';
    stderr.on('data', (d) => (seen += d));
    const p = confirm('Write the file?', { stdin, stderr });
    setImmediate(() => stdin.write('n\n'));
    await p;
    assert.match(seen, /Write the file\? \[y\/N\]/);
  });
  it('ask() reads a line; secret input is not echoed', async () => {
    const stdin = tty();
    const stderr = new PassThrough();
    let echoed = '';
    stderr.on('data', (d) => (echoed += d));
    const p = ask('API key:', { stdin, stderr, secret: true });
    setImmediate(() => stdin.write('sk-12\u007f3\r'));
    assert.equal(await p, 'sk-13');
    assert.ok(!echoed.includes('sk-1'));
    await assert.rejects(ask('Key:', { stdin: { isTTY: false } }), (e) => e.code === 'needs_terminal');
  });
});

describe('source rules (every file, every agent)', () => {
  /** @param {string} dir */
  function files(dir, exts = ['.js', '.json', '.md', '.txt']) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(p).isDirectory()) out.push(...files(p, exts));
      else if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
    return out;
  }
  const shipped = [...files(`${ROOT}src`), ...files(`${ROOT}bin`)];
  const words = [
    [/short[\s-]?link/i, 'short link'],
    [/short\s+(url|address)/i, 'short URL / short address'],
    [/popular/i, '"popular" (the order is "Featured first")'],
    [/relay/i, 'relay'],
    [/proxy/i, 'proxy'],
    [/tunnel/i, 'tunnel'],
    [/sits between/i, '"sits between"'],
    [/connects via mcp\.tc/i, '"connects via mcp.tc"'],
    [/the link connects/i, '"the link connects"'],
    [/\b(seamless(ly)?|unlock|powerful|revolutionary|effortless(ly)?|supercharge[sd]?|game-changing)\b/i, 'hype word'],
  ];
  it('finds the files to check', () => {
    assert.ok(shipped.length >= 10);
  });
  for (const [re, what] of words) {
    it(`no ${what} in src/ or bin/`, () => {
      const hits = [];
      for (const f of shipped) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(`${f.slice(ROOT.length)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
      assert.deepEqual(hits, []);
    });
  }
  it('no em or en dashes in src/, bin/, test code, templates, package.json or README', () => {
    const all = [...shipped, ...files(`${ROOT}test`, ['.js']), ...files(`${ROOT}scripts`, ['.mjs', '.js']), ...files(`${ROOT}templates`), `${ROOT}package.json`, `${ROOT}README.md`].filter(existsSync);
    const hits = [];
    for (const f of all) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/[\u2013\u2014]/.test(line)) hits.push(`${f.slice(ROOT.length)}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, []);
  });
  it('no invisible or bidi control characters in any source file', () => {
    const all = [...shipped, ...files(`${ROOT}test`, ['.js']), ...files(`${ROOT}scripts`, ['.mjs', '.js']), ...files(`${ROOT}templates`)];
    const hits = all.filter((f) => /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(hits.map((f) => f.slice(ROOT.length)), []);
  });
  // rules-1: the list of site internals is private, so it lives in the git-ignored .internal-words file (one regular
  // expression per line), never in this repository. Every file the repository would hold is checked, this one too.
  it('no site internals in any file of the repository (patterns from the local .internal-words file)', (t) => {
    const words = internalWords(ROOT);
    if (!words) {
      t.skip('no .internal-words file at the package root, so the site-internals check is skipped (see test/helpers/internal-words.js)');
      return;
    }
    assert.ok(words.length > 0, '.internal-words has no patterns');
    const list = repoFiles(ROOT);
    assert.ok(list.includes('test/cli.test.js') && list.includes('templates/shared/README.md') && list.includes('test/fixtures/directory/index.json'), 'scans tests, templates and fixtures');
    assert.ok(!list.includes(WORDS_FILE), 'the word list itself is not part of the repository');
    const hits = list.flatMap((f) => internalHits(readFileSync(join(ROOT, f), 'utf8'), words, f));
    assert.deepEqual(hits, []);
  });
  it('.internal-words stays out of git and out of the npm package', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes(WORDS_FILE));
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.ok(!pkg.files.some((f) => f === WORDS_FILE || f === '.'), 'not in package.json files');
  });
});

describe('review fixes: prompts, colors, arguments, help, tables, test runner', () => {
  const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false });
  /** Ask with a fake terminal and press `key` once the question shows. */
  async function press(fn, key, opts = {}) {
    const stdin = tty();
    const stderr = new PassThrough();
    let seen = '';
    stderr.on('data', (d) => (seen += d));
    const p = fn('Go on?', { stdin, stderr, ...opts });
    setImmediate(() => stdin.write(key));
    try {
      return { value: await p, seen };
    } catch (err) {
      return { err, seen };
    }
  }

  it('ux-prompt-ctrl-c-exit-0: Ctrl+C at a question is "cancelled" with exit 130, Ctrl+D with exit 1', async () => {
    for (const fn of [confirm, ask]) {
      const c = await press(fn, '\u0003');
      assert.ok(c.err instanceof CliError, `${fn.name}: Ctrl+C throws`);
      assert.equal(c.err.code, 'cancelled');
      assert.equal(c.err.exit, 130);
      assert.match(c.seen, /\n$/, 'the question line is ended');
      const d = await press(fn, '\u0004');
      assert.equal(d.err.code, 'cancelled');
      assert.equal(d.err.exit, 1);
    }
    const s = await press(ask, '\u0003', { secret: true });
    assert.equal(s.err.exit, 130);
    const e = await press(ask, '\u0004', { secret: true });
    assert.equal(e.err.exit, 1, 'Ctrl+D on an empty secret line cancels');
    const typed = await press(ask, 'sk-1\u0004', { secret: true });
    assert.equal(typed.value, 'sk-1', 'Ctrl+D after some text ends the line');
  });

  it('ux-stderr-colors-follow-stdout: each stream decides its own colors', async () => {
    const stream = (isTTY) => {
      let text = '';
      return { isTTY, columns: 80, write: (s) => ((text += s), true), get text() { return text; } };
    };
    const a = { stdout: stream(true), stderr: stream(false) };
    const outA = createOutput({ ...a, env: {} });
    outA.warn('careful');
    assert.equal(outA.color, true);
    assert.equal(outA.errColor, false);
    assert.equal(a.stderr.text, 'Warning: careful\n');
    const b = { stdout: stream(false), stderr: stream(true) };
    const outB = createOutput({ ...b, env: {} });
    outB.warn('careful');
    assert.equal(b.stderr.text, '\u001b[33mWarning:\u001b[39m careful\n');
    assert.equal(createOutput({ ...b, env: { NO_COLOR: '' } }).errColor, false);
    assert.equal(createOutput({ ...b, env: {}, noColor: true }).errColor, false);
    // through main(): an error to a log file has no escape codes even when stdout is a terminal
    const io = { stdout: stream(true), stderr: stream(false) };
    const code = await main(['info'], { ...io, env: { PATH: process.env.PATH } });
    assert.equal(code, 2);
    assert.match(io.stderr.text, /^Error: Missing/);
    const io2 = { stdout: stream(false), stderr: stream(true) };
    await main(['info'], { ...io2, env: { PATH: process.env.PATH } });
    assert.match(io2.stderr.text, /^\u001b\[31mError:\u001b\[39m Missing/);
  });

  it('security-check-raw-listing-name backstop: error messages are cleaned before they reach the terminal', async () => {
    let err = '';
    const code = await main(['\u001b[2Jevil\u0007'], { stdout: { isTTY: false, write: () => true }, stderr: { isTTY: false, write: (s) => ((err += s), true) }, env: { PATH: process.env.PATH } });
    assert.equal(code, 2);
    assert.match(err, /Unknown command "\[2Jevil"/);
    assert.doesNotMatch(err, /[\u0000-\u0008\u000b-\u001f]/);
  });

  it('ux-dash-value-misleading-error: a value that starts with "-" gets the equals-sign hint, and --opt=-x works', () => {
    const meta = { name: 'demo', summary: 'Demo', args: [{ name: 'x' }], options: { note: { type: 'string', short: 'n', valueName: 'text' }, n: { type: 'string', int: { min: 1, max: 5 } } } };
    for (const argv of [['x', '--note', '- maintained by Example'], ['x', '-n', '-x']]) {
      assert.throws(
        () => parse(argv, meta),
        (e) => e.code === 'ambiguous_value' && e.exit === 2 && /A value that starts with "-" needs an equals sign: --note="-\.\.\.", as one argument\./.test(e.message),
      );
    }
    assert.throws(() => parse(['x', '--n', '-3'], meta), (e) => e.code === 'ambiguous_value' && /--n="-\.\.\."/.test(e.message));
    assert.equal(parse(['x', '--note=- maintained by Example'], meta).values.note, '- maintained by Example');
    assert.throws(() => parse(['x', '--note'], meta), /--note needs a value: --note <text>/);
  });

  it('ux-help-usage-inaccurate: every command help ends with its exit codes, and JSON help has them', async () => {
    for (const name of commandNames()) {
      const mod = await loadCommand(name);
      const h = formatHelp(mod.meta);
      assert.match(h, /\nExit codes:\n(?:(?: {2}\d+ +| {4,})\S.*\n?)+$/, name);
      assert.match(h, /\n {2}1 +\S/, `${name}: 1`);
      assert.match(h, /\n {2}2 +\S/, `${name}: 2`);
      for (const [c] of mod.meta.exits || []) assert.match(h, new RegExp(`\\n {2}${c} +\\S`), `${name}: ${c}`);
    }
    const mine = ['search', 'info', 'categories', 'badge', 'dns-check', 'submit', 'doctor', 'check', 'create', 'card'];
    for (const name of mine) assert.ok((await loadCommand(name)).meta.exits, `${name} lists its exit codes`);
    const j = await runCli(['help', 'doctor', '--json'], { base: fake.base });
    assert.deepEqual(j.json().help.exit_codes.map((x) => x.code), [0, 1, 2, 3, 4, 5]);
    const info = await loadCommand('info');
    assert.equal(info.meta.args[0].name, 'slug|name|link');
    assert.equal((await loadCommand('search')).meta.usage, 'search [query] [--category <slug>] [--auth none|sign-in|local] [--limit <n>]');
  });

  it('ux-table-truncation: keep columns and suffixes survive a narrow terminal; nothing is cut off a terminal', () => {
    const rows = [{ name: 'A very long server name indeed', slug: 'a-very-long-slug-that-people-type', tag: 'x'.repeat(80), v: true }];
    const cols = [
      { key: 'name', header: 'Name', max: 32, suffix: (r) => (r.v ? ' \u2713' : '') },
      { key: 'slug', header: 'Slug', keep: true },
      { key: 'tag', header: 'Tagline', flex: true },
    ];
    const narrow = createOutput({ stdout: { isTTY: true, columns: 40, write: () => true }, stderr: { write: () => true }, env: { NO_COLOR: '1' } });
    const t = narrow.table(rows, cols);
    assert.ok(t.includes('a-very-long-slug-that-people-type'));
    assert.match(t.split('\n')[1], /^A[^\u2026]*\u2026 \u2713 {2}a-very-long-slug/);
    const pipe = createOutput({ stdout: { isTTY: false, write: () => true }, stderr: { write: () => true }, env: {} });
    assert.equal(pipe.tableWidth, Infinity);
    assert.equal(pipe.width, 100, 'paragraphs still wrap at 100 columns');
    const full = pipe.table(rows, cols);
    assert.ok(full.includes('A very long server name indeed \u2713') && full.includes('x'.repeat(80)) && !full.includes('\u2026'));
    const env = createOutput({ stdout: { isTTY: false, write: () => true }, stderr: { write: () => true }, env: { COLUMNS: '50' } });
    assert.equal(env.tableWidth, 50, 'COLUMNS still sets the width of a pipe');
  });

  it('security-cr-in-printed-steps: clean() turns CRLF into a newline and drops a lone CR', () => {
    assert.equal(clean('one\r\ntwo\rthree'), 'one\ntwothree');
    assert.equal(clean('a\rb', { oneLine: true }), 'ab');
  });

  it('ux-npm-test-windows-node20: npm test runs a script that lists the test files itself (no shell glob)', async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node scripts/test.mjs');
    assert.doesNotMatch(pkg.scripts.test, /\*/);
    const { testFiles } = await import('../scripts/test.mjs');
    const list = testFiles();
    const want = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).sort().map((f) => join('test', f));
    assert.deepEqual(list, want);
    assert.ok(list.includes(join('test', 'cli.test.js')) && !list.some((f) => f.includes('helpers')));
    assert.ok(!pkg.files.includes('scripts'), 'the runner is not shipped');
  });
});
