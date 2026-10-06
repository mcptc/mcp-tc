// card: documents built from package.json (and a handshake) must pass the official JSON schemas.
// Schemas in test/fixtures/schemas, downloaded once on 2026-10-06:
//   server-card.schema.json  https://raw.githubusercontent.com/modelcontextprotocol/experimental-ext-server-card/main/schema.json
//                            (the extension's $defs/ServerCard; its $schema URL on static.modelcontextprotocol.io is not served yet)
//   server.schema.json       https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildDocuments, deriveName, repositoryOf, validateCard, validateServerJson, CARD_SCHEMA, SERVER_JSON_SCHEMA } from '../src/commands/card.js';
import { EXIT } from '../src/lib/errors.js';
import { runCli } from './helpers/fake-directory.js';
import { startFakeMcp } from './helpers/fake-mcp.js';

const require = createRequire(import.meta.url);
const cardSchema = require('./fixtures/schemas/server-card.schema.json');
const serverSchema = require('./fixtures/schemas/server.schema.json');

const ajvCard = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajvCard);
ajvCard.addSchema(cardSchema, 'card');
const checkCard = /** @type {import('ajv').ValidateFunction} */ (ajvCard.getSchema('card#/$defs/ServerCard'));
const ajvServer = new Ajv({ strict: false, allErrors: true });
addFormats(ajvServer);
const checkServer = ajvServer.compile(serverSchema);

/** @param {import('ajv').ValidateFunction} fn @param {unknown} doc */
function schemaOk(fn, doc) {
  const ok = fn(doc);
  return { ok, errors: ok ? [] : (fn.errors || []).map((e) => `${e.instancePath} ${e.message}`) };
}

const PKG = {
  name: '@acme/docs-mcp',
  version: '1.4.0',
  description: 'Search and read the Acme documentation from any MCP client.',
  bin: { 'acme-docs-mcp': 'bin/server.js' },
  repository: { type: 'git', url: 'git+https://github.com/acme/docs-mcp.git', directory: 'packages/server' },
  homepage: 'https://docs.acme.dev',
  license: 'MIT',
};

