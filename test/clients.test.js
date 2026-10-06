import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupDir,
  backupFile,
  describeServer,
  gitRepoOf,
  isInside,
  isPrivateHost,
  isRevealingHost,
  linkedTarget,
  lookupTarget,
  looksLikeToken,
  mergeServer,
  packageFromCommand,
  parseJsonc,
  parseToml,
  projectFile,
  readForScan,
  readJsonForWrite,
  realLocation,
  redactConfig,
  redactLine,
  repoForWrite,
  redactValue,
  scanLocations,
  serialize,
  serversIn,
  unifiedDiff,
  urlForLookup,
  userFile,
  where,
  writeFileAtomic,
} from '../src/lib/clients.js';

const FIX = new URL('./fixtures/clients/', import.meta.url);
const fixtureText = (name) => readFileSync(new URL(name, FIX), 'utf8');

let tmp;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcptc-clients-'));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const posix = (env = {}, platform = 'linux') => where({ platform, env: { HOME: '/home/u', ...env }, cwd: '/work/proj' });
const win = (env = {}) => where({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming', ...env }, cwd: 'C:\\work\\proj' });

describe('config file locations', () => {
  it('Cursor: ~/.cursor/mcp.json on every system, .cursor/mcp.json in the project', () => {
    assert.equal(userFile('cursor', posix()), '/home/u/.cursor/mcp.json');
    assert.equal(userFile('cursor', posix({}, 'darwin')), '/home/u/.cursor/mcp.json');
    assert.equal(userFile('cursor', win()), 'C:\\Users\\u\\.cursor\\mcp.json');
    assert.equal(projectFile('cursor', posix()), '/work/proj/.cursor/mcp.json');
  });
  it("VS Code: mcp.json in the user folder, .vscode/mcp.json in the project", () => {
    assert.equal(userFile('vscode', posix()), '/home/u/.config/Code/User/mcp.json');
    assert.equal(userFile('vscode', posix({ XDG_CONFIG_HOME: '/xdg' })), '/xdg/Code/User/mcp.json');
    assert.equal(userFile('vscode', posix({}, 'darwin')), '/home/u/Library/Application Support/Code/User/mcp.json');
    assert.equal(userFile('vscode', win()), 'C:\\Users\\u\\AppData\\Roaming\\Code\\User\\mcp.json');
    assert.equal(projectFile('vscode', posix()), '/work/proj/.vscode/mcp.json');
  });
  it('Claude Desktop: macOS and Windows only', () => {
    assert.equal(userFile('claude-desktop', posix({}, 'darwin')), '/home/u/Library/Application Support/Claude/claude_desktop_config.json');
    assert.equal(userFile('claude-desktop', win()), 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
    assert.equal(userFile('claude-desktop', posix()), null);
    assert.equal(projectFile('claude-desktop', posix({}, 'darwin')), null);
  });
  it('Devin Desktop: ~/.config/devin (or XDG_CONFIG_HOME), %APPDATA%\\devin on Windows', () => {
    assert.equal(userFile('devin', posix()), '/home/u/.config/devin/mcp_config.json');
    assert.equal(userFile('devin', posix({}, 'darwin')), '/home/u/.config/devin/mcp_config.json');
    assert.equal(userFile('devin', posix({ XDG_CONFIG_HOME: '/xdg' })), '/xdg/devin/mcp_config.json');
    assert.equal(userFile('devin', posix({ XDG_CONFIG_HOME: 'relative' })), '/home/u/.config/devin/mcp_config.json');
    assert.equal(userFile('devin', win()), 'C:\\Users\\u\\AppData\\Roaming\\devin\\mcp_config.json');
  });
  it('no user file for CLI and web clients', () => {
    for (const c of ['claude-code', 'codex', 'gemini', 'claude-ai', 'chatgpt', 'json']) assert.equal(userFile(c, posix()), null);
  });
  it('scan reads every documented file, user and project', () => {
    const paths = scanLocations(posix({ CODEX_HOME: '/codex', CLAUDE_CONFIG_DIR: '/cc' })).map((l) => `${l.label}|${l.scope}|${l.path}`);
    for (const want of [
      'Claude Code|user|/cc/.claude.json',
      'Claude Code, VS Code|project|/work/proj/.mcp.json',
      'Cursor|user|/home/u/.cursor/mcp.json',
      'Cursor|project|/work/proj/.cursor/mcp.json',
      'VS Code|user|/home/u/.config/Code/User/mcp.json',
      'VS Code Insiders|user|/home/u/.config/Code - Insiders/User/mcp.json',
      'VS Code|user|/home/u/.copilot/mcp-config.json',
      'VS Code|project|/work/proj/.vscode/mcp.json',
      'Devin Desktop|user|/home/u/.config/devin/mcp_config.json',
      'Devin Desktop|user|/home/u/.codeium/windsurf/mcp_config.json',
      'Codex|user|/codex/config.toml',
      'Codex|project|/work/proj/.codex/config.toml',
      'Gemini CLI|user|/home/u/.gemini/settings.json',
      'Gemini CLI|project|/work/proj/.gemini/settings.json',
    ]) {
      assert.ok(paths.includes(want), `missing ${want}`);
    }
    assert.ok(!paths.some((p) => p.includes('Claude Desktop')), 'no Claude Desktop file on Linux');
  });
  it('scan finds VS Code profiles', () => {
    const home = join(tmp, 'profiles-home');
    mkdirSync(join(home, '.config', 'Code', 'User', 'profiles', 'abc123'), { recursive: true });
    const paths = scanLocations(where({ platform: 'linux', env: { HOME: home }, cwd: tmp })).map((l) => l.path);
    assert.ok(paths.includes(join(home, '.config', 'Code', 'User', 'profiles', 'abc123', 'mcp.json')));
  });
});

describe('reading config files', () => {
  it('a missing or empty file reads as an empty object', () => {
    assert.deepEqual(readJsonForWrite(join(tmp, 'nope.json')).data, {});
    writeFileSync(join(tmp, 'empty.json'), '  \n');
    const r = readJsonForWrite(join(tmp, 'empty.json'));
    assert.equal(r.exists, true);
    assert.deepEqual(r.data, {});
    assert.equal(r.problem, null);
  });
  it('JSONC is reported, not parsed for writing', () => {
    writeFileSync(join(tmp, 'c.json'), fixtureText('vscode-mcp.json'));
    const r = readJsonForWrite(join(tmp, 'c.json'));
    assert.equal(r.problem, 'comments');
    assert.equal(r.data, null);
  });
  it('invalid JSON and a non-object are reported', () => {
    writeFileSync(join(tmp, 'bad.json'), '{"a": ');
    assert.equal(readJsonForWrite(join(tmp, 'bad.json')).problem, 'invalid');
    writeFileSync(join(tmp, 'arr.json'), '[1,2]');
    assert.equal(readJsonForWrite(join(tmp, 'arr.json')).problem, 'not_object');
  });
  it('keeps tabs, CRLF, a missing final newline and a BOM out of the way', () => {
    writeFileSync(join(tmp, 'fmt.json'), '\uFEFF{\r\n\t"a": 1\r\n}');
    const r = readJsonForWrite(join(tmp, 'fmt.json'));
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(r.indent, '\t');
    assert.equal(r.eol, '\r\n');
    assert.equal(r.finalNewline, false);
    assert.equal(serialize({ a: 1, b: 2 }, r), '{\r\n\t"a": 1,\r\n\t"b": 2\r\n}');
  });
  it('follows a symlink to the real file', () => {
    writeFileSync(join(tmp, 'real.json'), '{}');
    symlinkSync(join(tmp, 'real.json'), join(tmp, 'link.json'));
    assert.equal(readJsonForWrite(join(tmp, 'link.json')).path, join(tmp, 'real.json'));
  });
  it('scan reads JSONC and TOML', () => {
    writeFileSync(join(tmp, 'g.json'), fixtureText('gemini-settings.json'));
    assert.deepEqual(Object.keys(readForScan(join(tmp, 'g.json'), 'json').data.mcpServers), ['sse-server', 'stream', 'pkg']);
    writeFileSync(join(tmp, 'c.toml'), fixtureText('codex-config.toml'));
    assert.deepEqual(Object.keys(readForScan(join(tmp, 'c.toml'), 'toml').data.mcp_servers), ['docs', 'fs', 'docker-fetch']);
  });
});

describe('parseJsonc()', () => {
  it('drops comments and trailing commas, keeps strings that look like them', () => {
    const v = parseJsonc('{\n // c\n "u": "https://x.example/a//b", /* c */ "s": ",}", "l": [1, 2,],\n}');
    assert.deepEqual(v, { u: 'https://x.example/a//b', s: ',}', l: [1, 2] });
  });
  it('still rejects broken JSON', () => {
    assert.throws(() => parseJsonc('{"a": }'));
    assert.throws(() => parseJsonc('{"a": 1 /* open'));
  });
});

describe('mergeServer()', () => {
  const file = { other: 1, mcpServers: { keep: { url: 'https://keep.example.com/mcp' } } };
  it('adds an entry without touching the rest, and without changing its input', () => {
    const before = structuredClone(file);
    const r = mergeServer(file, { container: 'mcpServers', name: 'new', entry: { url: 'https://new.example.com/mcp' } });
    assert.equal(r.status, 'added');
    assert.deepEqual(r.data, { other: 1, mcpServers: { keep: { url: 'https://keep.example.com/mcp' }, new: { url: 'https://new.example.com/mcp' } } });
    assert.deepEqual(file, before);
  });
  it('creates the container when missing', () => {
    assert.deepEqual(mergeServer({}, { container: 'servers', name: 'a', entry: { type: 'http' } }).data, { servers: { a: { type: 'http' } } });
  });
  it('same entry (any key order): same; different: conflict unless replace', () => {
    assert.equal(mergeServer({ mcpServers: { a: { x: 1, y: 2 } } }, { container: 'mcpServers', name: 'a', entry: { y: 2, x: 1 } }).status, 'same');
    const c = mergeServer(file, { container: 'mcpServers', name: 'keep', entry: { url: 'https://changed.example.com/mcp' } });
    assert.equal(c.status, 'conflict');
    assert.equal(c.data.mcpServers.keep.url, 'https://keep.example.com/mcp');
    const r = mergeServer(file, { container: 'mcpServers', name: 'keep', entry: { url: 'https://changed.example.com/mcp' }, replace: true });
    assert.equal(r.status, 'replaced');
    assert.equal(r.data.mcpServers.keep.url, 'https://changed.example.com/mcp');
  });
  it('VS Code inputs: adds new ids, keeps an existing different one', () => {
    const data = { servers: {}, inputs: [{ type: 'promptString', id: 'k', description: 'mine', password: true }] };
    const r = mergeServer(data, {
      container: 'servers',
      name: 's',
      entry: { type: 'http' },
      inputs: [
        { type: 'promptString', id: 'k', description: 'theirs', password: true },
        { type: 'promptString', id: 'n', description: 'new', password: true },
      ],
    });
    assert.deepEqual(r.inputsAdded, ['n']);
    assert.deepEqual(r.inputsKept, ['k']);
    assert.equal(r.data.inputs[0].description, 'mine');
    assert.equal(r.data.inputs.length, 2);
  });
  it('reports a container that is not an object', () => {
    assert.match(mergeServer({ mcpServers: [] }, { container: 'mcpServers', name: 'a', entry: {} }).problem, /not an object/);
  });
});

describe('unifiedDiff()', () => {
  it('equal texts: empty', () => assert.equal(unifiedDiff('a\n', 'a\n'), ''));
  it('one hunk with three lines of context', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n') + '\n';
    const b = ['1', '2', '3', '4', 'new', '5', '6', '7', '8'].join('\n') + '\n';
    assert.equal(unifiedDiff(a, b, { from: 'f', to: 'f' }), ['--- f', '+++ f', '@@ -2,6 +2,7 @@', ' 2', ' 3', ' 4', '+new', ' 5', ' 6', ' 7'].join('\n'));
  });
  it('a new file', () => {
    assert.equal(unifiedDiff('', '{\n}\n', { from: '/dev/null', to: 'x' }), ['--- /dev/null', '+++ x', '@@ -0,0 +1,2 @@', '+{', '+}'].join('\n'));
  });
  it('two changes far apart: two hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const b = a.replace('l1\n', 'L1\n').replace('l18', 'L18');
    const d = unifiedDiff(a, b);
    assert.equal(d.split('\n').filter((l) => l.startsWith('@@')).length, 2);
    assert.match(d, /^-l1$/m);
    assert.match(d, /^\+L18$/m);
  });
});

describe('backup and atomic write', () => {
  it('backs up into its own folder (0700), file 0600, named by a hash of the path and a UTC stamp, never over an earlier backup', () => {
    const f = join(tmp, 'b.json');
    writeFileSync(f, '{"v":1}', { mode: 0o644 });
    const dir = join(tmp, 'state', 'mcp-tc', 'backups');
    const now = new Date('2026-10-06T21:30:45.123Z');
    const one = backupFile(f, now, { dir });
    const two = backupFile(f, now, { dir, bytes: Buffer.from('{"v":0}') });
    assert.match(one, /\/state\/mcp-tc\/backups\/[0-9a-f]{12}-b\.json\.bak-20261006T213045Z$/);
    assert.equal(two, `${one}-2`);
    assert.equal(readFileSync(one, 'utf8'), '{"v":1}');
    assert.equal(readFileSync(two, 'utf8'), '{"v":0}', 'the bytes add merged, not the file now');
    assert.equal(statSync(one).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('b.json.bak')), [], 'nothing next to the file');
    // the same file under another name (a link) gets the same prefix when the real path is the key
    const k = backupFile(f, now, { dir, key: f });
    assert.equal(k.split('/').pop().slice(0, 12), one.split('/').pop().slice(0, 12));
  });
  it('the backup folder: XDG_STATE_HOME, ~/.local/state, ~/Library/Application Support, %LOCALAPPDATA%', () => {
    assert.equal(backupDir(posix()), '/home/u/.local/state/mcp-tc/backups');
    assert.equal(backupDir(posix({ XDG_STATE_HOME: '/st' })), '/st/mcp-tc/backups');
    assert.equal(backupDir(posix({ XDG_STATE_HOME: 'relative' })), '/home/u/.local/state/mcp-tc/backups');
    assert.equal(backupDir(posix({}, 'darwin')), '/home/u/Library/Application Support/mcp-tc/backups');
    assert.equal(backupDir(win({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })), 'C:\\Users\\u\\AppData\\Local\\mcp-tc\\backups');
    assert.equal(backupDir(win()), 'C:\\Users\\u\\AppData\\Local\\mcp-tc\\backups');
  });
  it('writes through a temporary file, creates the folder, new files are 0600', () => {
    const f = join(tmp, 'deep', 'er', 'w.json');
    writeFileAtomic(f, 'hello\n');
    assert.equal(readFileSync(f, 'utf8'), 'hello\n');
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(tmp, 'deep', 'er')), ['w.json']);
    writeFileAtomic(f, 'again\n', { mode: 0o644 });
    assert.equal(statSync(f).mode & 0o777, 0o644);
  });
  it('finds the git repository a file is in', () => {
    mkdirSync(join(tmp, 'repo', '.git'), { recursive: true });
    mkdirSync(join(tmp, 'repo', 'sub'), { recursive: true });
    assert.equal(gitRepoOf(join(tmp, 'repo', 'sub', 'x.json')), join(tmp, 'repo'));
    assert.equal(gitRepoOf(join(tmp, 'x.json')), null);
  });
  it('decides the repository from where a file really is: a linked file or a linked folder', () => {
    const base = realLocation(mkdtempSync(join(tmp, 'links-')));
    mkdirSync(join(base, 'dotfiles', '.git'), { recursive: true });
    mkdirSync(join(base, 'dotfiles', 'cursor'), { recursive: true });
    writeFileSync(join(base, 'dotfiles', 'cursor', 'mcp.json'), '{}');
    const home = join(base, 'home');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    symlinkSync(join(base, 'dotfiles', 'cursor', 'mcp.json'), join(home, '.cursor', 'mcp.json'));
    symlinkSync(join(base, 'dotfiles', 'cursor'), join(home, '.cursorlink'));
    assert.equal(gitRepoOf(join(home, '.cursor', 'mcp.json')), null, 'the path as written is outside the repository');
    assert.equal(repoForWrite(join(home, '.cursor', 'mcp.json')), join(base, 'dotfiles'));
    assert.equal(repoForWrite(join(home, '.cursorlink', 'mcp.json')), join(base, 'dotfiles'));
    assert.equal(repoForWrite(join(home, '.cursorlink', 'new.json')), join(base, 'dotfiles'), 'a file that does not exist yet, in a linked folder');
    assert.equal(realLocation(join(home, '.cursorlink', 'a', 'b.json')), join(base, 'dotfiles', 'cursor', 'a', 'b.json'));
    const w = { cwd: home, home };
    assert.equal(linkedTarget(join(home, '.cursor', 'mcp.json'), w), join(base, 'dotfiles', 'cursor', 'mcp.json'));
    assert.equal(linkedTarget(join(home, '.cursorlink', 'x.json'), w), join(base, 'dotfiles', 'cursor', 'x.json'));
    assert.equal(linkedTarget(join(home, 'plain.json'), w), null);
    assert.equal(isInside(join(base, 'a', 'b'), join(base, 'a')), true);
    assert.equal(isInside(join(base, 'a'), join(base, 'a')), true);
    assert.equal(isInside(join(base, 'ab'), join(base, 'a')), false);
    assert.equal(isInside(join(base, '..x'), base), true, 'a name that starts with two dots is inside');
  });
});

