import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDirectory, runCli, fixture } from './helpers/fake-directory.js';
import { displayWidth } from '../src/lib/output.js';

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(() => fake.close());
beforeEach(() => fake.reset());
const cli = (argv, env) => runCli(argv, { base: fake.base, env });
const sentArgs = () => JSON.parse(fake.requests.at(-1).body).params.arguments;

describe('mcp-tc search', () => {
  it('prints a table with the checkmark, slug, access state and tagline', async () => {
    const r = await cli(['search', 'github']);
    assert.equal(r.code, 0);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^9 servers match "github", featured first\. Showing 5\.$/);
    assert.match(r.stdout, /^Name\s+Slug\s+Access\s+Tagline$/m);
    assert.match(r.stdout, /^DeepWiki \u2713\s+deepwiki\s+No sign-in\s+Ask questions/m);
    assert.match(r.stdout, /^GitHub \u2713\s+github\s+Sign-in\s+/m);
    assert.match(r.stdout, /^GitMCP\s+gitmcp\s+No sign-in/m);
    assert.match(r.stdout, /^Awesome Copilot\s+awesome-copilot\s+Local\s+/m);
    assert.match(r.stdout, /\u2713 Verified: the checkmark says who runs the server, not that it is safe\./);
    assert.match(r.stdout, /^More results on mcp\.tc: https:\/\/mcp\.tc\/directory\?q=github/m);
    assert.match(r.stdout, /^Details and setup: mcp-tc info <slug>$/m);
    assert.equal(r.stderr, '');
  });

  it('shows API key and Sign-in optional states', async () => {
    const r = await cli(['search', 'search', '--auth', 'sign-in', '--limit', '8']);
    assert.match(r.stdout, /^Ref\s+ref-tools\s+API key\s+/m);
    assert.match(r.stdout, /^Hugging Face\s+\u2713?\s*hugging-face\s+Sign-in optional\s+/m);
    assert.match(r.stdout, /that need sign-in or a key/);
  });

  it('cuts taglines to the terminal width', async () => {
    const r = await cli(['search', 'github'], { COLUMNS: '60' });
    for (const line of r.stdout.split('\n').filter((l) => !l.startsWith('More results'))) {
      assert.ok(displayWidth(line) <= 80, line);
    }
    const tableLines = r.stdout.split('\n').slice(2, 8);
    for (const line of tableLines) assert.ok(displayWidth(line) <= 60, line);
    assert.match(r.stdout, /\u2026/);
  });

  it('--json returns the tool result exactly, inside the envelope', async () => {
    const r = await cli(['search', 'github', '--json']);
    const doc = r.json();
    const { ok, command, ...rest } = doc;
    assert.equal(ok, true);
    assert.equal(command, 'search');
    assert.deepEqual(rest, fixture('mcp-search-github').message.result.structuredContent);
    assert.ok(!('__request' in doc));
  });

  it('sends only the arguments given', async () => {
    await cli(['search', 'github', 'issues']);
    assert.deepEqual(sentArgs(), { query: 'github issues' });
    await cli(['search', '--category', 'databases', '--auth', 'none', '--limit', '3']);
    assert.deepEqual(sentArgs(), { category: 'databases', auth: 'none', limit: 3 });
    await cli(['search']);
    assert.deepEqual(sentArgs(), {});
  });

  it('applies --limit', async () => {
    const r = await cli(['search', 'github', '--limit', '2', '--json']);
    assert.equal(r.json().results.length, 2);
  });

  it('says so when nothing matches (exit 0)', async () => {
    const r = await cli(['search', 'zzqqxx']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^No servers match "zzqqxx"\. Try fewer or other words/m);
    const j = await cli(['search', 'zzqqxx', '--json']);
    assert.deepEqual(j.json().results, []);
    assert.equal(j.json().total, 0);
  });

  it('usage errors: exit 2', async () => {
    for (const argv of [
      ['search', 'x', '--limit', '0'],
      ['search', 'x', '--limit', '26'],
      ['search', 'x', '--limit', 'ten'],
      ['search', 'x', '--auth', 'oauth'],
      ['search', 'x'.repeat(101)],
    ]) {
      const r = await cli([...argv, '--json']);
      assert.equal(r.code, 2, argv.join(' '));
      assert.equal(r.json().ok, false);
    }
    assert.equal(fake.requests.length, 0, 'no request for bad arguments');
  });

  it('an unknown category comes back as a usage error with mcp.tc\'s message', async () => {
    const r = await cli(['search', '--category', 'nope-cat', '--json']);
    assert.equal(r.code, 2);
    assert.equal(r.json().error.code, 'invalid_argument');
    assert.match(r.json().error.message, /Unknown category "nope-cat"/);
  });

  it('never prints escape sequences from listing text', async () => {
    const { render } = await import('../src/commands/search.js');
    const { createOutput } = await import('../src/lib/output.js');
    let text = '';
    const stream = { isTTY: false, write: (s) => ((text += s), true) };
    const out = createOutput({ stdout: stream, stderr: stream, env: {} });
    render({ total: 1, count: 1, results: [{ name: 'Evil\u001b]8;;http://x\u0007', slug: 'evil', tagline: 'a\u001b[2Jb\u202Ec', auth: 'none', kind: 'remote', verified: false }], more_url: null }, out);
    assert.ok(!/[\u001b\u0007\u202E]/.test(text), JSON.stringify(text));
  });
});

describe('search: review fixes', () => {
  const results = () => fixture('mcp-search-github').message.result.structuredContent.results;

  it('ux-table-truncation: a narrow terminal never cuts a slug or drops the checkmark', async () => {
    const r = await cli(['search', 'github'], { COLUMNS: '40' });
    assert.equal(r.code, 0);
    for (const x of results()) {
      assert.match(r.stdout, new RegExp(`\\s${x.slug}(\\s|$)`, 'm'), `slug ${x.slug} is whole`);
    }
    const verified = results().filter((x) => x.verified).length;
    const rows = r.stdout.split('\n').slice(3, 3 + results().length);
    assert.equal(rows.filter((l) => l.includes('\u2713')).length, verified, 'every verified row keeps its checkmark');
  });

  it('ux-table-truncation: output that is not a terminal (and no COLUMNS) is never cut', async () => {
    const r = await cli(['search', 'github'], { COLUMNS: undefined });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('\u2026'), r.stdout);
    for (const x of results()) assert.ok(r.stdout.includes(x.tagline), x.slug);
  });

  it('ux-help-usage-inaccurate: the usage shows the query as optional, with every option', async () => {
    const h = await cli(['search', '--help']);
    assert.match(h.stdout, /^Usage: mcp-tc search \[query\] \[--category <slug>\] \[--auth none\|sign-in\|local\] \[--limit <n>\]$/m);
    assert.match(h.stdout, /Exit codes:\n {2}0 {2}done, also when nothing matches\n {2}1 {2}error.*\n {2}2 {2}usage error.*\n {2}4 {2}mcp\.tc kept limiting requests/);
  });
});
