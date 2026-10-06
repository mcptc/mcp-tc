import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDirectory, fixture, GONE_SLUG } from './helpers/fake-directory.js';
import {
  accessState,
  addressForLookup,
  baseUrl,
  clearIndexCache,
  index,
  listingExists,
  listingJson,
  lookupAddress,
  mcpCall,
  parseListingRef,
  parseRpcBody,
  requireSlug,
  DEFAULT_BASE,
  PROTOCOL_VERSION,
} from '../src/lib/directory.js';
import { EXIT } from '../src/lib/errors.js';
import { USER_AGENT } from '../src/version.js';

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(() => fake.close());
beforeEach(() => {
  fake.reset();
  clearIndexCache();
});
const opts = () => ({ base: fake.base });

describe('baseUrl()', () => {
  it('defaults to https://mcp.tc', () => {
    assert.equal(baseUrl({}), DEFAULT_BASE);
    assert.equal(DEFAULT_BASE, 'https://mcp.tc');
  });
  it('takes MCPTC_BASE_URL without a trailing slash', () => {
    assert.equal(baseUrl({ MCPTC_BASE_URL: 'http://127.0.0.1:9999/' }), 'http://127.0.0.1:9999');
  });
  it('refuses other schemes and junk', () => {
    assert.throws(() => baseUrl({ MCPTC_BASE_URL: 'ftp://x' }), (e) => e.code === 'invalid_base_url' && e.exit === EXIT.USAGE);
    assert.throws(() => baseUrl({ MCPTC_BASE_URL: 'nope' }), (e) => e.code === 'invalid_base_url');
  });
});

describe('accessState()', () => {
  // the same states as the listing badges on mcp.tc
  const table = [
    ['remote', 'none', 'ok', 'No sign-in'],
    ['remote', 'oauth', 'auth', 'Sign-in'],
    ['remote', 'api_key', 'key', 'API key'],
    ['remote', 'optional', 'opt', 'Sign-in optional'],
    ['remote', 'unknown', 'page', 'Unconfirmed'],
    ['remote', undefined, 'page', 'Unconfirmed'],
    ['local', 'none', 'local', 'Local'],
    ['local', 'api_key', 'local', 'Local'],
  ];
  for (const [kind, auth, key, label] of table) {
    it(`${kind}/${auth} is "${label}"`, () => {
      const s = accessState(kind, auth);
      assert.equal(s.key, key);
      assert.equal(s.label, label);
      assert.equal(s.group, key === 'ok' ? 'ok' : key === 'local' ? 'local' : 'auth');
    });
  }
});

describe('parseListingRef() and requireSlug()', () => {
  it('reads listing links in any spelling', () => {
    assert.deepEqual(parseListingRef('https://mcp.tc/i/notion'), { slug: 'notion', lang: null, link: true });
    assert.deepEqual(parseListingRef('mcp.tc/i/Notion/'), { slug: 'notion', lang: null, link: true });
    assert.deepEqual(parseListingRef('https://www.mcp.tc/it/i/github?x=1#faq'), { slug: 'github', lang: 'it', link: true });
    assert.deepEqual(parseListingRef('https://mcp.tc/i/memory.json'), { slug: 'memory', lang: null, link: true });
    assert.deepEqual(parseListingRef('http://127.0.0.1:5/de/i/x', 'http://127.0.0.1:5'), { slug: 'x', lang: 'de', link: true });
  });
  it('leaves names and slugs alone', () => {
    assert.deepEqual(parseListingRef('GitHub MCP'), { slug: 'GitHub MCP', lang: null, link: false });
    assert.deepEqual(parseListingRef('https://example.com/i/notion'), { slug: 'https://example.com/i/notion', lang: null, link: false });
  });
  it('requireSlug lowercases and refuses names', () => {
    assert.deepEqual(requireSlug('DeepWiki'), { slug: 'deepwiki', lang: null });
    assert.throws(() => requireSlug('GitHub MCP'), (e) => e.code === 'invalid_slug' && e.exit === EXIT.USAGE);
    assert.throws(() => requireSlug('../etc'), (e) => e.code === 'invalid_slug');
  });
});