describe('redactConfig(): the diff shows no other values', () => {
  const data = {
    numStartups: 3,
    mcpServers: {
      a: { command: 'npx', args: ['-y', 'x-mcp', '--api-key', 'SECRETARG123456', '--password', 'hunter2'], env: { OPENAI_KEY: 'abcdefghijklmnopqrstuvwx', DB_PASS: 's3cr3t-Pa55' } },
      b: { url: 'https://u:p@mcp.example.com/v1/mcp?key=FAKE', headers: { 'X-Thing': 'Xq9Lmw2' } },
      c: { url: 'https://hooks.example.com/mcp/FAKEa1b2c3d4e5f6g7h8i9j0k1l2m3/sse', type: 'http' },
      deepwiki: { url: 'https://mcp.deepwiki.com/mcp' },
    },
    inputs: [{ id: 'old', description: 'mine', password: true }, { id: 'new', description: 'theirs', password: true }],
    theme: 'dark-secret-name',
  };
  it('hides every string outside the shown entry; keeps keys, commands, types and URLs without credentials or query', () => {
    const r = redactConfig(data, { container: 'mcpServers', name: 'deepwiki', inputs: ['new'] });
    const text = JSON.stringify(r);
    for (const secret of ['SECRETARG123456', 'hunter2', 'abcdefghijklmnopqrstuvwx', 's3cr3t-Pa55', 'Xq9Lmw2', 'u:p', 'key=FAKE', 'FAKEa1b2', 'dark-secret-name', 'mine']) {
      assert.ok(!text.includes(secret), secret);
    }
    assert.deepEqual(r.mcpServers.a.args, ['<hidden>', '<hidden>', '<hidden>', '<hidden>', '<hidden>', '<hidden>']);
    assert.equal(r.mcpServers.a.command, 'npx');
    assert.deepEqual(Object.keys(r.mcpServers.a.env), ['OPENAI_KEY', 'DB_PASS']);
    assert.equal(r.mcpServers.b.url, 'https://mcp.example.com/v1/mcp?<hidden>');
    assert.equal(r.mcpServers.c.url, 'https://hooks.example.com/<hidden>');
    assert.equal(r.mcpServers.c.type, 'http');
    assert.deepEqual(r.mcpServers.deepwiki, { url: 'https://mcp.deepwiki.com/mcp' });
    assert.equal(r.numStartups, 3);
    assert.deepEqual(r.inputs[1], { id: 'new', description: 'theirs', password: true });
    assert.equal(r.inputs[0].description, '<hidden>');
    assert.deepEqual(data.mcpServers.a.args[3], 'SECRETARG123456', 'the input is not changed');
  });
  it('without a name, the entry with that name is hidden too (the old one being replaced)', () => {
    const r = redactConfig({ mcpServers: { deepwiki: { url: 'https://old.example.com/x', headers: { A: 'B' } } } }, { container: 'mcpServers' });
    assert.deepEqual(r.mcpServers.deepwiki, { url: 'https://old.example.com/x', headers: { A: '<hidden>' } });
  });
});

