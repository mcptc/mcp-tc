import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeDirectory, runCli, fixture } from './helpers/fake-directory.js';
import { run, render, splitCommand, shellQuote, jsonSnippet, placeholders, allowedCommand, ownScope, findWindowsProgram } from '../src/commands/add.js';
import { realLocation } from '../src/lib/clients.js';
import { createOutput } from '../src/lib/output.js';
import { EXIT } from '../src/lib/errors.js';

let fake;
let root;
before(async () => {
  fake = await startFakeDirectory();
  root = mkdtempSync(join(tmpdir(), 'mcptc-add-'));
});
after(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

let n = 0;
/** A fresh home folder (outside any git repository) with a project folder inside. Real path (macOS links /var). */
function home() {
  const h = join(realLocation(root), `h${++n}`);
  mkdirSync(join(h, 'proj'), { recursive: true });
  return h;
}
/** Where add keeps backups for a home folder on Linux (no XDG_STATE_HOME). */
const backups = (h) => join(h, '.local', 'state', 'mcp-tc', 'backups');
const listBackups = (h) => (existsSync(backups(h)) ? readdirSync(backups(h)) : []);
const cli = (argv, h, extra = {}) => runCli(argv, { base: fake.base, env: { HOME: h, ...(extra.env || {}) }, cwd: join(h, 'proj'), platform: extra.platform || 'linux', spawn: extra.spawn });
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const OTHER_KEY = 'FAKE-sk-live-1234567890abcdef';
const TYPED_KEY = 'FAKE-typed-key-0000111122223333';

/** The /mcp calls the fake saw: their tool arguments. */
const sentArgs = () => fake.requests.filter((r) => r.path === '/mcp').map((r) => JSON.parse(r.body).params.arguments);

/** A spawn stand-in: records calls, then exits with the next code (or fails with ENOENT). */
function fakeSpawn(codes = []) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    const code = codes.length ? codes.shift() : 0;
    setImmediate(() => {
      if (code === 'ENOENT') child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      else {
        child.emit('spawn');
        child.emit('close', code, null);
      }
    });
    return child;
  };
  return { fn, calls };
}

/** Run the command in-process as if in a terminal, with scripted answers. */
async function direct({ slug, args, h, answers = [], confirmAnswer = true, confirm, platform = 'linux', spawn, json = false, env = {}, isFile, base, cwd, now }) {
  let stdout = '';
  let stderr = '';
  const so = { isTTY: false, write: (s) => ((stdout += s), true) };
  const se = { isTTY: false, write: (s) => ((stderr += s), true) };
  const out = createOutput({ stdout: so, stderr: se, env: {}, json });
  const asked = [];
  const ctx = {
    command: 'add',
    args,
    positionals: [slug],
    json,
    out,
    base: base || fake.base,
    env: { HOME: h, ...env },
    stdin: { isTTY: true },
    stdout: so,
    stderr: se,
    cwd: cwd || join(h, 'proj'),
    isFile,
    now: now || (() => new Date('2026-10-06T12:00:00Z')),
    platform,
    spawn: spawn ? spawn.fn : undefined,
    setExitCode() {},
    ask: async (q, o) => {
      asked.push({ q, secret: o.secret });
      if (!answers.length) throw new Error(`unexpected question: ${q}`);
      return answers.shift();
    },
    confirm: confirm || (async () => confirmAnswer),
  };
  let result;
  let error;
  try {
    result = await run(ctx);
    if (!json) render(result, out, ctx);
  } catch (e) {
    error = e;
  }
  return { result, error, stdout, stderr, asked };
}

describe('splitCommand()', () => {
  const ok = [
    ['claude mcp add --transport http deepwiki https://mcp.deepwiki.com/mcp', ['claude', 'mcp', 'add', '--transport', 'http', 'deepwiki', 'https://mcp.deepwiki.com/mcp']],
    ['claude mcp add --transport http r https://api.ref.tools/mcp --header "X-Ref-Api-Key: <YOUR_API_KEY>"', ['claude', 'mcp', 'add', '--transport', 'http', 'r', 'https://api.ref.tools/mcp', '--header', 'X-Ref-Api-Key: <YOUR_API_KEY>']],
    ["gemini mcp add x 'https://a.example.com/mcp?x=1&y=2'", ['gemini', 'mcp', 'add', 'x', 'https://a.example.com/mcp?x=1&y=2']],
    ['codex mcp add m --env "K=<YOUR_K>" -- npx -y @scope/pkg', ['codex', 'mcp', 'add', 'm', '--env', 'K=<YOUR_K>', '--', 'npx', '-y', '@scope/pkg']],
    ['a "b"c\'d\'  e', ['a', 'bcd', 'e']],
  ];
  for (const [line, argv] of ok) it(`splits: ${line}`, () => assert.deepEqual(splitCommand(line), { argv }));
  const refused = ['a | b', 'a && b', 'a; b', 'a $(b)', 'a `b`', 'a "$HOME"', 'a "\\x"', 'a > f', 'a < f', 'a *', 'a ~/x', "a 'open", 'a "open', 'a {x,y}', 'a #c', 'a (b)', 'a "!x"'];
  for (const line of refused) it(`refuses: ${line}`, () => assert.ok('error' in splitCommand(line)));
  it('shellQuote round-trips through splitCommand', () => {
    const argv = ['claude', 'X-Key: <YOUR_API_KEY>', "it's", 'https://a.example.com/?q=1&b=2', 'plain'];
    assert.deepEqual(splitCommand(argv.map(shellQuote).join(' ')), { argv });
  });
});

describe('snippets and placeholders', () => {
  it("VS Code: takes the .vscode/mcp.json block, not the code --add-mcp command", () => {
    const g = fixture('mcp-get-deepwiki').message.result.structuredContent.setup.find((s) => s.client === 'vscode');
    const s = jsonSnippet(g, 'servers');
    assert.deepEqual(s.obj, { servers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } });
    assert.equal(s.index, 4);
  });
  it('Claude Desktop remote: no JSON snippet (Connectors)', () => {
    const g = fixture('mcp-get-deepwiki').message.result.structuredContent.setup.find((s) => s.client === 'claude-desktop');
    assert.equal(jsonSnippet(g, 'mcpServers'), null);
  });
  it('placeholders know which values are secret', () => {
    const d = { env_vars: [{ name: 'BASE_URL', secret: false }, { name: 'SERVICE_TOKEN', secret: true }], headers: [] };
    assert.deepEqual(placeholders([{ a: '<YOUR_API_KEY>', b: ['<YOUR_BASE_URL>', 'x <YOUR_SERVICE_TOKEN>'] }], d), [
      { token: '<YOUR_API_KEY>', name: 'API_KEY', secret: true, kind: 'angle', context: 'a' },
      { token: '<YOUR_BASE_URL>', name: 'BASE_URL', secret: false, kind: 'angle', context: null },
      { token: '<YOUR_SERVICE_TOKEN>', name: 'SERVICE_TOKEN', secret: true, kind: 'angle', context: null },
    ]);
  });
  it("mcp.tc's other placeholder forms: YOUR_X, /path/to/..., {name}, <...>; secret from the flag, variable or header", () => {
    const argv = ['npx', '-y', 'pkg', '--repository', '/path/to/repo', '--email', 'YOUR_EMAIL', '--api-key', 'YOUR_API_KEY', '--figma-api-key=YOUR_KEY', 'TENANT={tenant}', 'X-Org: <your-org>'];
    const got = placeholders([argv], {});
    assert.deepEqual(
      got.map((h) => [h.token, h.kind, h.secret, h.context]),
      [
        ['/path/to/repo', 'path', false, '--repository'],
        ['YOUR_EMAIL', 'your', false, '--email'],
        ['YOUR_API_KEY', 'your', true, '--api-key'],
        ['YOUR_KEY', 'your', true, '--figma-api-key'],
        ['{tenant}', 'brace', false, 'TENANT'],
        ['<your-org>', 'angle', false, 'X-Org'],
      ],
    );
    // a client's own variables are not placeholders, nor is a path that merely contains path/to
    assert.deepEqual(placeholders([['${input:x}', '${HOME}/x', '/home/me/path/to/x', 'MY_YOUR_KEY', 'YOUR_lower']], {}), []);
    // <YOUR_X> and a bare YOUR_X are two placeholders, and filling one never touches the other
    assert.deepEqual(placeholders([['K=<YOUR_API_KEY>', 'YOUR_API_KEY']], {}).map((h) => h.token), ['<YOUR_API_KEY>', 'YOUR_API_KEY']);
  });
});

