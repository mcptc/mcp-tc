import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE } from '../src/commands/check.js';
import { CARD_SCHEMA, SERVER_JSON_SCHEMA } from '../src/commands/card.js';
import { EXIT } from '../src/lib/errors.js';
import { runCli } from './helpers/fake-directory.js';
import { GOOD_TOOLS, startFakeMcp } from './helpers/fake-mcp.js';

const CARD = { $schema: CARD_SCHEMA, name: 'com.example/fake-docs', title: 'Fake Docs', description: 'Search and read the Fake Docs documentation.', version: '1.2.3' };

/** @param {string[]} args @param {{cwd?: string, base?: string}} [o] */
const check = (args, o = {}) => runCli(['check', ...args], { cwd: o.cwd, env: o.base ? { MCPTC_BASE_URL: o.base } : {} });

/**
 * Run check --json against a fake with these options; returns the document, the exit code and the fake's requests.
 * The fake runs on 127.0.0.1, so check also runs the DNS rebinding test: it refuses a foreign Host and Origin unless
 * the options say otherwise.
 */
async function checkFake(opts, extra = []) {
  const f = await startFakeMcp({ hostCheck: true, originCheck: true, ...opts });
  try {
    const r = await check([f.url, ...extra, '--json']);
    return { code: r.code, doc: r.json(), requests: f.requests, url: f.url, stdout: r.stdout, stderr: r.stderr };
  } finally {
    await f.close();
  }
}

/** @param {any} doc */
const ids = (doc, level) => doc.findings.filter((x) => !level || x.level === level).map((x) => x.id);

const dirs = [];
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcptc-check-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PKG = {
  name: 'fake-docs-mcp',
  version: '1.2.3',
  description: 'Search and read the Fake Docs documentation.',
  mcpName: 'com.example/fake-docs',
  bin: { 'fake-docs-mcp': 'bin/server.js' },
  repository: 'github:example/fake-docs-mcp',
  homepage: 'https://docs.example.com',
  license: 'MIT',
};
const SJ = {
  $schema: SERVER_JSON_SCHEMA,
  name: 'com.example/fake-docs',
  description: 'Search and read the Fake Docs documentation.',
  version: '1.2.3',
  packages: [{ registryType: 'npm', identifier: 'fake-docs-mcp', version: '1.2.3', transport: { type: 'stdio' } }],
};