describe('redaction for printing', () => {
  const hidden = [
    ['"Authorization": "Bearer FAKE-abc"', '"Authorization": "<hidden>"'],
    ['"GITHUB_TOKEN": "ghp_FAKE"', '"GITHUB_TOKEN": "<hidden>"'],
    ['"X-Api-Key": "FAKE-1"', '"X-Api-Key": "<hidden>"'],
    ['  "--api-key=FAKE-2",', '  "--api-key=<hidden>",'],
    ['  "X-Ref-Api-Key: FAKE-3"', '  "X-Ref-Api-Key: <hidden>"'],
    ['  "Authorization: Bearer FAKE-4",', '  "Authorization: <hidden>",'],
    ['  "API_KEY=FAKE-5",', '  "API_KEY=<hidden>",'],
    ['"url": "https://u:p@x.example.com/mcp?key=FAKE"', '"url": "https://<hidden>@x.example.com/mcp?<hidden>"'],
    ['  "abcDEF1234567890ghijKLMN",', '  "<hidden>",'],
  ];
  for (const [line, want] of hidden) it(`hides ${line.trim()}`, () => assert.equal(redactLine(line), want));
  const kept = [
    '"X-Ref-Api-Key": "<YOUR_API_KEY>"',
    '"Authorization": "Bearer ${input:api-key}"',
    '"Authorization": "Bearer <YOUR_API_KEY>"',
    '  "@modelcontextprotocol/server-memory",',
    '  "/home/someone/Documents/very-long-folder-name-2026",',
    '"url": "https://mcp.deepwiki.com/mcp"',
    '"command": "npx",',
    '  "--header",',
    '"mcpServers": {',
  ];
  for (const line of kept) it(`keeps ${line.trim()}`, () => assert.equal(redactLine(line), line));
  it('redactValue and looksLikeToken', () => {
    assert.equal(redactValue('anything', 'password'), '<hidden>');
    assert.equal(looksLikeToken('github-mcp-server-production'), false);
    assert.equal(looksLikeToken('sk1234567890abcdefghij'), true);
  });
});