describe('mcp-tc add: JSON file clients', () => {
  /** A Cursor file with one server that carries a key. */
  function cursorHome() {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    writeFileSync(join(h, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: { other: { url: 'https://x.example.com/mcp', headers: { Authorization: `Bearer ${OTHER_KEY}` } } } }, null, 2)}\n`);
    return h;
  }

  it('--dry-run shows the diff and writes nothing', async () => {
    const h = cursorHome();
    const before = readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--dry-run'], h);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Cursor: add "deepwiki" to ~\/\.cursor\/mcp\.json$/m);
    assert.match(r.stdout, /^\+    "deepwiki": \{$/m);
    assert.match(r.stdout, /^\+      "url": "https:\/\/mcp\.deepwiki\.com\/mcp"$/m);
    assert.match(r.stdout, /Dry run: nothing was written\./);
    assert.equal(readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8'), before);
    assert.deepEqual(readdirSync(join(h, '.cursor')), ['mcp.json']);
  });

  it('--json --dry-run returns the plan', async () => {
    const h = cursorHome();
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--dry-run', '--json'], h);
    const j = r.json();
    assert.equal(j.ok, true);
    assert.equal(j.action, 'would_write');
    assert.equal(j.file, join(h, '.cursor', 'mcp.json'));
    assert.equal(j.scope, 'user');
    assert.equal(j.entry, 'deepwiki');
    assert.match(j.diff, /\+ {6}"url": "https:\/\/mcp\.deepwiki\.com\/mcp"/);
    assert.equal(j.install_link.startsWith('https://cursor.com/install-mcp?'), true);
  });

  it('writes: merges, keeps other servers, backs up, never prints their keys', async () => {
    const h = cursorHome();
    const file = join(h, '.cursor', 'mcp.json');
    const before = readFileSync(file, 'utf8');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes'], h);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(read(file), {
      mcpServers: { other: { url: 'https://x.example.com/mcp', headers: { Authorization: `Bearer ${OTHER_KEY}` } }, deepwiki: { url: 'https://mcp.deepwiki.com/mcp' } },
    });
    // the backup is in mcp-tc's own folder, not next to the file
    assert.deepEqual(readdirSync(join(h, '.cursor')), ['mcp.json']);
    const saved = listBackups(h);
    assert.equal(saved.length, 1);
    assert.match(saved[0], /^[0-9a-f]{12}-mcp\.json\.bak-\d{8}T\d{6}Z$/);
    assert.equal(readFileSync(join(backups(h), saved[0]), 'utf8'), before);
    assert.match(r.stdout, /"Authorization": "<hidden>"/);
    assert.ok(!r.stdout.includes(OTHER_KEY) && !r.stderr.includes(OTHER_KEY));
    assert.match(r.stdout, /^Added "deepwiki" to ~\/\.cursor\/mcp\.json\.$/m);
    assert.match(r.stdout, /^Backup: ~\/\.local\/state\/mcp-tc\/backups\/[0-9a-f]{12}-mcp\.json\.bak-/m);
  });

  it('the same entry again: unchanged, no new backup', async () => {
    const h = cursorHome();
    await cli(['add', 'deepwiki', '--client', 'cursor', '--yes'], h);
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes', '--json'], h);
    assert.equal(r.json().action, 'unchanged');
    assert.equal(listBackups(h).length, 1);
  });

  it('an entry with the same name and other settings: refused without --yes, replaced with it', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    const file = join(h, '.cursor', 'mcp.json');
    writeFileSync(file, '{"mcpServers": {"deepwiki": {"url": "https://old.example.com/mcp"}}}\n');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--json'], h);
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'entry_exists');
    assert.equal(read(file).mcpServers.deepwiki.url, 'https://old.example.com/mcp');
    const y = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes'], h);
    assert.equal(y.code, 0);
    assert.match(y.stderr, /Replacing the existing "deepwiki" entry/);
    assert.match(y.stdout, /^Replaced "deepwiki" in /m);
    assert.equal(read(file).mcpServers.deepwiki.url, 'https://mcp.deepwiki.com/mcp');
  });

  it('a file with comments: not rewritten, the snippet is printed', async () => {
    const h = home();
    const dir = join(h, '.config', 'Code', 'User');
    mkdirSync(dir, { recursive: true });
    const text = '{\n  // mine\n  "servers": {}\n}\n';
    writeFileSync(join(dir, 'mcp.json'), text);
    const r = await cli(['add', 'deepwiki', '--client', 'vscode', '--yes'], h);
    assert.equal(r.code, EXIT.ERROR);
    assert.match(r.stderr, /has comments or trailing commas/);
    assert.match(r.stdout, /"servers": \{\n\s+"deepwiki"/);
    assert.equal(readFileSync(join(dir, 'mcp.json'), 'utf8'), text);
    const j = await cli(['add', 'deepwiki', '--client', 'vscode', '--yes', '--json'], h);
    assert.equal(j.json().error.code, 'has_comments');
    assert.match(j.json().error.snippet, /"deepwiki"/);
  });

  it('invalid JSON: not rewritten', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    writeFileSync(join(h, '.cursor', 'mcp.json'), '{"mcpServers": ');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes', '--json'], h);
    assert.equal(r.json().error.code, 'cannot_rewrite');
  });

  it('no terminal and no --yes: asks for nothing, writes nothing, exit 2', async () => {
    const h = cursorHome();
    const before = readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8');
    const r = await runCli(['add', 'deepwiki', '--client', 'cursor', '--json'], { base: fake.base, env: { HOME: h }, cwd: join(h, 'proj'), stdin: { isTTY: false } });
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'needs_confirmation');
    assert.equal(readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8'), before);
  });

  it('a new file in a missing folder: created 0600, with a hint that the client may not be installed', async () => {
    const h = home();
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes'], h);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /~\/\.cursor does not exist yet: is Cursor installed\?/);
    assert.deepEqual(read(join(h, '.cursor', 'mcp.json')), { mcpServers: { deepwiki: { url: 'https://mcp.deepwiki.com/mcp' } } });
  });

  it('asks mcp.tc only for the listing and the client', async () => {
    const h = cursorHome();
    await cli(['add', 'deepwiki', '--client', 'cursor', '--dry-run'], h);
    assert.deepEqual(sentArgs(), [{ slug: 'deepwiki', client: 'cursor' }]);
    assert.ok(fake.requests.every((r) => !r.body.includes(OTHER_KEY) && !JSON.stringify(r.headers).includes(OTHER_KEY)));
  });
});

describe('mcp-tc add: API keys', () => {
  it('Cursor --project with a key: refused, nothing written', async () => {
    const h = home();
    const r = await cli(['add', 'ref-tools', '--client', 'cursor', '--project', '--yes', '--json'], h);
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'key_in_project_file');
    assert.equal(existsSync(join(h, 'proj', '.cursor')), false);
  });

  it("VS Code --project with a key: VS Code's inputs, no key in the file", async () => {
    const h = home();
    const r = await cli(['add', 'ref-tools', '--client', 'vscode', '--project', '--yes'], h);
    assert.equal(r.code, 0, r.stderr);
    const v = read(join(h, 'proj', '.vscode', 'mcp.json'));
    assert.equal(v.servers['ref-tools'].headers['X-Ref-Api-Key'], '${input:x-ref-api-key}');
    assert.deepEqual(v.inputs, [{ type: 'promptString', id: 'x-ref-api-key', description: 'X-Ref-Api-Key', password: true }]);
  });

  it('user file in a terminal: asks for the key (not echoed), writes it there only, never prints it', async () => {
    const h = home();
    const r = await direct({ slug: 'ref-tools', args: { client: 'cursor' }, h, answers: [TYPED_KEY] });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(r.asked.map((a) => a.secret), [true]);
    const file = join(h, '.cursor', 'mcp.json');
    assert.equal(read(file).mcpServers['ref-tools'].headers['X-Ref-Api-Key'], TYPED_KEY);
    assert.ok(!r.stdout.includes(TYPED_KEY) && !r.stderr.includes(TYPED_KEY));
    assert.ok(!JSON.stringify(r.result).includes(TYPED_KEY));
    assert.deepEqual(r.result.filled, ['<YOUR_API_KEY>']);
    assert.deepEqual(r.result.placeholders, []);
    assert.match(r.result.diff, /"X-Ref-Api-Key": "<YOUR_API_KEY>"/);
    assert.ok(fake.requests.every((q) => !q.body.includes(TYPED_KEY) && !q.path.includes(TYPED_KEY)));
  });

  it('a blank answer keeps the placeholder and says so', async () => {
    const h = home();
    const r = await direct({ slug: 'ref-tools', args: { client: 'cursor' }, h, answers: [''] });
    assert.equal(read(join(h, '.cursor', 'mcp.json')).mcpServers['ref-tools'].headers['X-Ref-Api-Key'], '<YOUR_API_KEY>');
    assert.match(r.stdout, /Replace <YOUR_API_KEY> in that file/);
  });

  it('a user file inside a git repository: no key asked, placeholder kept, warning', async () => {
    const h = home();
    mkdirSync(join(h, '.git'));
    const r = await direct({ slug: 'ref-tools', args: { client: 'cursor' }, h, answers: [] });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(r.asked, []);
    assert.match(r.stderr, /inside a git repository/);
    assert.equal(read(join(h, '.cursor', 'mcp.json')).mcpServers['ref-tools'].headers['X-Ref-Api-Key'], '<YOUR_API_KEY>');
  });

  it('--yes: the placeholder stays and the output says to replace it', async () => {
    const h = home();
    const r = await cli(['add', 'ref-tools', '--client', 'devin', '--yes', '--json'], h);
    const j = r.json();
    assert.equal(j.action, 'written');
    assert.deepEqual(j.placeholders, ['<YOUR_API_KEY>']);
    assert.equal(read(join(h, '.config', 'devin', 'mcp_config.json')).mcpServers['ref-tools'].serverUrl, 'https://api.ref.tools/mcp');
  });

  it('Claude Code: asks for the key and passes it to claude only, without a shell', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await direct({ slug: 'ref-tools', args: { client: 'claude-code' }, h, answers: [TYPED_KEY], spawn: sp });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.equal(sp.calls.length, 1);
    assert.equal(sp.calls[0].cmd, 'claude');
    assert.deepEqual(sp.calls[0].args, ['mcp', 'add', '--transport', 'http', 'ref-tools', 'https://api.ref.tools/mcp', '--header', `X-Ref-Api-Key: ${TYPED_KEY}`]);
    assert.equal(sp.calls[0].opts.shell, false);
    assert.ok(!r.stdout.includes(TYPED_KEY) && !JSON.stringify(r.result).includes(TYPED_KEY));
    assert.match(r.stdout, /\$ claude mcp add --transport http ref-tools https:\/\/api\.ref\.tools\/mcp --header 'X-Ref-Api-Key: <YOUR_API_KEY>'/);
  });

  it('a command with a placeholder and --yes: not run, exit 2', async () => {
    const h = home();
    const sp = fakeSpawn();
    const r = await cli(['add', 'ref-tools', '--client', 'claude-code', '--yes', '--json'], h, { spawn: sp.fn });
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'needs_values');
    assert.equal(sp.calls.length, 0);
  });

  it('Gemini CLI keeps servers in the project by default: no key there; --global uses -s user', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await cli(['add', 'ref-tools', '--client', 'gemini', '--json'], h, { spawn: sp.fn });
    assert.equal(r.json().error.code, 'key_in_project_file');
    const g = await direct({ slug: 'ref-tools', args: { client: 'gemini', global: true }, h, answers: [TYPED_KEY], spawn: sp });
    assert.equal(g.error, undefined, g.error && g.error.message);
    assert.deepEqual(sp.calls[0].args.slice(0, 5), ['mcp', 'add', '-s', 'user', '--transport']);
  });
});

describe('mcp-tc add: other clients', () => {
  it('Claude Code: runs the command after confirmation, in the working folder', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await cli(['add', 'deepwiki', '--client', 'claude-code', '--yes'], h, { spawn: sp.fn });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(sp.calls.map((c) => [c.cmd, ...c.args]), [['claude', 'mcp', 'add', '--transport', 'http', 'deepwiki', 'https://mcp.deepwiki.com/mcp']]);
    assert.equal(sp.calls[0].opts.cwd, join(h, 'proj'));
    assert.match(r.stdout, /Done: Claude Code has DeepWiki\./);
    assert.match(r.stdout, /Start Claude Code and type \/mcp\./);
  });

  it('--dry-run runs nothing; --global adds --scope user', async () => {
    const h = home();
    const sp = fakeSpawn();
    const r = await cli(['add', 'deepwiki', '--client', 'claude-code', '--dry-run', '--global', '--json'], h, { spawn: sp.fn });
    assert.equal(sp.calls.length, 0);
    assert.equal(r.json().action, 'would_run');
    assert.equal(r.json().commands[0].text, 'claude mcp add --scope user --transport http deepwiki https://mcp.deepwiki.com/mcp');
  });

  it('Codex with sign-in: two commands, in order; a failure stops the rest', async () => {
    const h = home();
    const ok = fakeSpawn([0, 0]);
    const r = await cli(['add', 'notion', '--client', 'codex', '--yes', '--json'], h, { spawn: ok.fn });
    assert.deepEqual(ok.calls.map((c) => c.args.slice(0, 2).join(' ')), ['mcp add', 'mcp login']);
    assert.deepEqual(r.json().commands.map((c) => c.exit_code), [0, 0]);
    const bad = fakeSpawn([3]);
    const f = await cli(['add', 'notion', '--client', 'codex', '--yes', '--json'], h, { spawn: bad.fn });
    assert.equal(f.code, EXIT.ERROR);
    assert.equal(f.json().error.code, 'command_failed');
    assert.equal(bad.calls.length, 1);
  });

  it('the client is not installed: says so and prints the command', async () => {
    const h = home();
    const r = await cli(['add', 'memory', '--client', 'gemini', '--yes'], h, { spawn: fakeSpawn(['ENOENT']).fn });
    assert.equal(r.code, EXIT.ERROR);
    assert.match(r.stderr, /Could not start "gemini": Gemini CLI is not installed or not on your PATH\. Run the command yourself: gemini mcp add memory npx -- -y @modelcontextprotocol\/server-memory/);
  });

  it('Claude Desktop, local server, on macOS: writes claude_desktop_config.json', async () => {
    const h = home();
    const r = await cli(['add', 'memory', '--client', 'claude-desktop', '--yes'], h, { platform: 'darwin' });
    assert.equal(r.code, 0, r.stderr);
    const file = join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    assert.deepEqual(read(file), { mcpServers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } });
    assert.match(r.stdout, /Save the file and restart Claude Desktop\./);
  });

  it('Claude Desktop on Linux: no config file, steps only', async () => {
    const h = home();
    const r = await cli(['add', 'memory', '--client', 'claude-desktop', '--yes', '--json'], h);
    assert.equal(r.json().action, 'steps');
    assert.match(r.json().warnings[0], /macOS and Windows only/);
  });

  it('Claude Desktop, remote server: the Connectors steps', async () => {
    const h = home();
    const r = await cli(['add', 'deepwiki', '--client', 'claude-desktop'], h, { platform: 'darwin' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Open Customize → Connectors, click \+ Add, then Add custom connector\./);
    assert.match(r.stdout, /^ {5}https:\/\/mcp\.deepwiki\.com\/mcp$/m);
  });

  it('Devin Desktop: XDG_CONFIG_HOME, and a hint about an older file', async () => {
    const h = home();
    mkdirSync(join(h, '.codeium', 'windsurf'), { recursive: true });
    writeFileSync(join(h, '.codeium', 'windsurf', 'mcp_config.json'), '{}');
    const r = await cli(['add', 'deepwiki', '--client', 'devin', '--yes'], h, { env: { XDG_CONFIG_HOME: join(h, 'xdg') } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(read(join(h, 'xdg', 'devin', 'mcp_config.json')), { mcpServers: { deepwiki: { serverUrl: 'https://mcp.deepwiki.com/mcp' } } });
    assert.match(r.stderr, /~\/\.codeium\/windsurf\/mcp_config\.json does\./);
  });

  it('--file writes the named file', async () => {
    const h = home();
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--file', 'custom.json', '--yes', '--json'], h);
    assert.equal(r.json().scope, 'custom');
    assert.deepEqual(read(join(h, 'proj', 'custom.json')), { mcpServers: { deepwiki: { url: 'https://mcp.deepwiki.com/mcp' } } });
  });

  it('claude.ai: steps and the link, nothing written', async () => {
    const h = home();
    const r = await cli(['add', 'notion', '--client', 'claude-ai', '--json'], h);
    const j = r.json();
    assert.equal(j.action, 'steps');
    assert.match(j.setup_link, /^https:\/\/claude\.ai\/customize\/connectors\?modal=add-custom-connector/);
    assert.deepEqual(readdirSync(h), ['proj']);
    const t = await cli(['add', 'notion', '--client', 'claude-ai'], h);
    assert.match(t.stdout, /Add to claude\.ai:\s+https:\/\/claude\.ai\/customize\/connectors/);
    assert.match(t.stdout, /nothing to install on this computer/);
  });

  it('json (any client): the snippet', async () => {
    const r = await cli(['add', 'deepwiki', '--client', 'json'], home());
    assert.match(r.stdout, /"url": "https:\/\/mcp\.deepwiki\.com\/mcp"/);
  });

  it('a client mcp.tc has no steps for: exit 3 with the clients it has', async () => {
    const r = await cli(['add', 'memory', '--client', 'chatgpt', '--json'], home());
    assert.equal(r.code, EXIT.NOT_FOUND);
    assert.equal(r.json().error.code, 'no_setup');
    assert.ok(r.json().error.available.includes('claude-code'));
  });

  it('usage errors: no --client, a bad client, --project for the wrong client', async () => {
    const h = home();
    assert.equal((await cli(['add', 'deepwiki', '--json'], h)).json().error.code, 'missing_client');
    assert.equal((await cli(['add', 'deepwiki', '--client', 'zed'], h)).code, EXIT.USAGE);
    assert.equal((await cli(['add', 'deepwiki', '--client', 'devin', '--project'], h)).code, EXIT.USAGE);
    assert.equal((await cli(['add', 'deepwiki', '--client', 'claude-ai', '--file', 'x.json'], h)).code, EXIT.USAGE);
    assert.equal((await cli(['add', 'deepwiki', '--client', 'cursor', '--global'], h)).code, EXIT.USAGE);
    assert.equal(fake.requests.length, 0);
  });

  it('unknown listing: exit 3', async () => {
    const r = await cli(['add', 'no-such-server', '--client', 'cursor', '--json'], home());
    assert.equal(r.code, EXIT.NOT_FOUND);
    assert.equal(r.json().error.code, 'not_found');
  });
});

describe('mcp-tc add: never a listing link in a config', () => {
  let srv;
  let base;
  before(async () => {
    const d = structuredClone(fixture('mcp-get-deepwiki').message.result.structuredContent);
    for (const g of d.setup) {
      g.code = g.code && g.code.replace('https://mcp.deepwiki.com/mcp', 'https://mcp.tc/i/deepwiki');
      g.steps = g.steps.map((s) => s.replace('https://mcp.deepwiki.com/mcp', 'https://mcp.tc/i/deepwiki'));
    }
    srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body);
        const sc = { ...d, setup: d.setup.filter((g) => g.client === msg.params.arguments.client) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x' }], structuredContent: sc } }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => new Promise((r) => srv.close(r)));

  for (const client of ['cursor', 'claude-code']) {
    it(`${client}: stops before writing or running anything`, async () => {
      const h = home();
      const sp = fakeSpawn();
      const r = await runCli(['add', 'deepwiki', '--client', client, '--yes', '--json'], { base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux', spawn: sp.fn });
      assert.equal(r.json().error.code, 'listing_link');
      assert.equal(sp.calls.length, 0);
      assert.deepEqual(readdirSync(h), ['proj']);
    });
  }
});

/**
 * A stand-in mcp.tc that answers get_server from a recorded listing changed by `mutate` (filtered by client like the
 * real one). Returns {base, close}.
 */
async function customDirectory(slug, mutate) {
  const d = structuredClone(fixture(`mcp-get-${slug}`).message.result.structuredContent);
  mutate(d);
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body);
      const client = msg.params.arguments.client;
      const sc = { ...d, setup: client ? d.setup.filter((g) => g.client === client) : d.setup };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x' }], structuredContent: sc } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
/** Set one client's code (and its fenced step) in a get_server answer. */
const setCode = (client, code) => (d) => {
  const g = d.setup.find((x) => x.client === client);
  g.code = code;
  g.steps = ['```bash\n' + code + '\n```'];
};

describe('add review fixes: keys and git repositories, from the real path', () => {
  /** A dotfiles repository with Cursor's folder in it. */
  function dotfiles(h) {
    mkdirSync(join(h, 'dotfiles', '.git'), { recursive: true });
    mkdirSync(join(h, 'dotfiles', 'cursor'), { recursive: true });
    return join(h, 'dotfiles', 'cursor');
  }

  it('~/.cursor/mcp.json linked into a git repository: the key is not asked or written, the warning names the link and the repository', async () => {
    const h = home();
    const real = join(dotfiles(h), 'mcp.json');
    writeFileSync(real, '{"mcpServers": {}}\n');
    mkdirSync(join(h, '.cursor'));
    symlinkSync(real, join(h, '.cursor', 'mcp.json'));
    const dry = await cli(['add', 'ref-tools', '--client', 'cursor', '--dry-run'], h);
    assert.match(dry.stdout, /Dry run: nothing was written\. It has a placeholder: <YOUR_API_KEY> stays a placeholder \(see the warning above\)\./);
    const r = await direct({ slug: 'ref-tools', args: { client: 'cursor' }, h, answers: [TYPED_KEY] });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(r.asked, [], 'no key asked');
    assert.match(r.stderr, /~\/\.cursor\/mcp\.json links to ~\/dotfiles\/cursor\/mcp\.json, which is inside a git repository \(~\/dotfiles\)/);
    const text = readFileSync(real, 'utf8');
    assert.ok(!text.includes(TYPED_KEY));
    assert.equal(JSON.parse(text).mcpServers['ref-tools'].headers['X-Ref-Api-Key'], '<YOUR_API_KEY>');
    assert.deepEqual(readdirSync(join(h, 'dotfiles', 'cursor')).sort(), ['mcp.json'], 'no backup inside the repository');
    assert.equal(r.result.linked_to, real);
    assert.match(r.stdout, /^Cursor: add "ref-tools" to ~\/\.cursor\/mcp\.json \(a link to ~\/dotfiles\/cursor\/mcp\.json\)$/m);
  });

  it('~/.cursor itself linked into a git repository (GNU stow): same, for a file that does not exist yet', async () => {
    const h = home();
    symlinkSync(dotfiles(h), join(h, '.cursor'));
    const r = await direct({ slug: 'ref-tools', args: { client: 'cursor' }, h, answers: [TYPED_KEY] });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(r.asked, []);
    assert.match(r.stderr, /inside a git repository \(~\/dotfiles\)/);
    assert.ok(!readFileSync(join(h, 'dotfiles', 'cursor', 'mcp.json'), 'utf8').includes(TYPED_KEY));
  });

  it('--file inside a git repository through a link: placeholder kept too', async () => {
    const h = home();
    const target = dotfiles(h);
    symlinkSync(target, join(h, 'proj', 'cfg'));
    const r = await direct({ slug: 'ref-tools', args: { client: 'cursor', file: 'cfg/m.json' }, h, answers: [TYPED_KEY] });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(r.asked, []);
    assert.ok(!readFileSync(join(target, 'm.json'), 'utf8').includes(TYPED_KEY));
  });
});

describe('add review fixes: backups', () => {
  it('a project file listed in .gitignore: the backup goes to the per-user folder (0700/0600), never next to it', async () => {
    const h = home();
    const proj = join(h, 'proj');
    mkdirSync(join(proj, '.git'));
    writeFileSync(join(proj, '.gitignore'), '.cursor/mcp.json\n');
    mkdirSync(join(proj, '.cursor'));
    const before = `${JSON.stringify({ mcpServers: { brave: { command: 'npx', args: ['-y', 'brave'], env: { BRAVE_API_KEY: OTHER_KEY } } } }, null, 2)}\n`;
    writeFileSync(join(proj, '.cursor', 'mcp.json'), before);
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--project', '--yes', '--json'], h);
    assert.equal(r.code, 0, r.stderr);
    const j = r.json();
    assert.deepEqual(readdirSync(join(proj, '.cursor')), ['mcp.json'], 'nothing next to the project file');
    assert.ok(j.backup.startsWith(backups(h) + '/'), j.backup);
    assert.equal(readFileSync(j.backup, 'utf8'), before);
    assert.equal(statSync(j.backup).mode & 0o777, 0o600);
    assert.equal(statSync(backups(h)).mode & 0o777, 0o700);
    assert.ok(!r.stdout.includes(OTHER_KEY));
  });

  it('XDG_STATE_HOME moves the backup folder', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    writeFileSync(join(h, '.cursor', 'mcp.json'), '{"mcpServers": {}}\n');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes', '--json'], h, { env: { XDG_STATE_HOME: join(h, 'st') } });
    assert.ok(r.json().backup.startsWith(join(h, 'st', 'mcp-tc', 'backups') + '/'), r.json().backup);
  });
});

describe('add review fixes: the diff never shows other servers values', () => {
  // hand-formatted (args on one line), with secrets that line-by-line redaction missed: a flag and its value, short
  // passwords, names without "token" or "secret" in them
  const handFormatted = [
    '{',
    '  "mcpServers": {',
    '    "a": { "command": "npx", "args": ["-y", "x-mcp", "--api-key", "Xq9Lmw2", "--password", "hunter2"], "env": { "OPENAI_KEY": "abcdefghijklmnopqrstuvwx", "DB_PASS": "s3cr3t-Pa55" } },',
    '    "b": {',
    '      "command": "npx",',
    '      "args": [',
    '        "-y",',
    '        "y-mcp",',
    '        "--password",',
    '        "Tr0ub4dor&3xyz"',
    '      ]',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const secrets = ['Xq9Lmw2', 'hunter2', 'abcdefghijklmnopqrstuvwx', 's3cr3t-Pa55', 'Tr0ub4dor&3xyz'];

  it('--json and the screen: only the new entry in clear, a note that the file is reformatted, not a whole-file diff', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    writeFileSync(join(h, '.cursor', 'mcp.json'), handFormatted);
    const j = await cli(['add', 'deepwiki', '--client', 'cursor', '--dry-run', '--json'], h);
    const t = await cli(['add', 'deepwiki', '--client', 'cursor', '--dry-run'], h);
    for (const out of [j.stdout, j.stderr, t.stdout, t.stderr]) for (const x of secrets) assert.ok(!out.includes(x), `${x} in ${out}`);
    const res = j.json();
    assert.equal(res.reformat, true);
    assert.match(t.stderr, /mcp-tc writes ~\/\.cursor\/mcp\.json back in its own layout/);
    assert.match(res.diff, /^\+ {4}"deepwiki": \{$/m);
    assert.match(res.diff, /^\+ {6}"url": "https:\/\/mcp\.deepwiki\.com\/mcp"$/m);
    const removed = res.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    assert.ok(removed.length <= 1, `only the closing line of the last entry changes, not the whole file:\n${res.diff}`);
    // the written file keeps every value
    const w = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes'], h);
    assert.equal(w.code, 0, w.stderr);
    const after = read(join(h, '.cursor', 'mcp.json'));
    assert.deepEqual(after.mcpServers.a.args, ['-y', 'x-mcp', '--api-key', 'Xq9Lmw2', '--password', 'hunter2']);
    for (const x of secrets) assert.ok(!w.stdout.includes(x) && !w.stderr.includes(x), x);
  });

  it('a file with a byte order mark keeps it, and the same layout is not reported as reformatted', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    writeFileSync(join(h, '.cursor', 'mcp.json'), '\uFEFF' + JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes', '--json'], h);
    assert.equal(r.json().reformat, false);
    const text = readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8');
    assert.ok(text.startsWith('\uFEFF'));
    assert.deepEqual(JSON.parse(text.slice(1)).mcpServers.deepwiki, { url: 'https://mcp.deepwiki.com/mcp' });
  });

  it('replacing an entry: the old values are hidden too', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    writeFileSync(join(h, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { deepwiki: { url: 'https://old.example.com/mcp', headers: { 'X-Thing': 'hunter2' } } } }, null, 2));
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes', '--json'], h);
    assert.equal(r.json().action, 'written');
    assert.ok(!r.stdout.includes('hunter2'));
    assert.match(r.json().diff, /^- {8}"X-Thing": "<hidden>"$/m);
  });
});

describe('add review fixes: a file that changes while add waits is not overwritten', () => {
  it('another program adds a server during the question: nothing written, the change stays, exit 1', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    const file = join(h, '.cursor', 'mcp.json');
    writeFileSync(file, '{"mcpServers": {"a": {"url": "https://a.example.com/mcp"}}}\n');
    const r = await direct({
      slug: 'deepwiki',
      args: { client: 'cursor' },
      h,
      confirm: async () => {
        writeFileSync(file, '{"mcpServers": {"a": {"url": "https://a.example.com/mcp"}, "b": {"url": "https://b.example.com/mcp"}}}\n');
        return true;
      },
    });
    assert.equal(r.error && r.error.code, 'changed_while_waiting');
    assert.equal(r.error.exit, EXIT.ERROR);
    assert.match(r.error.message, /~\/\.cursor\/mcp\.json changed while mcp-tc was waiting for your answer\. Nothing was written/);
    assert.deepEqual(Object.keys(read(file).mcpServers), ['a', 'b']);
    assert.deepEqual(listBackups(h), []);
  });
  it('a file created during the question, where there was none', async () => {
    const h = home();
    const file = join(h, '.cursor', 'mcp.json');
    const r = await direct({
      slug: 'deepwiki',
      args: { client: 'cursor' },
      h,
      confirm: async () => {
        mkdirSync(join(h, '.cursor'), { recursive: true });
        writeFileSync(file, '{"mcpServers": {"b": {"url": "https://b.example.com/mcp"}}}\n');
        return true;
      },
    });
    assert.equal(r.error && r.error.code, 'changed_while_waiting');
    assert.deepEqual(Object.keys(read(file).mcpServers), ['b']);
  });
});

describe('add review fixes: Windows starts client programs by their full path', () => {
  it('findWindowsProgram: absolute PATH folders only, .exe then .com, never "." or relative folders', () => {
    const files = new Set(['C:\\Tools\\claude.com', 'D:\\bin\\claude.exe', '.\\claude.exe', 'rel\\claude.exe']);
    const isFile = (f) => files.has(f);
    assert.equal(findWindowsProgram('claude', { PATH: '.;rel;;C:\\Tools;D:\\bin' }, isFile), 'C:\\Tools\\claude.com');
    assert.equal(findWindowsProgram('claude', { Path: '"D:\\bin";C:\\Tools' }, isFile), 'D:\\bin\\claude.exe', 'Path in any case, quotes dropped');
    assert.equal(findWindowsProgram('claude', { PATH: '.;rel;C:foo' }, isFile), null);
    assert.equal(findWindowsProgram('claude', {}, isFile), null);
  });
  it('add on Windows: spawns the full path and tells children not to search the current folder', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await direct({ slug: 'deepwiki', args: { client: 'claude-code' }, h, platform: 'win32', spawn: sp, env: { PATH: '.;C:\\Tools' }, isFile: (f) => f === 'C:\\Tools\\claude.exe' });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.equal(sp.calls[0].cmd, 'C:\\Tools\\claude.exe');
    assert.equal(sp.calls[0].opts.env.NoDefaultCurrentDirectoryInExePath, '1');
    assert.equal(sp.calls[0].opts.shell, false);
  });
  it('add on Windows: only in the current folder (or nowhere): client_not_found, nothing started', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await direct({ slug: 'deepwiki', args: { client: 'claude-code' }, h, platform: 'win32', spawn: sp, env: { PATH: '.;relative' }, isFile: () => true });
    assert.equal(r.error && r.error.code, 'client_not_found');
    assert.match(r.error.message, /never in the current folder/);
    assert.equal(sp.calls.length, 0);
  });
});

describe('add review fixes: --project never leaves the project folder', () => {
  it('a project .cursor/mcp.json that links to ~/.claude.json: refused, nothing changed', async () => {
    const h = home();
    const claude = join(h, '.claude.json');
    writeFileSync(claude, '{"mcpServers": {}}\n');
    mkdirSync(join(h, 'proj', '.cursor'));
    symlinkSync('../../.claude.json', join(h, 'proj', '.cursor', 'mcp.json'));
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--project', '--yes', '--json'], h);
    assert.equal(r.code, EXIT.ERROR);
    assert.equal(r.json().error.code, 'outside_project');
    assert.match(r.json().error.message, /leads to ~\/\.claude\.json, outside this project folder/);
    assert.equal(readFileSync(claude, 'utf8'), '{"mcpServers": {}}\n');
    assert.deepEqual(listBackups(h), []);
  });
  it('a project .vscode folder that links outside: refused too', async () => {
    const h = home();
    mkdirSync(join(h, 'elsewhere'));
    symlinkSync(join(h, 'elsewhere'), join(h, 'proj', '.vscode'));
    const r = await cli(['add', 'deepwiki', '--client', 'vscode', '--project', '--yes', '--json'], h);
    assert.equal(r.json().error.code, 'outside_project');
    assert.deepEqual(readdirSync(join(h, 'elsewhere')), []);
  });
});

describe('add review fixes: only "mcp add" commands run', () => {
  it('allowedCommand(): mcp add for every client, mcp login for codex only', () => {
    assert.equal(allowedCommand('claude', ['claude', 'mcp', 'add', 'x', 'https://a.example.com']), true);
    assert.equal(allowedCommand('codex', ['codex', 'mcp', 'login', 'x']), true);
    for (const argv of [['claude', 'mcp', 'remove', 'github'], ['claude', '-p', 'hi', '--dangerously-skip-permissions'], ['codex', 'exec', 'x'], ['claude', 'mcp', 'login', 'x'], ['gemini', 'mcp', 'list']]) {
      assert.equal(allowedCommand(argv[0], argv), false, argv.join(' '));
    }
  });
  for (const code of ['claude mcp remove github', "claude -p 'do things' --dangerously-skip-permissions", 'claude mcp add --transport http deepwiki https://mcp.deepwiki.com/mcp\nclaude mcp remove github']) {
    it(`a setup with ${JSON.stringify(code)}: steps only, nothing run`, async () => {
      const dir = await customDirectory('deepwiki', setCode('claude-code', code));
      try {
        const h = home();
        const sp = fakeSpawn([0, 0]);
        const r = await runCli(['add', 'deepwiki', '--client', 'claude-code', '--yes', '--json'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux', spawn: sp.fn });
        assert.equal(r.json().action, 'steps');
        assert.match(r.json().warnings[0], /mcp-tc only runs "claude mcp add" commands, so it runs nothing/);
        assert.equal(sp.calls.length, 0);
      } finally {
        await dir.close();
      }
    });
  }
});

describe('add review fixes: carriage returns from mcp.tc never reach the terminal', () => {
  it('a CR inside a step, a fenced command and a note', async () => {
    const dir = await customDirectory('deepwiki', (d) => {
      const g = d.setup.find((x) => x.client === 'claude-ai');
      g.steps = ['Open the form:\r\nthen paste', '```bash\nnpx evil-pkg\r# npx @modelcontextprotocol/server-memory\n```', 'https://claude.ai/x\r'];
      g.note = 'Fine\rprint';
    });
    try {
      const h = home();
      const t = await runCli(['add', 'deepwiki', '--client', 'claude-ai'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux' });
      assert.equal(t.code, 0, t.stderr);
      assert.ok(!t.stdout.includes('\r'), JSON.stringify(t.stdout));
      assert.match(t.stdout, /npx evil-pkg/, 'both commands stay visible');
      assert.match(t.stdout, /# npx @modelcontextprotocol\/server-memory/);
      const j = await runCli(['add', 'deepwiki', '--client', 'claude-ai', '--json'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux' });
      assert.ok(!JSON.stringify(j.json()).includes('\\r'));
    } finally {
      await dir.close();
    }
  });
});

describe("add review fixes: mcp.tc's other placeholder forms (/path/to/..., YOUR_X)", () => {
  it('git, Claude Code --dry-run: names the value it will ask for', async () => {
    const h = home();
    const r = await cli(['add', 'git', '--client', 'claude-code', '--dry-run'], h);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Dry run: nothing was run\. It needs \/path\/to\/repo: add asks for it when you run it in a terminal without --yes/);
    const j = await cli(['add', 'git', '--client', 'claude-code', '--dry-run', '--json'], h);
    assert.deepEqual(j.json().placeholders, ['/path/to/repo']);
    assert.equal(j.json().complete, null);
  });
  it('git, Claude Code --yes: not run with the placeholder, exit 2', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await cli(['add', 'git', '--client', 'claude-code', '--yes', '--json'], h, { spawn: sp.fn });
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'needs_values');
    assert.deepEqual(r.json().error.placeholders, ['/path/to/repo']);
    assert.equal(sp.calls.length, 0);
  });
  it('git, Claude Code in a terminal: asks for the folder (shown), makes it absolute, runs, Done', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await direct({ slug: 'git', args: { client: 'claude-code' }, h, answers: ['~/code/my-repo'], spawn: sp });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(r.asked.map((a) => a.secret), [false]);
    assert.match(r.asked[0].q, /Value for \/path\/to\/repo \(--repository\), a folder or file path/);
    assert.deepEqual(sp.calls[0].args.slice(-2), ['--repository', join(h, 'code', 'my-repo')]);
    assert.equal(r.result.complete, true);
    assert.match(r.stdout, /Done: Claude Code has Git\./);
  });
  it('git, Cursor --yes: written with the placeholder, never reported as added', async () => {
    const h = home();
    const r = await cli(['add', 'git', '--client', 'cursor', '--yes'], h);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Wrote "git" in ~\/\.cursor\/mcp\.json, with a placeholder still in it\.$/m);
    assert.match(r.stdout, /^Replace \/path\/to\/repo in that file with your own value before you use it\.$/m);
    assert.ok(!/^Added /m.test(r.stdout));
    const j = await cli(['add', 'git', '--client', 'cursor', '--yes', '--json'], home());
    assert.equal(j.json().complete, false);
    assert.deepEqual(j.json().placeholders, ['/path/to/repo']);
  });
  it('git, Cursor in a terminal: the folder goes into the file', async () => {
    const h = home();
    const r = await direct({ slug: 'git', args: { client: 'cursor' }, h, answers: ['/srv/repo'] });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(read(join(h, '.cursor', 'mcp.json')).mcpServers.git.args, ['mcp-server-git', '--repository', '/srv/repo']);
    assert.equal(r.result.complete, true);
    assert.match(r.stdout, /^Added "git" to /m);
  });
  it('upstash: YOUR_API_KEY after --api-key is a key (hidden question); YOUR_EMAIL is not', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await direct({ slug: 'upstash', args: { client: 'claude-code' }, h, answers: ['me@example.com', TYPED_KEY, 'box', 'me@example.com', TYPED_KEY], spawn: sp });
    assert.equal(r.error, undefined, r.error && r.error.message);
    assert.deepEqual(
      r.asked.map((a) => [a.q.split(' ')[2], a.secret]),
      [
        ['<YOUR_UPSTASH_EMAIL>', false],
        ['<YOUR_UPSTASH_API_KEY>', true],
        ['<YOUR_UPSTASH_BOX_API_KEY>', true],
        ['YOUR_EMAIL', false],
        ['YOUR_API_KEY', true],
      ],
    );
    const argv = sp.calls[0].args;
    assert.deepEqual(argv.slice(-4), ['--email', 'me@example.com', '--api-key', TYPED_KEY]);
    assert.ok(argv.includes(`UPSTASH_API_KEY=${TYPED_KEY}`));
    assert.ok(!r.stdout.includes(TYPED_KEY) && !JSON.stringify(r.result).includes(TYPED_KEY));
  });
  it('upstash: a key placeholder blocks Gemini project scope and VS Code --project', async () => {
    const h = home();
    const g = await cli(['add', 'upstash', '--client', 'gemini', '--json'], h);
    assert.equal(g.json().error.code, 'key_in_project_file');
    const v = await cli(['add', 'upstash', '--client', 'vscode', '--project', '--yes', '--json'], h);
    assert.equal(v.json().error.code, 'key_in_project_file');
    assert.equal(existsSync(join(h, 'proj', '.vscode')), false);
  });
});

