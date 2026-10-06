import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDirectory, runCli, fixture, GONE_SLUG } from './helpers/fake-directory.js';
import { render, toolHints, when } from '../src/commands/info.js';
import { createOutput } from '../src/lib/output.js';

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(() => fake.close());
beforeEach(() => fake.reset());
const cli = (argv) => runCli(argv, { base: fake.base });
const sentSlug = () => JSON.parse(fake.requests.at(-1).body).params.arguments.slug;

/** Render a get_server result to plain text. */
function renderText(d, columns = '100') {
  let text = '';
  const stream = { isTTY: false, write: (s) => ((text += s), true) };
  render(d, createOutput({ stdout: stream, stderr: stream, env: { COLUMNS: columns } }));
  return text;
}

describe('mcp-tc info', () => {
  it('remote, no sign-in: URL, access, checkmark, check, tools, link', async () => {
    const r = await cli(['info', 'deepwiki']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^DeepWiki \u2713$/m);
    assert.match(r.stdout, /^Vendor\s+Cognition$/m);
    assert.match(r.stdout, /^Category\s+Docs & Knowledge \(docs-knowledge\)$/m);
    assert.match(r.stdout, /^Access\s+No sign-in: add the server URL/m);
    assert.match(r.stdout, /^Server URL\s+https:\/\/mcp\.deepwiki\.com\/mcp$/m);
    assert.match(r.stdout, /^Checkmark\s+Verified by mcp\.tc: official server from Cognition$/m);
    assert.match(r.stdout, /^Last check\s+2026-10-05 22:43 UTC, answered$/m);
    assert.match(r.stdout, /^Listing\s+https:\/\/mcp\.tc\/i\/deepwiki$/m);
    assert.match(r.stdout, /^Tools \(3\)$/m);
    assert.match(r.stdout, /^ {2}ask_wiki_question\s+Ask a question/m);
    assert.match(r.stdout, /^Add it to a client: mcp-tc add deepwiki --client <id>$/m);
    assert.doesNotMatch(r.stdout, /^History/m, 'no History fields in this recording');
  });

  it('OAuth: says Sign-in and why there are no tools', async () => {
    const r = await cli(['info', 'notion']);
    assert.match(r.stdout, /^Access\s+Sign-in\. OAuth: the client opens Notion's sign-in/m);
    assert.match(r.stdout, /^Last check\s+.*answered and asked for sign-in$/m);
    assert.match(r.stdout, /Servers that need sign-in often show their tools only after it\./);
  });

  it('local package: install command instead of a URL', async () => {
    const r = await cli(['info', 'memory']);
    assert.match(r.stdout, /^Access\s+Local\. Runs on your computer/m);
    assert.match(r.stdout, /^Install\s+npx -y @modelcontextprotocol\/server-memory$/m);
    assert.doesNotMatch(r.stdout, /^Server URL/m);
    assert.doesNotMatch(r.stdout, /^Package/m);
  });

  it('API key: header names only, never values', async () => {
    const r = await cli(['info', 'ref-tools']);
    assert.match(r.stdout, /^Access\s+API key\. Needs an API key from Ref, sent in the X-Ref-Api-Key header\.$/m);
    assert.match(r.stdout, /^Headers\s+X-Ref-Api-Key \(required, secret\)$/m);
    assert.match(r.stdout, /^Checkmark\s+Not verified$/m);
  });

  it('tool hints from annotations', async () => {
    const r = await cli(['info', 'mcp-tc']);
    assert.match(r.stdout, /^ {2}search_servers\s+read-only\s+Find MCP servers/m);
    assert.equal(toolHints({ read_only: true, destructive: false }), 'read-only');
    assert.equal(toolHints({ read_only: false, destructive: true }), 'destructive');
    assert.equal(toolHints({ read_only: false, destructive: false }), 'writes');
    assert.equal(toolHints({ read_only: null, destructive: null }), '');
  });

  it('takes a name or a listing link; links are sent as the slug', async () => {
    await cli(['info', 'https://mcp.tc/it/i/notion']);
    assert.equal(sentSlug(), 'notion');
    await cli(['info', 'mcp.tc/i/memory']);
    assert.equal(sentSlug(), 'memory');
    await cli(['info', 'Deep', 'Wiki']);
    assert.equal(sentSlug(), 'Deep Wiki');
  });

  it('--json returns get_server structuredContent', async () => {
    const r = await cli(['info', 'deepwiki', '--json']);
    const { ok, command, ...rest } = r.json();
    assert.equal(ok, true);
    assert.equal(command, 'info');
    assert.deepEqual(rest, fixture('mcp-get-deepwiki').message.result.structuredContent);
  });

  it('unknown and removed listings: exit 3', async () => {
    const a = await cli(['info', 'zz-none', '--json']);
    assert.equal(a.code, 3);
    assert.equal(a.json().error.code, 'not_found');
    const b = await cli(['info', GONE_SLUG, '--json']);
    assert.equal(b.code, 3);
    assert.equal(b.json().error.code, 'gone');
    const c = await cli(['info', 'zz-none']);
    assert.match(c.stderr, /^Error: No listing for "zz-none" on .*Find the slug with: mcp-tc search <words>/);
  });

  it('missing argument: exit 2', async () => {
    const r = await cli(['info']);
    assert.equal(r.code, 2);
    // ux-help-usage-inaccurate: the error names the argument the way the usage line does
    assert.match(r.stderr, /Missing <slug\|name\|link>\. Usage: mcp-tc info <slug\|name\|link>/);
  });

  it('shows the History fields when mcp.tc sends them (and works without them)', () => {
    const d = structuredClone(fixture('mcp-get-deepwiki').message.result.structuredContent);
    Object.assign(d, {
      history_url: 'https://mcp.tc/i/deepwiki#history',
      history_feed: 'https://mcp.tc/i/deepwiki/history.xml',
      tracking: 'tools',
      tools_checked: '2026-10-06T09:00:00Z',
      last_changed: '2026-10-01T12:30:00Z',
      recent_changes: [{ at: '2026-10-01T12:30:00Z', kind: 'tools', source: 'Automatic check', summary: '1 tool added: read_wiki_contents' }],
    });
    const t = renderText(d);
    assert.match(t, /^History\s+https:\/\/mcp\.tc\/i\/deepwiki#history$/m);
    assert.match(t, /^Tracked\s+Tool list, version and listing edits$/m);
    assert.match(t, /^Tools read\s+2026-10-06 09:00 UTC$/m);
    assert.match(t, /^Last change\s+2026-10-01 12:30 UTC$/m);
    assert.match(t, /^Recent changes$/m);
    assert.match(t, /2026-10-01 12:30 UTC\s+tools\s+Automatic check\s+1 tool added: read_wiki_contents/);
    // null History fields are simply left out
    const t2 = renderText({ ...d, history_url: null, tracking: null, tools_checked: null, last_changed: null, recent_changes: [] });
    assert.doesNotMatch(t2, /^(History|Tracked|Tools read|Last change|Recent changes)/m);
  });

  it('cleans untrusted text', () => {
    const d = structuredClone(fixture('mcp-get-deepwiki').message.result.structuredContent);
    d.name = 'Deep\u001b[31mWiki';
    d.description = 'Line\u0007 one\u202E';
    d.tools[0].summary = 'x\u001b]52;c;Zm9v\u0007y';
    const t = renderText(d);
    assert.ok(!/[\u001b\u0007\u202E]/.test(t));
  });

  it('formats times', () => {
    assert.equal(when('2026-10-05T22:43:54Z'), '2026-10-05 22:43 UTC');
    assert.equal(when(null), '');
    assert.equal(when('yesterday'), 'yesterday');
  });
});

describe('info: review fixes', () => {
  it('security-doctor-creds-sent-to-mcptc: a URL, credential or token is refused before any request and not repeated', async () => {
    for (const input of ['admin:Sup3rSecret@mcp.internal.example.com/mcp', 'https://user:pw@mcp.example.com/mcp', 'ghp_FAKEtoken1234567890abcd', 'key=value', '123e4567-e89b-12d3-a456-426614174000']) {
      fake.reset();
      const r = await cli(['info', input, '--json']);
      assert.equal(r.code, 2, input);
      assert.equal(r.json().error.code, 'invalid_listing', input);
      assert.deepEqual(fake.requests, [], `${input}: nothing sent to mcp.tc`);
      assert.ok(!r.stdout.includes(input));
    }
    // names, slugs and listing links still go through
    for (const [input, slug] of [['GitHub MCP', 'GitHub MCP'], ['hugging-face', 'hugging-face'], ["Weights & Biases (Official)", 'Weights & Biases (Official)'], [`${'https://mcp.tc'}/i/deepwiki`, 'deepwiki']]) {
      fake.reset();
      await cli(['info', input]);
      assert.equal(sentSlug(), slug);
    }
  });

  it('ux-table-truncation: capability and prompt bullets wrap; tool names are never cut', () => {
    const d = structuredClone(fixture('mcp-get-deepwiki').message.result.structuredContent);
    d.capabilities = [`Read ${'very '.repeat(30)}long capability text`];
    d.example_prompts = [`Ask ${'quite '.repeat(25)}a long question`];
    d.tools[0].name = 'a_really_long_tool_name_that_people_must_type_exactly_as_it_is';
    const narrow = renderText(d, '60');
    for (const line of narrow.split('\n').filter((l) => /^ {2}(- | {2})/.test(l) && !/\S {2,}\S/.test(l))) assert.ok(line.length <= 60, line);
    assert.match(narrow, /^ {2}- Read very very/m);
    assert.match(narrow, /^ {4}very /m, 'continuation lines hang under the text');
    assert.ok(narrow.includes('a_really_long_tool_name_that_people_must_type_exactly_as_it_is'));
  });
});