describe('mcp-tc check <url>: a good server', () => {
  it('no errors and no warnings: exit 0, both eras, card, DNS rebinding refused', async () => {
    const r = await checkFake({ card: CARD, hostCheck: true, originCheck: true });
    assert.equal(r.code, 0);
    const d = r.doc;
    assert.equal(d.ok, true);
    assert.equal(d.passed, true);
    assert.equal(d.readable, true);
    assert.equal(d.counts.error, 0);
    assert.equal(d.counts.warning, 0, JSON.stringify(d.findings.filter((x) => x.level === 'warning')));
    for (const id of ['modern', 'legacy', 'server_info', 'tools', 'tools_annotated', 'auth_none', 'card', 'rebinding_origin', 'rebinding_host']) {
      assert.ok(ids(d, 'ok').includes(id), id);
    }
    assert.equal(d.note, NOTE);
    assert.equal(d.target.kind, 'url');
    assert.ok(d.report.mcp);
    assert.deepEqual(d.report.cards.map((c) => [c.found, c.status]), [[true, 200], [false, 404]]);
    assert.ok(!('card' in d.report.cards[0]), 'the raw card stays out of the summary');
    assert.deepEqual(Object.keys(d.counts), ['error', 'warning', 'suggestion', 'ok']);
    const levels = d.findings.map((x) => x.level);
    assert.deepEqual(levels, [...levels].sort((a, b) => ['error', 'warning', 'suggestion', 'ok'].indexOf(a) - ['error', 'warning', 'suggestion', 'ok'].indexOf(b)));
  });

  it('human output: report lines, findings, summary and the note about review', async () => {
    const f = await startFakeMcp({ card: CARD, hostCheck: true, originCheck: true });
    try {
      const r = await check([f.url]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^Checked http:\/\/127\.0\.0\.1:\d+\/mcp/);
      assert.match(r.stdout, /Protocol\s+2026-07-28 \(server\/discover\)/);
      assert.match(r.stdout, /^ {2}ok {4}Answers server\/discover/m);
      assert.match(r.stdout, /0 errors, 0 warnings, \d+ suggestions?\./);
      // rules-5: the public docs say a person reviews a suggestion only when needed
      assert.match(r.stdout, /On mcp\.tc an AI model checks each suggestion and a person may review it; check doesn't predict whether the server will be listed\./);
      assert.doesNotMatch(r.stdout, /every suggestion/);
    } finally {
      await f.close();
    }
  });
});

describe('mcp-tc check <url>: tools', () => {
  it('flags missing descriptions, short ones, missing hints, a missing inputSchema, duplicates and nameless entries', async () => {
    const tools = [
      GOOD_TOOLS[0],
      { name: 'no_desc', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'short', description: 'Gets it.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'writer', description: 'Writes a page to the documentation store.', inputSchema: { type: 'object' } },
      { name: 'loose', description: 'A tool that has no input schema at all.', annotations: { readOnlyHint: true } },
      { name: 'short', description: 'Duplicate of short with a long enough description.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { description: 'No name here.' },
      { name: 'has space', description: 'A name with a space in it, which is unusual.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    ];
    const r = await checkFake({ tools });
    assert.equal(r.code, EXIT.PROBLEMS);
    const d = r.doc;
    assert.equal(d.passed, false);
    for (const id of ['tool_input_schema', 'tool_duplicate', 'tool_invalid']) assert.ok(ids(d, 'error').includes(id), id);
    for (const id of ['tool_description_missing', 'tool_description_short', 'tool_read_only_hint', 'tool_destructive_hint', 'tool_name_chars']) assert.ok(ids(d, 'warning').includes(id), id);
    assert.ok(ids(d, 'suggestion').includes('tool_title'));
    const msg = (id) => d.findings.find((x) => x.id === id).message;
    assert.match(msg('tool_description_missing'), /no_desc/);
    assert.match(msg('tool_read_only_hint'), /writer/);
    assert.match(msg('tool_input_schema'), /loose/);
    assert.ok(!ids(d).includes('tools_annotated'));
  });

  it('a server without tools, and one that offers none', async () => {
    const empty = await checkFake({ tools: [] });
    assert.ok(ids(empty.doc, 'warning').includes('tools_none'));
    const none = await checkFake({ capabilities: { prompts: {} }, prompts: [{ name: 'p' }] });
    assert.ok(ids(none.doc, 'ok').includes('no_tools_capability'));
    assert.equal(none.code, 0);
  });

  it('tools/list behind sign-in: a warning, and a hint to pass a token', async () => {
    const r = await checkFake({ auth: 'tools' });
    assert.equal(r.code, 0);
    const w = r.doc.findings.find((x) => x.id === 'tools_need_sign_in');
    assert.equal(w.level, 'warning');
    assert.match(w.message, /--header "Authorization: Bearer YOUR_TOKEN"/);
  });
});

describe('mcp-tc check <url>: protocol and transport', () => {
  it('legacy only: suggests server/discover', async () => {
    const r = await checkFake({ modern: false });
    assert.equal(r.code, 0);
    assert.ok(ids(r.doc, 'suggestion').includes('modern_missing'));
    assert.ok(ids(r.doc, 'ok').includes('legacy'));
  });
  it('2026-07-28 only: warns that most clients still use initialize', async () => {
    const r = await checkFake({ legacy: false });
    assert.ok(ids(r.doc, 'warning').includes('legacy_missing'));
  });
  it('an old protocol version from initialize', async () => {
    const r = await checkFake({ modern: false, legacyVersions: ['2024-11-05'] });
    assert.ok(ids(r.doc, 'suggestion').includes('old_version'));
  });
  it('the HTTP+SSE transport: a warning', async () => {
    const r = await checkFake({ legacySse: true, path: '/sse' });
    assert.equal(r.code, 0);
    assert.ok(ids(r.doc, 'warning').includes('sse_transport'));
  });
  it('a session: ended with DELETE is fine, a DELETE that fails is a warning, 405 is allowed', async () => {
    const good = await checkFake({ modern: false, session: true });
    assert.ok(!ids(good.doc).includes('session_delete'));
    assert.ok(good.requests.some((q) => q.method === 'DELETE'));
    const bad = await checkFake({ modern: false, session: true, deleteStatus: 404 });
    assert.ok(ids(bad.doc, 'warning').includes('session_delete'));
    const allowed = await checkFake({ modern: false, session: true, deleteStatus: 405 });
    assert.ok(!ids(allowed.doc).includes('session_delete'));
  });
});

describe('mcp-tc check <url>: sign-in', () => {
  it('good OAuth metadata: no errors', async () => {
    const r = await checkFake({ auth: 'oauth' });
    assert.equal(r.code, 0, JSON.stringify(r.doc.findings.filter((x) => x.level === 'error')));
    assert.ok(ids(r.doc, 'ok').includes('oauth_metadata'));
    assert.ok(ids(r.doc, 'ok').includes('oauth_registration'));
    assert.ok(ids(r.doc, 'warning').includes('tools_need_sign_in'));
  });
  it('no S256 in the authorization server metadata: an error', async () => {
    const r = await checkFake({ auth: 'oauth', as: { code_challenge_methods_supported: ['plain'] } });
    assert.equal(r.code, EXIT.PROBLEMS);
    assert.ok(ids(r.doc, 'error').includes('oauth_pkce'));
  });
  it('no way for clients to register: a warning', async () => {
    const r = await checkFake({ auth: 'oauth', as: { registration_endpoint: undefined } });
    assert.ok(ids(r.doc, 'warning').includes('oauth_registration'));
  });
  it('metadata for another resource: an error', async () => {
    const r = await checkFake({ auth: 'oauth', prm: { resource: 'http://127.0.0.1:1/elsewhere' } });
    assert.equal(r.code, EXIT.PROBLEMS);
    assert.ok(ids(r.doc, 'error').includes('oauth_resource_mismatch'));
  });
  it('no authorization_servers: an error', async () => {
    const r = await checkFake({ auth: 'oauth', prm: { authorization_servers: [] } });
    assert.ok(ids(r.doc, 'error').includes('oauth_no_authorization_server'));
  });
  it('the challenge without resource_metadata: a suggestion', async () => {
    const r = await checkFake({ auth: 'oauth', prmHeader: false });
    assert.ok(ids(r.doc, 'suggestion').includes('oauth_resource_metadata_param'));
  });
  it('a key or token: ok, and a tip to document the header', async () => {
    const r = await checkFake({ auth: 'apikey' });
    assert.equal(r.code, 0);
    assert.ok(ids(r.doc, 'ok').includes('auth_key'));
    assert.ok(ids(r.doc, 'suggestion').includes('key_header_docs'));
  });
  it('with --header the whole server is checked, and the value is never printed', async () => {
    const r = await checkFake({ auth: 'oauth', card: CARD }, ['--header', 'Authorization: Bearer test-token']);
    assert.equal(r.code, 0);
    assert.ok(ids(r.doc, 'ok').includes('tools'));
    assert.ok(ids(r.doc, 'ok').includes('auth_headers'));
    assert.ok(!r.stdout.includes('test-token'));
  });
  it('a firewall page: not readable, exit 5', async () => {
    const r = await checkFake({ auth: 'waf' });
    assert.equal(r.code, EXIT.UNREACHABLE);
    assert.equal(r.doc.readable, false);
    assert.ok(ids(r.doc, 'error').includes('blocked'));
  });
});

describe('mcp-tc check <url>: the URL, the card, DNS rebinding', () => {
  it('a key in the URL: an error, and the key never printed', async () => {
    const f = await startFakeMcp();
    try {
      const r = await check([`${f.url}?api_key=abcdef123456`, '--json']);
      assert.equal(r.code, EXIT.PROBLEMS);
      assert.ok(ids(r.json(), 'error').includes('secret_in_url'));
      assert.ok(!r.stdout.includes('abcdef123456'));
      const h = await check([`${f.url}?api_key=abcdef123456`]);
      assert.ok(!h.stdout.includes('abcdef123456') && !h.stderr.includes('abcdef123456'));
    } finally {
      await f.close();
    }
  });
  it('a server card with problems, without CORS, with tools, with another version', async () => {
    const bad = { ...CARD, $schema: 'https://example.com/card.json', description: 'x'.repeat(120) };
    const r = await checkFake({ card: bad });
    assert.equal(r.code, EXIT.PROBLEMS);
    const e = r.doc.findings.find((x) => x.id === 'card_invalid');
    assert.match(e.message, /\$schema/);
    assert.match(e.message, /description is 120 characters/);
    const r2 = await checkFake({ card: { ...CARD, tools: [], version: '9.9.9' }, cardCors: false });
    assert.ok(ids(r2.doc, 'warning').includes('card_extra'));
    assert.ok(ids(r2.doc, 'warning').includes('card_cors'));
    assert.ok(ids(r2.doc, 'warning').includes('card_version'));
  });
  it('a card only at the well-known address: suggests the recommended one too', async () => {
    const r = await checkFake({ wellKnownCard: CARD });
    assert.ok(ids(r.doc, 'ok').includes('card'));
    assert.ok(ids(r.doc, 'suggestion').includes('card_location'));
  });
  it('no card: a suggestion with the command to make one', async () => {
    const r = await checkFake({});
    const s = r.doc.findings.find((x) => x.id === 'card_missing');
    assert.match(s.message, /mcp-tc card --url http:\/\/127\.0\.0\.1:\d+\/mcp/);
  });
  it('a server on this computer that accepts a foreign Origin and Host', async () => {
    const r = await checkFake({ hostCheck: false, originCheck: false });
    assert.equal(r.code, EXIT.PROBLEMS);
    assert.ok(ids(r.doc, 'error').includes('rebinding_origin'));
    assert.ok(ids(r.doc, 'warning').includes('rebinding_host'));
    assert.equal(r.doc.rebinding.origin.accepted, true);
  });
  it('a cross-origin redirect: a warning', async () => {
    const target = await startFakeMcp({ hostCheck: true, originCheck: true });
    try {
      const r = await checkFake({ redirectTo: target.url });
      assert.ok(ids(r.doc, 'warning').includes('redirect_other_origin'));
    } finally {
      await target.close();
    }
  });
  it('unreachable: exit 5', async () => {
    const f = await startFakeMcp();
    const url = f.url;
    await f.close();
    const r = await check([url, '--json']);
    assert.equal(r.code, EXIT.UNREACHABLE);
    assert.equal(r.json().readable, false);
    assert.ok(ids(r.json(), 'error').includes('unreachable'));
  });
  it('a web page: exit 5', async () => {
    const r = await checkFake({ html: true });
    assert.equal(r.code, EXIT.UNREACHABLE);
    assert.ok(ids(r.doc, 'error').includes('not_mcp'));
  });
  it('an mcp.tc listing link is checked at the server\'s own URL', async () => {
    const f = await startFakeMcp({ hostCheck: true, originCheck: true });
    try {
      f.set({ directory: { fake: { name: 'Fake Docs', slug: 'fake', link: 'https://mcp.tc/i/fake', kind: 'remote', auth: 'none', endpoint: f.url } } });
      const r = await check(['https://mcp.tc/i/fake', '--json'], { base: `${f.base}/dir` });
      assert.equal(r.code, 0);
      assert.equal(r.json().listing.slug, 'fake');
      assert.equal(r.json().target.url, f.url);
    } finally {
      await f.close();
    }
  });
});

describe('check: review fixes', () => {
  it('security-check-raw-listing-name: a listing name from mcp.tc reaches the terminal without escape sequences', async () => {
    const f = await startFakeMcp({ hostCheck: true, originCheck: true });
    const evil = 'Evil\u001b]8;;https://attacker.example\u0007Docs\u001b]8;;\u0007\u001b[2J\u009b31m';
    try {
      f.set({
        directory: {
          local: { name: evil, slug: 'local', link: 'https://mcp.tc/i/local', kind: 'local', auth: 'none', endpoint: null },
          remote: { name: evil, slug: 'remote', link: 'https://mcp.tc/i/remote', kind: 'remote', auth: 'none', endpoint: f.url },
        },
      });
      const a = await check(['https://mcp.tc/i/local'], { base: `${f.base}/dir` });
      assert.equal(a.code, EXIT.USAGE);
      assert.match(a.stderr, /^Error: Evil\]8;;https:\/\/attacker\.exampleDocs\]8;;\[2J31m runs locally/);
      // check cleans the name itself, so the JSON message (which cli.js prints as it is) has none either
      const aj = await check(['https://mcp.tc/i/local', '--json'], { base: `${f.base}/dir` });
      assert.equal(aj.json().error.code, 'local_listing');
      assert.doesNotMatch(aj.json().error.message, /[\u0000-\u001f\u007f-\u009f]/);
      const b = await check(['https://mcp.tc/i/remote'], { base: `${f.base}/dir` });
      assert.equal(b.code, 0);
      for (const text of [a.stdout, a.stderr, b.stdout, b.stderr]) assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      assert.match(b.stderr, /Evil.*Docs.*: checking its own URL/);
    } finally {
      await f.close();
    }
  });

  it('correctness-3: a retired /sse URL whose GET answers 410 is reported as moved', async () => {
    const f = await startFakeMcp({ path: '/sse', hostCheck: true, originCheck: true });
    f.set({ retiredSse: `${f.base}/mcp` });
    try {
      const r = await check([f.url, '--json']);
      assert.equal(r.code, EXIT.UNREACHABLE);
      const moved = r.json().findings.find((x) => x.id === 'moved');
      assert.ok(moved, JSON.stringify(r.json().findings));
      assert.match(moved.message, /gone \(HTTP 410\) and points to http:\/\/127\.0\.0\.1:\d+\/mcp\./);
      assert.ok(!ids(r.json()).includes('not_mcp'));
    } finally {
      await f.close();
    }
  });

  it('rules-5: the note says a person may review a suggestion, not that one reviews every suggestion', () => {
    assert.match(NOTE, /an AI model checks each suggestion and a person may review it; check doesn't predict whether the server will be listed/);
    assert.doesNotMatch(NOTE, /every suggestion/);
  });
});

describe('create-4: check over stdio asks for initialize in a fresh process', () => {
  const FAKE = fileURLToPath(new URL('./helpers/fake-mcp.js', import.meta.url));
  const cmd = (o) => `node "${FAKE}" --fake-stdio '${JSON.stringify(o)}'`;
  it('a server that keeps each connection in one era (as serveStdio does) answers both eras: no legacy_missing', async () => {
    const pids = join(mkdtempSync(join(tmpdir(), 'mcptc-pids-')), 'pids');
    dirs.push(join(pids, '..'));
    const dir = project({ 'package.json': PKG, 'server.json': SJ, 'README.md': '# x' });
    const r = await check([dir, '--command', cmd({ pinEra: true, pidFile: pids }), '--json']);
    const d = r.json();
    assert.equal(r.code, 0, JSON.stringify(d.findings));
    assert.ok(!ids(d).includes('legacy_missing'), JSON.stringify(d.findings));
    assert.ok(ids(d, 'ok').includes('modern') && ids(d, 'ok').includes('legacy'));
    assert.equal(d.stdio.eras.legacy.ok, true);
    assert.equal(readFileSync(pids, 'utf8').trim().split('\n').length, 2, 'the legacy handshake ran in a second process');
  });
  it('a server that refuses initialize even as the first message still gets the warning', async () => {
    const dir = project({ 'package.json': PKG, 'server.json': SJ, 'README.md': '# x' });
    const r = await check([dir, '--command', cmd({ legacy: false }), '--json']);
    assert.ok(ids(r.json(), 'warning').includes('legacy_missing'));
  });
});

describe('mcp-tc check <dir>', () => {
  it('a complete project: no errors', async () => {
    const dir = project({ 'package.json': PKG, 'server.json': SJ, 'README.md': '# Fake Docs', '.well-known/mcp/server-card.json': CARD });
    const r = await check([dir, '--json']);
    assert.equal(r.code, 0, JSON.stringify(r.json().findings));
    const d = r.json();
    assert.equal(d.target.kind, 'dir');
    assert.equal(d.counts.error, 0);
    assert.equal(d.counts.warning, 0, JSON.stringify(d.findings));
    for (const id of ['pkg', 'pkg_mcp_name', 'server_json', 'card_file']) assert.ok(ids(d, 'ok').includes(id), id);
    assert.equal(d.readable, null);
    assert.equal(d.report, null);
    assert.deepEqual(d.project, { package_json: true, server_json: 'server.json', card_file: '.well-known/mcp/server-card.json', readme: 'README.md', pyproject: false });
  });

  it('relative paths work from the current folder', async () => {
    const dir = project({ 'package.json': PKG, 'README.md': '# x' });
    const r = await check(['.', '--json'], { cwd: dir });
    assert.equal(r.code, 0);
    assert.equal(r.json().target.dir, dir);
  });

  it('suggestions for a bare package.json', async () => {
    const dir = project({ 'package.json': { name: '@acme/docs-mcp', version: '0.1.0', bin: { x: 'x.js' }, repository: 'github:acme/docs-mcp' } });
    const r = await check([dir, '--json']);
    assert.equal(r.code, 0);
    const d = r.json();
    assert.ok(ids(d, 'warning').includes('pkg_description'));
    for (const id of ['pkg_mcp_name_missing', 'pkg_homepage', 'pkg_license', 'server_json_missing', 'readme_missing']) assert.ok(ids(d, 'suggestion').includes(id), id);
    assert.match(d.findings.find((x) => x.id === 'pkg_mcp_name_missing').message, /"mcpName": "io\.github\.acme\/docs-mcp"/);
  });

  it('errors: bad name and version, mcpName and server.json out of step, invalid server.json and card file', async () => {
    const dir = project({
      'package.json': { ...PKG, name: 'Bad Name', version: '^1.0.0', mcpName: 'com.example/other' },
      'server.json': { ...SJ, description: 'q'.repeat(150), packages: [{ registryType: 'npm', identifier: 'someone-else', version: '1.0.0', transport: { type: 'stdio' } }] },
      'server-card.json': { ...CARD, $schema: undefined, name: 'com.example/third' },
      'README.md': '# x',
    });
    const r = await check([dir, '--json']);
    assert.equal(r.code, EXIT.PROBLEMS);
    const e = ids(r.json(), 'error');
    for (const id of ['pkg_name', 'pkg_version', 'pkg_mcp_name_mismatch', 'server_json_invalid', 'server_json_package', 'card_file_invalid']) assert.ok(e.includes(id), id);
    assert.ok(ids(r.json(), 'warning').includes('card_file_name'));
  });

  it('broken JSON files are findings, not crashes', async () => {
    const dir = project({ 'package.json': '{ nope', 'server.json': '[1,', 'README.md': '# x' });
    const r = await check([dir, '--json']);
    assert.equal(r.code, EXIT.PROBLEMS);
    assert.ok(ids(r.json(), 'error').includes('pkg_invalid_json'));
    assert.ok(ids(r.json(), 'error').includes('server_json_invalid_json'));
  });

  it('an empty folder', async () => {
    const r = await check([project({}), '--json']);
    assert.equal(r.code, EXIT.PROBLEMS);
    assert.ok(ids(r.json(), 'error').includes('pkg_missing'));
  });

  it('a Python project: pyproject.toml and mcp-name in the README', async () => {
    const toml = '[project]\nname = "fake-docs"\nversion = "1.2.3"\ndescription = "Docs"\n';
    const with_ = project({ 'pyproject.toml': toml, 'README.md': '# Fake\n<!-- mcp-name: com.example/fake-docs -->\n', 'server.json': { ...SJ, packages: [{ registryType: 'pypi', identifier: 'fake-docs', version: '1.2.3', transport: { type: 'stdio' } }] } });
    const a = await check([with_, '--json']);
    assert.equal(a.code, 0, JSON.stringify(a.json().findings));
    assert.ok(!ids(a.json()).includes('py_mcp_name'));
    const without = project({ 'pyproject.toml': toml, 'README.md': '# Fake' });
    const b = await check([without, '--json']);
    assert.ok(ids(b.json(), 'suggestion').includes('py_mcp_name'));
    const wrong = project({ 'pyproject.toml': toml, 'README.md': 'mcp-name: com.example/nope', 'server.json': SJ });
    const c = await check([wrong, '--json']);
    assert.ok(ids(c.json(), 'error').includes('py_mcp_name_mismatch'));
  });

  it('with --url: the folder and the running server', async () => {
    const f = await startFakeMcp({ card: CARD, hostCheck: true, originCheck: true });
    try {
      const dir = project({ 'package.json': { ...PKG, bin: undefined, private: true, scripts: { start: 'node server.js' } }, 'README.md': '# x', 'server.json': { ...SJ, packages: undefined, remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] } });
      const r = await check([dir, '--url', f.url, '--json']);
      assert.equal(r.code, 0, JSON.stringify(r.json().findings));
      const d = r.json();
      assert.equal(d.target.url, f.url);
      assert.ok(d.report.mcp);
      assert.ok(ids(d, 'ok').includes('tools'));
      assert.ok(ids(d, 'suggestion').includes('card_file_missing'));
      const hint = await check([dir, '--json']);
      assert.ok(ids(hint.json(), 'suggestion').includes('run_and_check'));
    } finally {
      await f.close();
    }
  });

  it('usage errors: a file, a word that is neither, --url with a URL', async () => {
    const dir = project({ 'package.json': PKG });
    const a = await check([join(dir, 'package.json'), '--json']);
    assert.equal(a.code, EXIT.USAGE);
    assert.equal(a.json().error.code, 'not_a_folder');
    const b = await check(['no-such-thing', '--json'], { cwd: dir });
    assert.equal(b.code, EXIT.USAGE);
    assert.equal(b.json().error.code, 'invalid_target');
    const c = await check(['https://mcp.example.com/mcp', '--url', 'https://x.example/mcp', '--json']);
    assert.equal(c.code, EXIT.USAGE);
  });
});

describe('mcp-tc check <dir> over stdio', () => {
  const FAKE = fileURLToPath(new URL('./helpers/fake-mcp.js', import.meta.url));
  const cmd = (o) => `node "${FAKE}" --fake-stdio '${JSON.stringify(o)}'`;

  it('--command: starts the server in the folder and checks it', async () => {
    const dir = project({ 'package.json': PKG, 'server.json': SJ, 'README.md': '# x' });
    const r = await check([dir, '--command', cmd({}), '--json']);
    assert.equal(r.code, 0, JSON.stringify(r.json().findings));
    const d = r.json();
    assert.ok(d.target.command.includes('--fake-stdio'));
    assert.equal(d.stdio.transport, 'stdio');
    assert.equal(d.stdio.mcp, true);
    assert.ok(ids(d, 'ok').includes('stdio'));
    assert.ok(ids(d, 'ok').includes('tools'));
    assert.equal(d.readable, true);
    const h = await check([dir, '--command', cmd({})]);
    assert.match(h.stdout, /over stdio/);
    assert.match(h.stdout, /Command\s+node /);
    assert.match(h.stderr, /^Starting node /);
  });

  it('--stdio: runs package.json\'s bin with node', async () => {
    const dir = project({
      'package.json': { ...PKG, bin: { 'fake-docs-mcp': 'bin/server.js' } },
      'bin/server.js': `import { runStdioFake } from ${JSON.stringify(new URL('./helpers/fake-mcp.js', import.meta.url).href)};\nrunStdioFake({ modern: false });\n`,
      'server.json': SJ,
      'README.md': '# x',
    });
    const r = await check([dir, '--stdio', '--json']);
    assert.equal(r.code, 0, JSON.stringify(r.json().findings));
    assert.equal(r.json().stdio.era, 'legacy');
    const hint = await check([dir, '--json']);
    assert.ok(ids(hint.json(), 'suggestion').includes('stdio_check'));
  });

  it('stdout noise is an error; a crash makes it unreadable (exit 5)', async () => {
    const dir = project({ 'package.json': PKG, 'README.md': '# x' });
    const noisy = await check([dir, '--command', cmd({ noise: true }), '--json']);
    assert.equal(noisy.code, EXIT.PROBLEMS);
    assert.ok(ids(noisy.json(), 'error').includes('stdio_noise'));
    const crash = await check([dir, '--command', cmd({ crash: true }), '--json']);
    assert.equal(crash.code, EXIT.UNREACHABLE);
    assert.equal(crash.json().readable, false);
    const e = crash.json().findings.find((x) => x.id === 'stdio_failed');
    assert.match(e.message, /Cannot find module 'zod'/);
  });

  it('usage errors: no bin, a missing bin file, --stdio with a URL, an empty --command', async () => {
    const nobin = project({ 'package.json': { ...PKG, bin: undefined } });
    const a = await check([nobin, '--stdio', '--json']);
    assert.equal(a.code, EXIT.USAGE);
    assert.equal(a.json().error.code, 'no_bin');
    const missing = project({ 'package.json': PKG });
    const b = await check([missing, '--stdio', '--json']);
    assert.equal(b.json().error.code, 'no_bin');
    const c = await check(['https://mcp.example.com/mcp', '--stdio', '--json']);
    assert.equal(c.code, EXIT.USAGE);
    const d = await check([missing, '--command', '  ', '--json']);
    assert.equal(d.json().error.code, 'invalid_command');
  });
});

// Read-only check of https://mcp.tc/mcp: both handshakes, tools/list and the two card addresses, six requests.
// Run with MCPTC_LIVE=1.
describe('live mcp.tc (MCPTC_LIVE=1)', { skip: process.env.MCPTC_LIVE !== '1' && 'set MCPTC_LIVE=1 to run against https://mcp.tc' }, () => {
  it('check https://mcp.tc/mcp: readable, no errors, a valid server card', async () => {
    const r = await runCli(['check', 'https://mcp.tc/mcp', '--json'], { env: { MCPTC_BASE_URL: 'https://mcp.tc' } });
    assert.equal(r.code, 0, r.stdout);
    const d = r.json();
    assert.equal(d.readable, true);
    assert.equal(d.counts.error, 0, JSON.stringify(d.findings));
    assert.ok(ids(d, 'ok').includes('card'));
    assert.ok(ids(d, 'ok').includes('modern'));
  });
});