const dirs = [];
/** A temporary project folder with these files. */
function project(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcptc-card-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

let fake;
before(async () => {
  fake = await startFakeMcp({ legacyVersions: ['2025-11-25', '2025-06-18'] });
});
after(async () => {
  await fake.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** @param {string[]} args @param {string} [cwd] */
const card = (args, cwd) => runCli(['card', ...args], { cwd, env: {} });

describe('the official schemas', () => {
  it('load and reject an empty document', () => {
    assert.equal(checkCard({}), false);
    assert.equal(checkServer({}), false);
  });
});

describe('repositoryOf() and deriveName()', () => {
  const repos = [
    ['git+https://github.com/acme/docs-mcp.git', { url: 'https://github.com/acme/docs-mcp', source: 'github' }],
    ['https://github.com/acme/docs-mcp', { url: 'https://github.com/acme/docs-mcp', source: 'github' }],
    ['git@github.com:acme/docs-mcp.git', { url: 'https://github.com/acme/docs-mcp', source: 'github' }],
    ['github:acme/docs-mcp', { url: 'https://github.com/acme/docs-mcp', source: 'github' }],
    ['acme/docs-mcp', { url: 'https://github.com/acme/docs-mcp', source: 'github' }],
    ['gitlab:acme/docs-mcp', { url: 'https://gitlab.com/acme/docs-mcp', source: 'gitlab' }],
    ['https://codeberg.org/acme/docs-mcp.git', { url: 'https://codeberg.org/acme/docs-mcp', source: 'codeberg' }],
    [{ type: 'git', url: 'https://github.com/acme/mono.git', directory: './packages/mcp/' }, { url: 'https://github.com/acme/mono', source: 'github', subfolder: 'packages/mcp' }],
  ];
  for (const [input, want] of repos) {
    it(`repository ${JSON.stringify(input)}`, () => assert.deepEqual(repositoryOf(input), want));
  }
  it('no repository', () => {
    assert.equal(repositoryOf(undefined), null);
    assert.equal(repositoryOf(''), null);
  });
  const names = [
    [{ pkg: PKG, name: 'com.acme/docs' }, 'com.acme/docs', '--name'],
    [{ pkg: { ...PKG, mcpName: 'io.github.acme/docs' } }, 'io.github.acme/docs', 'package.json mcpName'],
    [{ pkg: PKG }, 'io.github.acme/docs-mcp', 'repository'],
    [{ pkg: { ...PKG, repository: undefined } }, 'dev.acme.docs/docs-mcp', 'homepage'],
    [{ pkg: { ...PKG, repository: undefined, homepage: 'https://github.com/acme' } }, 'io.github.acme/docs-mcp', 'npm scope'],
    [{ pkg: null, url: 'https://mcp.acme.dev/mcp', server: { name: 'docs' } }, 'dev.acme.mcp/docs', 'server URL'],
    [{ pkg: null, url: 'http://localhost:3000/mcp', server: { name: 'docs' } }, null, 'none'],
  ];
  for (const [src, want, from] of names) {
    it(`name from ${from}`, () => {
      const r = deriveName({ url: null, server: null, ...src });
      assert.equal(r.name, want);
      assert.equal(r.from, from);
    });
  }
});

describe('buildDocuments()', () => {
  it('an npm package with a bin: card and server.json pass the official schemas', () => {
    const b = buildDocuments({ pkg: PKG, report: null, url: null });
    assert.deepEqual(schemaOk(checkCard, b.card), { ok: true, errors: [] });
    assert.deepEqual(schemaOk(checkServer, b.serverJson), { ok: true, errors: [] });
    assert.equal(b.card.$schema, CARD_SCHEMA);
    assert.equal(b.serverJson.$schema, SERVER_JSON_SCHEMA);
    assert.deepEqual(b.serverJson.packages, [{ registryType: 'npm', identifier: '@acme/docs-mcp', version: '1.4.0', transport: { type: 'stdio' } }]);
    assert.equal(b.card.repository.subfolder, 'packages/server');
    assert.ok(b.notes.some((n) => /mcpName/.test(n)));
  });
  it('the card carries only ServerCard fields: no tools or capabilities', () => {
    const b = buildDocuments({ pkg: PKG, report: null, url: 'https://mcp.acme.dev/mcp' });
    const allowed = Object.keys(cardSchema.$defs.ServerCard.properties);
    for (const k of Object.keys(b.card)) assert.ok(allowed.includes(k), k);
    for (const k of Object.keys(b.serverJson)) assert.ok([...Object.keys(serverSchema.definitions.ServerDetail.properties), 'description'].includes(k), k);
  });
  it('remote only (private package, --url): remotes, no packages, both valid', () => {
    const b = buildDocuments({ pkg: { ...PKG, private: true, bin: undefined }, report: null, url: 'https://mcp.acme.dev/mcp' });
    assert.equal(b.serverJson.packages, undefined);
    assert.deepEqual(b.serverJson.remotes, [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }]);
    assert.deepEqual(b.card.remotes, [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }]);
    assert.ok(schemaOk(checkCard, b.card).ok);
    assert.ok(schemaOk(checkServer, b.serverJson).ok);
  });
  it('refuses a description over 100 characters, takes --description', () => {
    const long = { ...PKG, description: 'x'.repeat(101) };
    assert.throws(() => buildDocuments({ pkg: long, report: null, url: null }), (e) => e.code === 'description_too_long' && e.exit === EXIT.USAGE);
    const b = buildDocuments({ pkg: long, report: null, url: null, description: 'Short and clear.' });
    assert.equal(b.card.description, 'Short and clear.');
  });
  it('needs a name, a description and a version', () => {
    assert.throws(() => buildDocuments({ pkg: { version: '1.0.0', description: 'd' }, report: null, url: null }), (e) => e.code === 'no_name');
    assert.throws(() => buildDocuments({ pkg: { ...PKG, description: '' }, report: null, url: null }), (e) => e.code === 'no_description');
    assert.throws(() => buildDocuments({ pkg: { ...PKG, version: undefined }, report: null, url: null }), (e) => e.code === 'no_version');
  });
});

describe('the built-in validators agree with the official schemas', () => {
  const card = { $schema: CARD_SCHEMA, name: 'com.example/docs', description: 'Docs search.', version: '1.0.0' };
  const sj = { $schema: SERVER_JSON_SCHEMA, name: 'com.example/docs', description: 'Docs search.', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }] };
  const cardCases = [
    ['minimal', card, true],
    ['with remotes and headers', { ...card, remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: 'X-Key', isSecret: true }], supportedProtocolVersions: ['2025-11-25'] }] }, true],
    ['no $schema', { ...card, $schema: undefined }, false],
    ['other $schema', { ...card, $schema: 'https://example.com/schema.json' }, false],
    ['bad name', { ...card, name: 'docs' }, false],
    ['two slashes', { ...card, name: 'a/b/c' }, false],
    ['long description', { ...card, description: 'x'.repeat(101) }, false],
    ['empty description', { ...card, description: '' }, false],
    ['no version', { ...card, version: undefined }, false],
    ['bad remote type', { ...card, remotes: [{ type: 'websocket', url: 'https://x.example/mcp' }] }, false],
    ['remote without url', { ...card, remotes: [{ type: 'sse' }] }, false],
    ['icon without src', { ...card, icons: [{ mimeType: 'image/png' }] }, false],
    ['repository without source', { ...card, repository: { url: 'https://github.com/a/b' } }, false],
    ['bad websiteUrl', { ...card, websiteUrl: 'not a url' }, false],
  ];
  for (const [what, doc, valid] of cardCases) {
    const clean = JSON.parse(JSON.stringify(doc));
    it(`card: ${what}`, () => {
      assert.equal(schemaOk(checkCard, clean).ok, valid, 'official schema');
      assert.equal(validateCard(clean).errors.length === 0, valid, 'built-in rules');
    });
  }
  const sjCases = [
    ['remote', sj, true],
    ['npm package', { ...sj, remotes: undefined, packages: [{ registryType: 'npm', identifier: '@a/b', version: '1.0.0', transport: { type: 'stdio' } }] }, true],
    ['package version latest', { ...sj, packages: [{ registryType: 'npm', identifier: 'a', version: 'latest', transport: { type: 'stdio' } }] }, false],
    ['package without transport', { ...sj, packages: [{ registryType: 'npm', identifier: 'a' }] }, false],
    ['package http transport without url', { ...sj, packages: [{ registryType: 'npm', identifier: 'a', transport: { type: 'streamable-http' } }] }, false],
    ['remote with a template variable', { ...sj, remotes: [{ type: 'streamable-http', url: '{base}/mcp' }] }, false],
    ['icon type not allowed', { ...sj, icons: [{ src: 'https://x.example/i.ico', mimeType: 'image/x-icon' }] }, false],
    ['icon size format', { ...sj, icons: [{ src: 'https://x.example/i.png', sizes: ['big'] }] }, false],
    ['long description', { ...sj, description: 'y'.repeat(101) }, false],
    ['bad name', { ...sj, name: 'no-slash' }, false],
  ];
  for (const [what, doc, valid] of sjCases) {
    const clean = JSON.parse(JSON.stringify(doc));
    it(`server.json: ${what}`, () => {
      assert.equal(schemaOk(checkServer, clean).ok, valid, 'official schema');
      assert.equal(validateServerJson(clean).errors.length === 0, valid, 'built-in rules');
    });
  }
  it('warns about what the schemas allow but the specs advise against', () => {
    assert.ok(validateCard({ ...card, tools: [] }).warnings.some((w) => w.path === 'tools'));
    assert.ok(validateServerJson({ ...sj, _meta: { 'com.example/x': {} } }).warnings.some((w) => /publisher-provided/.test(w.message)));
    assert.ok(validateServerJson({ ...sj, remotes: undefined }).warnings.some((w) => /neither packages nor remotes/.test(w.message)));
  });
});