describe('add review fixes: Codex and a key header it cannot take on the command line', () => {
  it('ref-tools: runs nothing, prints the config.toml steps and the variable to set', async () => {
    const h = home();
    const sp = fakeSpawn([0]);
    const r = await cli(['add', 'ref-tools', '--client', 'codex', '--yes', '--json'], h, { spawn: sp.fn });
    assert.equal(r.code, 0, r.stderr);
    const j = r.json();
    assert.equal(j.action, 'steps');
    assert.equal(sp.calls.length, 0);
    assert.match(j.warnings[0], /Codex can't take the X-Ref-Api-Key header on the command line, so mcp-tc does not run the command/);
    assert.match(j.warnings[0], /set X_REF_API_KEY to your key/);
    assert.ok(j.steps.some((s) => s.includes('env_http_headers')));
    const t = await cli(['add', 'ref-tools', '--client', 'codex', '--yes'], h, { spawn: sp.fn });
    assert.ok(!/Done:/.test(t.stdout));
    assert.match(t.stdout, /env_http_headers = \{ "X-Ref-Api-Key" = "X_REF_API_KEY" \}/);
    assert.equal(sp.calls.length, 0);
  });
  it('a bearer key passed with --bearer-token-env-var still runs', async () => {
    const dir = await customDirectory('ref-tools', (d) => {
      d.headers = [{ name: 'Authorization', required: true, secret: true }];
      setCode('codex', 'codex mcp add ref-tools --url https://api.ref.tools/mcp --bearer-token-env-var REF_TOOLS_API_KEY')(d);
    });
    try {
      const h = home();
      const sp = fakeSpawn([0]);
      const r = await runCli(['add', 'ref-tools', '--client', 'codex', '--yes', '--json'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux', spawn: sp.fn });
      assert.equal(r.json().action, 'ran');
      assert.equal(sp.calls.length, 1);
    } finally {
      await dir.close();
    }
  });
});

describe("add review fixes: the client's own scope option, never the server's arguments", () => {
  const acme = 'gemini mcp add -e "ACME_API_KEY=<YOUR_ACME_API_KEY>" acme-db npx -- -y acme-db-mcp -s stdio';
  it('ownScope() reads only the words before "--"', () => {
    assert.equal(ownScope(splitCommand(acme).argv), null);
    assert.deepEqual(ownScope(['gemini', 'mcp', 'add', '-s', 'user', 'x', 'npx']), { index: 3, value: 'user', inline: false });
    assert.deepEqual(ownScope(['claude', 'mcp', 'add', '--scope=project', 'x', 'https://a.example.com']), { index: 3, value: 'project', inline: true });
  });
  it('Gemini: "-s stdio" among the server arguments does not hide the project scope; --global adds -s user', async () => {
    const dir = await customDirectory('ref-tools', setCode('gemini', acme));
    try {
      const h = home();
      const sp = fakeSpawn([0]);
      const r = await runCli(['add', 'ref-tools', '--client', 'gemini', '--json'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux', spawn: sp.fn });
      assert.equal(r.json().error.code, 'key_in_project_file');
      const g = await direct({ slug: 'ref-tools', args: { client: 'gemini', global: true }, h, answers: [TYPED_KEY], spawn: sp, base: dir.base });
      assert.equal(g.error, undefined, g.error && g.error.message);
      assert.deepEqual(sp.calls[0].args.slice(0, 4), ['mcp', 'add', '-s', 'user']);
      assert.deepEqual(sp.calls[0].args.slice(-5), ['--', '-y', 'acme-db-mcp', '-s', 'stdio'], "the server's own arguments are untouched");
    } finally {
      await dir.close();
    }
  });
  it('Gemini: an explicit "-s project" counts as project scope; --global turns it into user', async () => {
    const dir = await customDirectory('ref-tools', setCode('gemini', 'gemini mcp add -s project --header "X-Ref-Api-Key: <YOUR_API_KEY>" ref-tools https://api.ref.tools/mcp'));
    try {
      const h = home();
      const r = await runCli(['add', 'ref-tools', '--client', 'gemini', '--json'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux' });
      assert.equal(r.json().error.code, 'key_in_project_file');
      const d = await runCli(['add', 'ref-tools', '--client', 'gemini', '--global', '--dry-run', '--json'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux' });
      assert.match(d.json().commands[0].text, /^gemini mcp add -s user --header/);
    } finally {
      await dir.close();
    }
  });
  it('Claude Code: a key with --scope project (.mcp.json in the folder) is refused', async () => {
    const dir = await customDirectory('ref-tools', setCode('claude-code', 'claude mcp add --scope project --transport http ref-tools https://api.ref.tools/mcp --header "X-Ref-Api-Key: <YOUR_API_KEY>"'));
    try {
      const h = home();
      const r = await runCli(['add', 'ref-tools', '--client', 'claude-code', '--json'], { base: dir.base, env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux' });
      assert.equal(r.json().error.code, 'key_in_project_file');
      assert.match(r.json().error.message, /\.mcp\.json \(--scope project\)/);
    } finally {
      await dir.close();
    }
  });
});

describe('add review fixes: a file that cannot be written', () => {
  it('write_failed with the path, not "unexpected"', async () => {
    const h = home();
    writeFileSync(join(h, 'proj', 'plain'), 'x');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--file', 'plain/mcp.json', '--yes', '--json'], h);
    assert.equal(r.code, EXIT.ERROR);
    const e = r.json().error;
    assert.equal(e.code, 'write_failed');
    assert.match(e.message, /^Could not write ~\/proj\/plain\/mcp\.json \((ENOTDIR|EEXIST)\)\. The file was not changed\.$/);
  });
  it('the write fails after the backup: write_failed, the file untouched, and the backup it made is named', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    const file = join(h, '.cursor', 'mcp.json');
    writeFileSync(file, '{"mcpServers": {}}\n');
    // the clock is read just before the backup: swap the folder for a plain file there, so the write itself fails
    // (works as root too, where permission bits would not stop it)
    const now = () => {
      rmSync(join(h, '.cursor'), { recursive: true });
      writeFileSync(join(h, '.cursor'), 'not a folder');
      return new Date('2026-10-06T12:00:00Z');
    };
    const r = await direct({ slug: 'deepwiki', args: { client: 'cursor', yes: true }, h, now, json: true });
    assert.equal(r.error && r.error.code, 'write_failed', r.error && r.error.message);
    assert.match(r.error.message, /^Could not write ~\/\.cursor\/mcp\.json \((ENOTDIR|EEXIST)\)\. The file was not changed; a backup is at ~\/\.local\/state\/mcp-tc\/backups\/[0-9a-f]{12}-mcp\.json\.bak-20261006T120000Z\.$/);
    assert.equal(readFileSync(r.error.details.backup, 'utf8'), '{"mcpServers": {}}\n');
  });
  it('the backup folder cannot be made: write_failed, nothing written', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'));
    const file = join(h, '.cursor', 'mcp.json');
    writeFileSync(file, '{"mcpServers": {}}\n');
    writeFileSync(join(h, '.local'), 'a file where the state folder would go');
    const r = await cli(['add', 'deepwiki', '--client', 'cursor', '--yes', '--json'], h);
    assert.equal(r.json().error.code, 'write_failed');
    assert.match(r.json().error.message, /^Could not save a backup of ~\/\.cursor\/mcp\.json in ~\/\.local\/state\/mcp-tc\/backups \((ENOTDIR|EEXIST)\), so mcp-tc did not change the file\.$/);
    assert.equal(readFileSync(file, 'utf8'), '{"mcpServers": {}}\n');
  });
});

describe('add: help', () => {
  it('says that a key in claude mcp add --header shows in the process list', async () => {
    const r = await runCli(['help', 'add']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.replace(/\s+/g, ' '), /a key passed with claude mcp add --header is visible to other users of the same machine in the process list while the command runs/);
  });
});

// Read-only checks against https://mcp.tc: two get_server calls, one second apart. Run with MCPTC_LIVE=1.
describe('live mcp.tc (MCPTC_LIVE=1)', { skip: process.env.MCPTC_LIVE !== '1' && 'set MCPTC_LIVE=1 to run against https://mcp.tc' }, () => {
  const pause = () => new Promise((r) => setTimeout(r, 1000));
  it('Cursor --dry-run: the vendor URL, nothing written', async () => {
    const h = home();
    const r = await runCli(['add', 'deepwiki', '--client', 'cursor', '--dry-run', '--json'], { base: 'https://mcp.tc', env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux' });
    const j = r.json();
    assert.equal(j.action, 'would_write');
    assert.match(j.diff, /"url": "https:\/\/mcp\.deepwiki\.com\/mcp"/);
    assert.doesNotMatch(j.diff, /mcp\.tc\/i\//);
    assert.deepEqual(readdirSync(h), ['proj']);
  });
  it('Claude Code --dry-run: a command mcp-tc can run without a shell', async () => {
    await pause();
    const h = home();
    const r = await runCli(['add', 'deepwiki', '--client', 'claude-code', '--dry-run', '--json'], { base: 'https://mcp.tc', env: { HOME: h }, cwd: join(h, 'proj'), platform: 'linux' });
    assert.match(r.json().commands[0].text, /^claude mcp add .*https:\/\/mcp\.deepwiki\.com\/mcp$/);
  });
});