describe('mcpCall()', () => {
  it('sends one stateless 2026-07-28 tools/call with the mirrored headers', async () => {
    const data = await mcpCall('search_servers', { query: 'github', limit: 2 }, opts());
    assert.equal(data.count, 2);
    assert.equal(fake.requests.length, 1);
    const r = fake.requests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/mcp');
    assert.equal(r.headers['user-agent'], USER_AGENT);
    assert.equal(r.headers['mcp-protocol-version'], PROTOCOL_VERSION);
    assert.equal(r.headers['mcp-method'], 'tools/call');
    assert.equal(r.headers['mcp-name'], 'search_servers');
    const body = JSON.parse(r.body);
    assert.equal(body.method, 'tools/call');
    assert.deepEqual(body.params.arguments, { query: 'github', limit: 2 });
    assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'], PROTOCOL_VERSION);
  });

  it('returns structuredContent exactly as recorded', async () => {
    const data = await mcpCall('get_server', { slug: 'deepwiki' }, opts());
    assert.deepEqual(data, fixture('mcp-get-deepwiki').message.result.structuredContent);
    assert.equal(data.endpoint, 'https://mcp.deepwiki.com/mcp');
  });

  it('falls back to a legacy call when the version is not spoken', async () => {
    const other = await startFakeDirectory({ modernVersions: ['2099-01-01'] });
    try {
      const data = await mcpCall('list_categories', {}, { base: other.base });
      assert.ok(Array.isArray(data.categories));
      assert.equal(other.requests.length, 2);
      const legacy = JSON.parse(other.requests[1].body);
      assert.equal(legacy.params._meta, undefined);
      assert.equal(other.requests[1].headers['mcp-protocol-version'], undefined);
    } finally {
      await other.close();
    }
  });

  it('maps an unknown listing to not_found (exit 3)', async () => {
    await assert.rejects(mcpCall('get_server', { slug: 'zz-nothing' }, opts()), (e) => {
      assert.equal(e.code, 'not_found');
      assert.equal(e.exit, EXIT.NOT_FOUND);
      assert.match(e.message, /No listing for "zz-nothing"/);
      return true;
    });
  });

  it('maps a removed listing to gone (exit 3)', async () => {
    await assert.rejects(mcpCall('get_server', { slug: GONE_SLUG }, opts()), (e) => e.code === 'gone' && e.exit === EXIT.NOT_FOUND);
  });

  it('maps invalid arguments to a usage error (exit 2) with the server message', async () => {
    await assert.rejects(mcpCall('search_servers', { category: 'nope-cat' }, opts()), (e) => {
      assert.equal(e.code, 'invalid_argument');
      assert.equal(e.exit, EXIT.USAGE);
      assert.match(e.message, /Unknown category "nope-cat"/);
      return true;
    });
  });

  it('retries a 429 and reports retries', async () => {
    fake.rateLimit(1, '0');
    const notices = [];
    const data = await mcpCall('list_categories', {}, { ...opts(), onRetry: (i) => notices.push(i) });
    assert.ok(data.categories.length > 0);
    assert.equal(notices.length, 1);
    assert.equal(fake.requests.length, 2);
  });

  it('reports a server error', async () => {
    fake.fail(1, 502);
    await assert.rejects(mcpCall('list_categories', {}, opts()), (e) => e.code === 'server_error' && e.details.status === 502);
  });

  it('reports a Cloudflare block', async () => {
    fake.block(1, '1010');
    await assert.rejects(mcpCall('list_categories', {}, opts()), (e) => e.code === 'blocked');
  });
});

describe('parseRpcBody()', () => {
  it('reads JSON and SSE bodies', () => {
    assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":{}}', 'application/json', 3), { jsonrpc: '2.0', id: 3, result: {} });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"a":1}}\n\n';
    assert.deepEqual(parseRpcBody(sse, 'text/event-stream', 7).result, { a: 1 });
    assert.equal(parseRpcBody('<html>', 'text/html', 1), null);
    assert.equal(parseRpcBody('{"jsonrpc":"2.0","id":9,"result":{}}', 'application/json', 1), null);
  });
});