describe('mcp-tc card', () => {
  it('prints both documents from package.json, valid against the schemas', async () => {
    const dir = project({ 'package.json': PKG });
    const r = await card(['--json'], dir);
    assert.equal(r.code, 0);
    const d = r.json();
    assert.equal(d.name, 'io.github.acme/docs-mcp');
    assert.equal(d.name_from, 'repository');
    assert.equal(d.handshake, null);
    assert.ok(schemaOk(checkCard, d.card).ok);
    assert.ok(schemaOk(checkServer, d.server_json).ok);
    assert.deepEqual(d.files, []);
    const h = await card([], dir);
    assert.match(h.stdout, /^Server card \(serve it at <your endpoint>\/server-card\):/);
    assert.match(h.stdout, /server\.json \(for the official MCP Registry, schema 2025-12-11\):/);
    assert.match(h.stdout, /Name: io\.github\.acme\/docs-mcp \(from repository\)/);
  });

  it('--url: reads the server for title, icons and protocol versions', async () => {
    const dir = project({ 'package.json': PKG });
    const r = await card([dir, '--url', fake.url, '--json']);
    assert.equal(r.code, 0);
    const d = r.json();
    assert.equal(d.card.title, 'Fake Docs');
    assert.deepEqual(d.card.icons, [{ src: 'https://docs.example.com/icon.png', mimeType: 'image/png', sizes: ['128x128'] }]);
    assert.deepEqual(d.card.remotes, [{ type: 'streamable-http', url: fake.url, supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18'] }]);
    assert.deepEqual(d.server_json.remotes, [{ type: 'streamable-http', url: fake.url }]);
    assert.equal(d.handshake.era, 'modern');
    assert.ok(schemaOk(checkCard, d.card).ok, schemaOk(checkCard, d.card).errors.join('; '));
    assert.ok(schemaOk(checkServer, d.server_json).ok, schemaOk(checkServer, d.server_json).errors.join('; '));
    assert.ok(d.notes.some((n) => /points to this computer/.test(n)));
  });

  it('--url with only --name and no package.json', async () => {
    const dir = project({});
    const r = await card(['--url', fake.url, '--name', 'com.example/docs', '--json'], dir);
    assert.equal(r.code, 0);
    const d = r.json();
    assert.equal(d.card.name, 'com.example/docs');
    assert.equal(d.card.version, '1.2.3');
    assert.equal(d.card.description, 'Search and read the Fake Docs documentation.');
    assert.ok(schemaOk(checkCard, d.card).ok);
    assert.ok(schemaOk(checkServer, d.server_json).ok);
  });

  it('--offline uses the URL without connecting', async () => {
    fake.reset();
    const dir = project({ 'package.json': PKG });
    const r = await card(['--url', fake.url, '--offline', '--json'], dir);
    assert.equal(r.code, 0);
    assert.equal(fake.requests.length, 0);
    assert.deepEqual(r.json().card.remotes, [{ type: 'streamable-http', url: fake.url }]);
  });

  it('writes the files, asks before overwriting, and --yes overwrites', async () => {
    const dir = project({ 'package.json': PKG });
    const r = await card(['--out', '.well-known/mcp/server-card.json', '--server-json', 'server.json'], dir);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Wrote the server card to .*\.well-known\/mcp\/server-card\.json/);
    assert.match(r.stdout, /Wrote server\.json to .*server\.json/);
    assert.doesNotMatch(r.stdout, /^Server card \(serve/m);
    const written = JSON.parse(readFileSync(join(dir, '.well-known/mcp/server-card.json'), 'utf8'));
    assert.ok(schemaOk(checkCard, written).ok);
    assert.ok(schemaOk(checkServer, JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'))).ok);
    const again = await card(['--server-json', 'server.json', '--json'], dir);
    assert.equal(again.code, EXIT.USAGE);
    assert.equal(again.json().error.code, 'needs_confirmation');
    writeFileSync(join(dir, 'server.json'), '{}');
    const yes = await card(['--server-json', 'server.json', '--yes'], dir);
    assert.equal(yes.code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')).name, 'io.github.acme/docs-mcp');
  });

  it('errors: no project, bad --name, long description, a key in --url, an unreachable --url', async () => {
    const empty = project({});
    const a = await card(['--json'], empty);
    assert.equal(a.code, EXIT.USAGE);
    assert.equal(a.json().error.code, 'no_project');
    const dir = project({ 'package.json': { ...PKG, description: 'z'.repeat(120) } });
    const b = await card(['--json'], dir);
    assert.equal(b.code, EXIT.USAGE);
    assert.equal(b.json().error.code, 'description_too_long');
    const c = await card(['--name', 'nope', '--json'], dir);
    assert.equal(c.json().error.code, 'invalid_name');
    const d = await card(['--url', 'https://mcp.example.com/mcp?api_key=abcdef123456', '--description', 'ok', '--json'], dir);
    assert.equal(d.code, EXIT.USAGE);
    assert.equal(d.json().error.code, 'secret_in_url');
    assert.ok(!d.stdout.includes('abcdef123456'));
    const f = await startFakeMcp();
    const gone = f.url;
    await f.close();
    const e = await card(['--url', gone, '--description', 'ok', '--json'], dir);
    assert.equal(e.code, EXIT.UNREACHABLE);
    assert.equal(e.json().error.code, 'unreachable');
    const g = project({ 'package.json': '{ not json' });
    const h = await card(['--json'], g);
    assert.equal(h.code, EXIT.USAGE);
    assert.equal(h.json().error.code, 'invalid_json');
  });

  it('an API-key server: a note about remotes[].headers', async () => {
    const f = await startFakeMcp({ auth: 'apikey' });
    try {
      const dir = project({ 'package.json': { ...PKG, private: true } });
      const r = await card(['--url', f.url, '--json'], dir);
      assert.equal(r.code, 0);
      assert.ok(r.json().notes.some((n) => /remotes\[0\]\.headers/.test(n)));
    } finally {
      await f.close();
    }
  });

  it('an old HTTP+SSE server: remote type sse', async () => {
    const f = await startFakeMcp({ legacySse: true, path: '/sse' });
    try {
      const dir = project({ 'package.json': { ...PKG, private: true } });
      const r = await card(['--url', f.url, '--json'], dir);
      assert.equal(r.code, 0);
      const d = r.json();
      assert.equal(d.card.remotes[0].type, 'sse');
      assert.equal(d.server_json.remotes[0].type, 'sse');
      assert.ok(schemaOk(checkCard, d.card).ok);
      assert.ok(schemaOk(checkServer, d.server_json).ok);
    } finally {
      await f.close();
    }
  });

  it('never writes a --header value into the documents', async () => {
    const f = await startFakeMcp({ auth: 'oauth' });
    try {
      const dir = project({ 'package.json': PKG });
      const r = await card(['--url', f.url, '--header', 'Authorization: Bearer test-token', '--out', 'card.json', '--server-json', 'server.json', '--json'], dir);
      assert.equal(r.code, 0);
      assert.ok(!r.stdout.includes('test-token'));
      assert.ok(existsSync(join(dir, 'card.json')));
      assert.ok(!readFileSync(join(dir, 'card.json'), 'utf8').includes('test-token'));
      assert.ok(!readFileSync(join(dir, 'server.json'), 'utf8').includes('test-token'));
    } finally {
      await f.close();
    }
  });
});

describe('card: review fixes', () => {
  it('rules-6: an mcp.tc listing link as --url is refused, with or without --offline, and nothing is written', async () => {
    const dir = project({ 'package.json': PKG });
    for (const extra of [['--offline'], []]) {
      for (const link of ['https://mcp.tc/i/weather', 'mcp.tc/it/i/weather', 'https://www.mcp.tc/i/weather.json']) {
        const r = await card(['--url', link, ...extra, '--yes', '--out', 'card.json', '--server-json', 'server.json', '--json'], dir);
        assert.equal(r.code, EXIT.USAGE, link);
        const e = r.json().error;
        assert.equal(e.code, 'listing_link');
        assert.equal(e.slug, 'weather');
        assert.match(e.message, /That is the mcp\.tc page of the listing "weather", not your server\. Pass your server's own MCP URL with --url\./);
      }
    }
    assert.ok(!existsSync(join(dir, 'card.json')) && !existsSync(join(dir, 'server.json')));
    // mcp.tc's own MCP endpoint is a real server URL, not a listing page
    const own = await card(['--url', 'https://mcp.tc/mcp', '--offline', '--json'], dir);
    assert.equal(own.code, 0, own.stdout);
  });

  it('ux-card-partial-write: with no terminal to confirm an overwrite, neither file is written', async () => {
    const dir = project({ 'package.json': PKG, 'server.json': '{"keep": true}\n' });
    const r = await card(['--out', 'card.json', '--server-json', 'server.json', '--json'], dir);
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'needs_confirmation');
    assert.ok(!existsSync(join(dir, 'card.json')), 'card.json was not written before the question failed');
    assert.equal(readFileSync(join(dir, 'server.json'), 'utf8'), '{"keep": true}\n');
    const same = await card(['--out', 'x.json', '--server-json', './x.json', '--yes', '--json'], dir);
    assert.equal(same.json().error.code, 'same_file');
  });

  it('ux-card-partial-write: one question for every existing file; no keeps both, yes writes both', async () => {
    const { main } = await import('../src/cli.js');
    const { PassThrough } = await import('node:stream');
    /** @param {string} cwd @param {string} answer */
    const ask = async (cwd, answer) => {
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false });
      const stderr = Object.assign(new PassThrough(), { isTTY: false });
      let seen = '';
      stderr.on('data', (d) => {
        seen += d;
        if (/\[y\/N\] $/.test(seen)) setImmediate(() => stdin.write(answer));
      });
      let stdout = '';
      const code = await main(['card', '--out', 'card.json', '--server-json', 'server.json'], { stdin, stderr, stdout: { isTTY: false, write: (t) => ((stdout += t), true) }, env: { PATH: process.env.PATH }, cwd });
      return { code, stdout, seen };
    };
    const dir = project({ 'package.json': PKG, 'card.json': '{"old": 1}\n', 'server.json': '{"old": 2}\n' });
    const no = await ask(dir, 'n\n');
    assert.equal(no.code, 0);
    assert.equal((no.seen.match(/\[y\/N\]/g) || []).length, 1, 'one question');
    assert.match(no.seen, /card\.json and server\.json exist\. Overwrite them\? \[y\/N\]/);
    assert.equal(readFileSync(join(dir, 'card.json'), 'utf8'), '{"old": 1}\n');
    assert.match(no.stdout, /Did not write .*card\.json\./);
    assert.match(no.stdout, /^Server card \(serve it at/m, 'the documents are printed instead');
    const ctrlC = await ask(dir, '\u0003');
    assert.equal(ctrlC.code, 130);
    assert.equal(readFileSync(join(dir, 'server.json'), 'utf8'), '{"old": 2}\n');
    const yes = await ask(dir, 'y\n');
    assert.equal(yes.code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8')).name, 'io.github.acme/docs-mcp');
    assert.equal(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')).name, 'io.github.acme/docs-mcp');
  });

  it('ux-help-usage-inaccurate: help lists the exit codes card uses', async () => {
    const h = await card(['--help']);
    for (const code of ['0', '1', '2', '5', '130']) assert.match(h.stdout, new RegExp(`\\n {2}${code} +\\S`), code);
  });
});