describe('servers in a file', () => {
  const w = where({ platform: 'linux', env: { HOME: '/home/u' }, cwd: '/work/proj' });
  it("~/.claude.json: user servers and this folder's servers, not other projects'", () => {
    const data = JSON.parse(fixtureText('claude.json').replace('{{CWD}}', '/work/proj'));
    const list = serversIn({ clients: ['claude-code'], label: 'Claude Code', path: '', scope: 'user', format: 'claude' }, data, w);
    assert.deepEqual(list.map((s) => `${s.name}:${s.note || ''}`), ['deepwiki:', 'memory:', 'keyed:this folder']);
  });
  it('VS Code files: "servers"', () => {
    const data = parseJsonc(fixtureText('vscode-mcp.json'));
    const list = serversIn({ clients: ['vscode'], label: 'VS Code', path: '', scope: 'user', format: 'json', container: 'servers' }, data, w);
    assert.deepEqual(list.map((s) => s.name), ['fetch', 'github']);
  });
  it('Codex TOML: [mcp_servers.*]', () => {
    const list = serversIn({ clients: ['codex'], label: 'Codex', path: '', scope: 'user', format: 'toml' }, parseToml(fixtureText('codex-config.toml')), w);
    assert.deepEqual(list.map((s) => s.name), ['docs', 'fs', 'docker-fetch']);
  });
  it('describeServer reads URL fields and commands, never headers or env', () => {
    assert.deepEqual(describeServer({ serverUrl: 'https://a.example.com/mcp', headers: { k: 'v' } }), { transport: 'http', url: 'https://a.example.com/mcp', command: null, args: [] });
    assert.equal(describeServer({ url: 'https://a.example.com/sse' }, 'gemini').transport, 'sse');
    assert.equal(describeServer({ httpUrl: 'https://a.example.com/mcp' }, 'gemini').transport, 'http');
    assert.equal(describeServer({ type: 'sse', url: 'https://a.example.com/sse' }).transport, 'sse');
    assert.deepEqual(describeServer({ command: 'npx', args: ['-y', 'x', 3], env: { K: 'v' } }), { transport: 'stdio', url: null, command: 'npx', args: ['-y', 'x'] });
    assert.equal(describeServer('nope').transport, 'unknown');
  });
});

