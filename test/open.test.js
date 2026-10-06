import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startFakeDirectory, runCli, GONE_SLUG } from './helpers/fake-directory.js';
import { openerFor, windowsDir } from '../src/commands/open.js';

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(() => fake.close());
beforeEach(() => fake.reset());

/** A spawn() stand-in that records calls; `fail` makes the child emit ENOENT like a missing program. */
function fakeSpawn({ fail = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefed = true;
    };
    setImmediate(() => (fail ? child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })) : child.emit('spawn')));
    calls.at(-1).child = child;
    return child;
  };
  return { spawn, calls };
}
const run = (argv, extra = {}) => runCli(argv, { base: fake.base, platform: 'linux', env: { DISPLAY: ':0' }, ...extra });

describe('openerFor()', () => {
  it('uses the system opener, never a shell', () => {
    assert.deepEqual(openerFor('darwin', {}), { command: 'open', args: [] });
    assert.deepEqual(openerFor('win32', { SystemRoot: 'C:\\Windows' }), { command: 'C:\\Windows\\System32\\rundll32.exe', args: ['url.dll,FileProtocolHandler'] });
    assert.deepEqual(openerFor('linux', { DISPLAY: ':0' }), { command: 'xdg-open', args: [] });
    assert.deepEqual(openerFor('linux', { WAYLAND_DISPLAY: 'wayland-0' }), { command: 'xdg-open', args: [] });
    assert.equal(openerFor('linux', {}), null);
    assert.equal(openerFor('freebsd', {}), null);
  });
});

describe('Windows: the opener by its full path, never from the current folder', () => {
  // Windows looks for a bare program name in the current folder before PATH: a rundll32.exe in a cloned repository
  // would run. The opener is started by its absolute path under %SystemRoot%.
  it('absolute rundll32 path from SystemRoot (or windir), C:\\Windows otherwise', () => {
    assert.equal(openerFor('win32', { SystemRoot: 'D:\\Win' }).command, 'D:\\Win\\System32\\rundll32.exe');
    assert.equal(openerFor('win32', { windir: 'E:\\W' }).command, 'E:\\W\\System32\\rundll32.exe');
    assert.equal(openerFor('win32', {}).command, 'C:\\Windows\\System32\\rundll32.exe');
    // a relative or odd value is never used: it could point into the current folder
    for (const bad of ['.', '.\\x', 'Windows', '\\\\host\\share', '']) assert.equal(windowsDir({ SystemRoot: bad }), 'C:\\Windows', bad);
  });
  it('spawns that path, and its children are told not to search the current folder', async () => {
    const f = fakeSpawn();
    const r = await runCli(['open', 'deepwiki'], { base: fake.base, platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATH: '.;C:\\bin' }, spawn: f.spawn });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(f.calls[0].command, 'C:\\Windows\\System32\\rundll32.exe');
    assert.deepEqual(f.calls[0].args, ['url.dll,FileProtocolHandler', `${fake.base}/i/deepwiki`]);
    assert.equal(f.calls[0].options.shell, false);
    assert.equal(f.calls[0].options.env.NoDefaultCurrentDirectoryInExePath, '1');
  });
});

describe('open: help', () => {
  it('the usage line lists every option', async () => {
    const r = await runCli(['help', 'open']);
    assert.match(r.stdout, /mcp-tc open <slug> \[--lang en\|it\|fr\|de\|es\] \[--print\]/);
  });
});

describe('mcp-tc open', () => {
  it('opens the listing page with a detached opener and no shell', async () => {
    const f = fakeSpawn();
    const r = await run(['open', 'deepwiki'], { spawn: f.spawn });
    assert.equal(r.code, 0);
    assert.equal(f.calls.length, 1);
    const c = f.calls[0];
    assert.equal(c.command, 'xdg-open');
    assert.deepEqual(c.args, [`${fake.base}/i/deepwiki`]);
    assert.equal(c.options.detached, true);
    assert.equal(c.options.shell, false);
    assert.equal(c.options.stdio, 'ignore');
    assert.equal(c.child.unrefed, true);
    assert.equal(r.stdout.trim(), `Opened ${fake.base}/i/deepwiki`);
    // it checked that the listing exists first, without downloading it
    assert.equal(fake.requests[0].method, 'HEAD');
    assert.equal(fake.requests[0].path, '/i/deepwiki.json');
  });

  it('--lang opens the page in that language; a localized link keeps its language', async () => {
    const f = fakeSpawn();
    await run(['open', 'deepwiki', '--lang', 'it'], { spawn: f.spawn });
    assert.deepEqual(f.calls[0].args, [`${fake.base}/it/i/deepwiki`]);
    await run(['open', 'https://mcp.tc/de/i/memory'], { spawn: f.spawn });
    assert.deepEqual(f.calls[1].args, [`${fake.base}/de/i/memory`]);
    await run(['open', 'deepwiki', '--lang', 'en'], { spawn: f.spawn });
    assert.deepEqual(f.calls[2].args, [`${fake.base}/i/deepwiki`]);
  });

  it('--json prints the link and opens nothing', async () => {
    const f = fakeSpawn();
    const r = await run(['open', 'deepwiki', '--json'], { spawn: f.spawn });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(r.json(), { ok: true, command: 'open', url: `${fake.base}/i/deepwiki`, opened: false });
  });

  it('--print prints the link and opens nothing', async () => {
    const f = fakeSpawn();
    const r = await run(['open', 'deepwiki', '--print'], { spawn: f.spawn });
    assert.equal(f.calls.length, 0);
    assert.equal(r.stdout.trim(), `${fake.base}/i/deepwiki`);
  });

  it('without a display it prints the link', async () => {
    const f = fakeSpawn();
    const r = await runCli(['open', 'deepwiki'], { base: fake.base, platform: 'linux', env: {}, spawn: f.spawn });
    assert.equal(r.code, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(r.stdout.trim(), `${fake.base}/i/deepwiki`);
    assert.match(r.stderr, /No display found/);
  });

  it('when the opener is missing it prints the link', async () => {
    const f = fakeSpawn({ fail: true });
    const r = await run(['open', 'deepwiki'], { spawn: f.spawn });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), `${fake.base}/i/deepwiki`);
    assert.match(r.stderr, /Could not start a browser/);
  });

  it('unknown or removed listing: exit 3 and nothing opened', async () => {
    const f = fakeSpawn();
    const a = await run(['open', 'zz-none', '--json'], { spawn: f.spawn });
    assert.equal(a.code, 3);
    assert.equal(a.json().error.code, 'not_found');
    const b = await run(['open', GONE_SLUG], { spawn: f.spawn });
    assert.equal(b.code, 3);
    assert.equal(f.calls.length, 0);
  });

  it('refuses names that are not slugs and bad languages (exit 2)', async () => {
    const f = fakeSpawn();
    for (const argv of [['open', 'GitHub MCP'], ['open', 'x;rm -rf'], ['open', 'deepwiki', '--lang', 'pt'], ['open']]) {
      const r = await run(argv, { spawn: f.spawn });
      assert.equal(r.code, 2, argv.join(' '));
    }
    assert.equal(f.calls.length, 0);
    assert.equal(fake.requests.length, 0);
  });
});