describe('listingJson() and listingExists()', () => {
  it('reads a listing', async () => {
    const d = await listingJson('deepwiki', opts());
    assert.equal(d.slug, 'deepwiki');
    assert.equal(fake.requests[0].path, '/i/deepwiki.json');
  });
  it('asks for ?lang= only for a language other than English', async () => {
    const d = await listingJson('notion', { ...opts(), lang: 'it' });
    assert.equal(d.lang, 'it');
    assert.equal(fake.requests[0].path, '/i/notion.json?lang=it');
    await listingJson('deepwiki', { ...opts(), lang: 'en' });
    assert.equal(fake.requests[1].path, '/i/deepwiki.json');
  });
  it('404 is not_found and 410 is gone, both exit 3', async () => {
    await assert.rejects(listingJson('zz-none', opts()), (e) => e.code === 'not_found' && e.exit === 3);
    await assert.rejects(listingJson(GONE_SLUG, opts()), (e) => e.code === 'gone' && e.exit === 3);
    await assert.rejects(listingExists('zz-none', opts()), (e) => e.code === 'not_found');
    assert.equal(await listingExists('deepwiki', opts()), true);
    assert.equal(fake.requests.at(-1).method, 'HEAD');
  });
  it('refuses something that is not a slug before any request', async () => {
    await assert.rejects(listingJson('a b', opts()), (e) => e.code === 'invalid_slug');
    assert.equal(fake.requests.length, 0);
  });
});

describe('addressForLookup()', () => {
  it('drops credentials, query and fragment from URLs', () => {
    assert.equal(addressForLookup('https://user:secret@mcp.example.com/mcp?api_key=abc#x'), 'https://mcp.example.com/mcp');
    assert.equal(addressForLookup('mcp.example.com/sse?token=1'), 'https://mcp.example.com/sse');
    assert.equal(addressForLookup('https://example.com/'), 'https://example.com');
    assert.equal(addressForLookup('https://github.com/acme/server'), 'https://github.com/acme/server');
  });
  it('keeps package names without versions', () => {
    assert.equal(addressForLookup('@modelcontextprotocol/server-memory@latest'), '@modelcontextprotocol/server-memory');
    assert.equal(addressForLookup('@scope/pkg'), '@scope/pkg');
    assert.equal(addressForLookup('ref-tools-mcp@1.2.3', { registry: 'npm' }), 'https://www.npmjs.com/package/ref-tools-mcp');
    assert.equal(addressForLookup('mcp-server-fetch==1.0', { registry: 'pypi' }), 'https://pypi.org/project/mcp-server-fetch');
  });
  it('returns null for plain words, spaces, other schemes and long input', () => {
    assert.equal(addressForLookup('github'), null);
    assert.equal(addressForLookup('two words'), null);
    assert.equal(addressForLookup('ftp://example.com/x'), null);
    assert.equal(addressForLookup('x'.repeat(301)), null);
    assert.equal(addressForLookup(''), null);
  });
});