describe('what scan may send', () => {
  const priv = ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.1.1', '100.64.0.1', '[::1]', 'fd00::1', 'fe80::1', 'intranet', 'nas.local', 'svc.internal', 'router.lan', 'x.home.arpa', 'x.test'];
  // review: Kubernetes, Consul, benchmark and documentation ranges, multicast and broadcast, IPv4-compatible and NAT64
  // IPv6, wildcard DNS names that carry a private address
  priv.push(
    'mcp.default.svc',
    'mcp.default.svc.cluster.local',
    'api.service.consul',
    'box.localdomain',
    'devbox',
    '198.18.0.5',
    '198.19.255.1',
    '192.0.2.10',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.1.2.3',
    '240.0.0.1',
    '255.255.255.255',
    '0.0.0.0',
    '[::7f00:1]',
    '[::a00:1]',
    '[::ffff:7f00:1]',
    '[64:ff9b::a00:1]',
    '[64:ff9b:1::1]',
    '[2001:db8::1]',
    '[ff02::1]',
    '[2002:c0a8:101::1]',
    '10.0.0.1.nip.io',
    '10-0-0-1.sslip.io',
    'app.0a000001.nip.io',
    'whatever.nip.io',
    'app.localtest.me',
  );
  for (const h of priv) it(`${h} is private`, () => assert.equal(isPrivateHost(h), true));
  for (const h of ['mcp.deepwiki.com', '8.8.8.8', '172.32.0.1', 'example.org', '198.20.0.1', '[2606:4700::1111]', '1.1.1.1.nip.io']) it(`${h} is public`, () => assert.equal(isPrivateHost(h), false));
  it('a tailnet name (.ts.net) names the network and the machine: never sent by scan', () => {
    assert.equal(isRevealingHost('devbox.tail1a2b3.ts.net'), true);
    assert.equal(isRevealingHost('mcp.deepwiki.com'), false);
    assert.deepEqual(urlForLookup('https://devbox.tail1a2b3.ts.net/mcp'), { url: null, reason: 'local_address' });
  });
  it('the review cases are never sent', () => {
    for (const u of ['http://devbox.tail1a2b3.ts.net:3000/mcp', 'http://mcp.default.svc:8080/mcp', 'http://[::127.0.0.1]:3000/mcp', 'http://198.18.0.5/mcp', 'http://[64:ff9b::a00:1]/mcp', 'http://10.0.0.1.nip.io/mcp', 'https://224.0.0.1/mcp', 'https://255.255.255.255/mcp']) {
      assert.equal(urlForLookup(u).url, null, u);
    }
  });
  it('plain http:// public URLs are not sent (public MCP servers use https)', () => {
    assert.deepEqual(urlForLookup('http://mcp.example.org/mcp'), { url: null, reason: 'not_https' });
    assert.equal(urlForLookup('https://mcp.example.org/mcp').url, 'https://mcp.example.org/mcp');
  });
  it('placeholders of any form in a URL: not sent', () => {
    for (const u of ['https://api.example.com/YOUR_TENANT/mcp', 'https://api.example.com/<tenant>/mcp']) assert.deepEqual(urlForLookup(u), { url: null, reason: 'has_variables' });
  });
  it('an mcp.tc listing link is a listing target: nothing to send', () => {
    const listingSlug = (u) => (/^https:\/\/mcp\.tc\/i\/([a-z0-9-]+)$/.exec(u) || [])[1] || null;
    assert.deepEqual(lookupTarget({ transport: 'http', url: 'https://mcp.tc/i/deepwiki', command: null, args: [] }, { listingSlug }), { type: 'listing', slug: 'deepwiki' });
    assert.deepEqual(lookupTarget({ transport: 'stdio', url: null, command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.tc/i/notion'] }, { listingSlug }), { type: 'listing', slug: 'notion' });
    assert.equal(lookupTarget({ transport: 'http', url: 'https://mcp.tc/i/deepwiki', command: null, args: [] }).type, 'url', 'without the option: an address like any other');
  });

  it('URLs lose credentials, query and fragment', () => {
    assert.deepEqual(urlForLookup('https://u:p@mcp.example.org/v1/mcp?api_key=FAKE#x'), { url: 'https://mcp.example.org/v1/mcp', trimmed: ['credentials', 'query', 'fragment'] });
    assert.deepEqual(urlForLookup('https://mcp.deepwiki.com/'), { url: 'https://mcp.deepwiki.com', trimmed: [] });
  });
  it('a key in the path: only scheme and host', () => {
    for (const u of [
      'https://hooks.example.com/mcp/FAKEa1b2c3d4e5f6g7h8i9j0k1l2m3/sse',
      'https://x.example.com/123e4567-e89b-12d3-a456-426614174000/mcp',
      'https://x.example.com/key=abc/mcp',
      'https://x.example.com/sk-FAKE12345678/mcp',
    ]) {
      const r = urlForLookup(u);
      assert.equal(r.url, new URL(u).origin, u);
      assert.ok(r.trimmed.includes('path'));
    }
  });
  it('local, variable and non-http URLs are not sent', () => {
    assert.deepEqual(urlForLookup('http://localhost:3000/mcp'), { url: null, reason: 'local_address' });
    assert.deepEqual(urlForLookup('https://${HOST}/mcp'), { url: null, reason: 'has_variables' });
    assert.deepEqual(urlForLookup('https://api.example.com/<YOUR_TENANT>/mcp'), { url: null, reason: 'has_variables' });
    assert.deepEqual(urlForLookup('ws://mcp.example.com/'), { url: null, reason: 'not_http' });
  });

  const cases = [
    ['npx', ['-y', '@modelcontextprotocol/server-memory'], { type: 'package', registry: 'npm', name: '@modelcontextprotocol/server-memory' }],
    ['npx', ['-y', '@scope/pkg@1.2.3', '--token', 'FAKE'], { type: 'package', registry: 'npm', name: '@scope/pkg' }],
    ['npx', ['--yes', 'some-mcp@latest', 'FAKEARG'], { type: 'package', registry: 'npm', name: 'some-mcp' }],
    ['npx', ['--package=real-pkg', 'binary'], { type: 'package', registry: 'npm', name: 'real-pkg' }],
    ['npx', ['-p', 'real-pkg', 'binary'], { type: 'package', registry: 'npm', name: 'real-pkg' }],
    ['npx', ['-y', '--registry', 'https://registry.example.com', 'pkg-a'], { type: 'package', registry: 'npm', name: 'pkg-a' }],
    ['npx', ['-y', 'mcp-remote', 'https://mcp.example.com/mcp?token=FAKE', '--header', 'Authorization: Bearer FAKE'], { type: 'url', url: 'https://mcp.example.com/mcp', trimmed: ['query'] }],
    ['npx', ['github:example-org/example-mcp'], { type: 'repo', url: 'https://github.com/example-org/example-mcp' }],
    ['npx', ['example-org/example-mcp'], { type: 'repo', url: 'https://github.com/example-org/example-mcp' }],
    ['npx', ['./local/server.js'], { type: 'skip', reason: 'local_path' }],
    ['/usr/local/bin/npx.cmd', ['-y', 'pkg-b'], { type: 'package', registry: 'npm', name: 'pkg-b' }],
    ['cmd', ['/c', 'npx', '-y', 'pkg-c'], { type: 'package', registry: 'npm', name: 'pkg-c' }],
    ['bunx', ['pkg-d'], { type: 'package', registry: 'npm', name: 'pkg-d' }],
    ['pnpm', ['dlx', 'pkg-e'], { type: 'package', registry: 'npm', name: 'pkg-e' }],
    ['npm', ['exec', '--', 'pkg-f'], { type: 'package', registry: 'npm', name: 'pkg-f' }],
    ['uvx', ['mcp-server-fetch==2025.4.7'], { type: 'package', registry: 'pypi', name: 'mcp-server-fetch' }],
    ['uvx', ['--from', 'awslabs.aws-docs[cli]>=1.0', 'aws-docs'], { type: 'package', registry: 'pypi', name: 'awslabs.aws-docs' }],
    ['uvx', ['--from', 'git+https://github.com/example-org/example-mcp@v1', 'example-mcp'], { type: 'repo', url: 'https://github.com/example-org/example-mcp' }],
    ['uv', ['tool', 'run', '--python', '3.12', 'pkg-g'], { type: 'package', registry: 'pypi', name: 'pkg-g' }],
    ['pipx', ['run', '--spec', 'pkg-h==2', 'binary'], { type: 'package', registry: 'pypi', name: 'pkg-h' }],
    ['docker', ['run', '-i', '--rm', '-e', 'API_KEY=FAKE', 'mcp/fetch'], { type: 'package', registry: 'oci', name: 'mcp/fetch' }],
    ['docker', ['run', '-i', '--env-file', '/home/x/.env', 'docker.io/mcp/github:latest'], { type: 'package', registry: 'oci', name: 'mcp/github' }],
    ['docker', ['run', 'ghcr.io/example/server'], { type: 'skip', reason: 'image_registry' }],
    ['docker', ['run', '--rm', 'ubuntu'], { type: 'skip', reason: 'no_package' }],
    ['node', ['/home/x/server.js', '--key', 'FAKE'], { type: 'skip', reason: 'local_command' }],
    ['python', ['-m', 'server'], { type: 'skip', reason: 'local_command' }],
  ];
  for (const [cmd, args, want] of cases) {
    it(`${cmd} ${args.join(' ')}`, () => assert.deepEqual(packageFromCommand(cmd, args), want));
  }
});

describe('parseToml()', () => {
  it("reads Codex's config: tables, arrays over several lines, inline tables, comments, quoted keys", () => {
    const t = parseToml(fixtureText('codex-config.toml'));
    assert.equal(t.model, 'some-model');
    assert.deepEqual(t.mcp_servers.fs.args, ['-y', '@modelcontextprotocol/server-filesystem', '/home/someone/Documents']);
    assert.deepEqual(t.mcp_servers.fs.env, { FS_TOKEN: 'FAKE-toml-token-4444444444' });
    assert.equal(t.mcp_servers['docker-fetch'].command, 'docker');
    assert.equal(t.mcp_servers.docs.url, 'https://mcp.deepwiki.com/mcp');
    assert.equal(t.mcp_servers.docs.tools.enabled, true);
  });
  it('escapes, numbers, dotted keys; skips lines it cannot read', () => {
    const t = parseToml('a = "x\\ty\\u0041"\nb = 1_000\nc.d = false\n!!! junk\n[t]\ne = [1, "two"]\n[[arr]]\nf = 1\n');
    assert.deepEqual(t, { a: 'x\tyA', b: 1000, c: { d: false }, t: { e: [1, 'two'] } });
  });
  it('never sets __proto__', () => {
    const t = parseToml('[__proto__]\npolluted = true\n');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.keys(t).length, 0);
  });
});