describe('lookupAddress()', () => {
  it('follows the 303 to a listing slug', async () => {
    assert.equal(await lookupAddress('https://mcp.deepwiki.com/mcp', opts()), 'deepwiki');
    const r = fake.requests[0];
    assert.equal(r.method, 'GET');
    assert.equal(r.path, `/directory?q=${encodeURIComponent('https://mcp.deepwiki.com/mcp')}`);
  });
  it('sends only the cleaned address', async () => {
    await lookupAddress('https://me:pw@mcp.deepwiki.com/mcp?key=SECRET', opts());
    const sent = decodeURIComponent(fake.requests[0].path);
    assert.ok(!sent.includes('SECRET') && !sent.includes('me:pw') && !sent.includes('key='), sent);
    assert.equal(fake.requests[0].headers.authorization, undefined);
  });
  it('returns null for an address that is not listed (303 to the suggest form)', async () => {
    assert.equal(await lookupAddress('https://example.com/mcp', opts()), null);
  });
  it('returns null for a plain search answer and sends nothing for plain words', async () => {
    assert.equal(await lookupAddress('@acme/unknown', opts()), null);
    assert.equal(fake.requests.length, 1);
    assert.equal(await lookupAddress('github', opts()), null);
    assert.equal(fake.requests.length, 1);
  });
  // review: a refusal or an error page must never read as "not listed" (scan would suggest a duplicate submission)
  it('a Cloudflare 1010 refusal (403, plain text, body not read): throws "blocked"', async () => {
    fake.block(1, '1010');
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'blocked' && e.exit === EXIT.ERROR && /HTTP 403/.test(e.message));
  });
  it('a 403 that is not from Cloudflare: still "blocked"', async () => {
    fake.respond(403, 'Forbidden', { 'Content-Type': 'text/plain' });
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'blocked');
  });
  it('404 and other statuses throw "unexpected_status"; 5xx "server_error"', async () => {
    fake.fail(1, 404);
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'unexpected_status' && e.details.status === 404);
    fake.fail(1, 410);
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'unexpected_status');
    fake.fail(1, 503);
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'server_error');
  });
  it('a redirect that is neither a listing nor the suggest form throws; one to the suggest form in another language is "not listed"', async () => {
    fake.respond(302, '', { Location: 'https://elsewhere.example.com/i/deepwiki' });
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'unexpected_status');
    fake.respond(303, '', {});
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'unexpected_status' && /without a location/.test(e.message));
    fake.respond(303, '', { Location: '/login' });
    await assert.rejects(lookupAddress('https://mcp.deepwiki.com/mcp', opts()), (e) => e.code === 'unexpected_status');
    fake.respond(303, '', { Location: '/de/submit?url=x' });
    assert.equal(await lookupAddress('https://mcp.deepwiki.com/mcp', opts()), null);
    fake.respond(303, '', { Location: '/it/i/deepwiki' });
    assert.equal(await lookupAddress('https://mcp.deepwiki.com/mcp', opts()), 'deepwiki');
  });
});

describe('index()', () => {
  it('fetches the index once per process', async () => {
    const a = await index(opts());
    const b = await index(opts());
    assert.equal(a, b);
    assert.ok(a.some((e) => e.s === 'deepwiki'));
    assert.equal(fake.requests.filter((r) => r.path === '/api/index.json').length, 1);
  });
  it('does not keep a failed fetch', async () => {
    fake.fail(1, 500);
    await assert.rejects(index(opts()), (e) => e.code === 'server_error');
    const a = await index(opts());
    assert.ok(Array.isArray(a));
  });
});

// Read-only checks against https://mcp.tc: four requests, one second apart. Run with MCPTC_LIVE=1.
describe('live mcp.tc (MCPTC_LIVE=1)', { skip: process.env.MCPTC_LIVE !== '1' && 'set MCPTC_LIVE=1 to run against https://mcp.tc' }, () => {
  const live = { base: 'https://mcp.tc' };
  const pause = () => new Promise((r) => setTimeout(r, 1000));
  it('search_servers answers in the recorded shape', async () => {
    const d = await mcpCall('search_servers', { query: 'github', limit: 2 }, live);
    assert.ok(Number.isInteger(d.total) && d.count <= 2);
    for (const r of d.results) for (const k of ['name', 'slug', 'link', 'tagline', 'auth', 'kind', 'verified']) assert.ok(k in r, k);
  });
  it('get_server gives the vendor URL', async () => {
    await pause();
    const d = await mcpCall('get_server', { slug: 'deepwiki' }, live);
    assert.equal(d.slug, 'deepwiki');
    assert.match(d.endpoint, /^https:\/\//);
    assert.ok(!d.endpoint.startsWith('https://mcp.tc/'));
    assert.ok(Array.isArray(d.setup) && d.setup.length > 0);
  });
  it('/i/{slug}.json has the embed addresses', async () => {
    await pause();
    const d = await listingJson('deepwiki', live);
    for (const k of ['badge', 'widget', 'iframe']) assert.match(d.embeds[k], /^https:\/\/mcp\.tc\//);
  });
  it('/directory?q= answers 303 for a listed server URL', async () => {
    await pause();
    assert.equal(await lookupAddress('https://mcp.deepwiki.com/mcp', live), 'deepwiki');
  });
});
