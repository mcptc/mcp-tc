import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_INFO,
  MODERN_VERSION,
  isLoopback,
  maskUrl,
  messagesIn,
  normalizeEndpoint,
  parseChallenge,
  parseHeaderOptions,
  parseSse,
  probe,
  probeStdio,
  rebindingTest,
  redact,
  replyTo,
  resourceCovers,
  secretsInUrl,
  showCommand,
  splitCommand,
} from '../src/lib/mcp.js';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from '../src/version.js';
import { GOOD_TOOLS, manyTools, startFakeMcp } from './helpers/fake-mcp.js';

/** Start a fake, run fn, always close it. */
async function withFake(opts, fn) {
  const f = await startFakeMcp(opts);
  try {
    return await fn(f);
  } finally {
    await f.close();
  }
}

describe('parseHeaderOptions()', () => {
  it('reads "Name: value" pairs and returns only names for display', () => {
    const r = parseHeaderOptions(['Authorization: Bearer abc:def', 'X-Api-Key:  k1  ']);
    assert.deepEqual(r.headers, { Authorization: 'Bearer abc:def', 'X-Api-Key': 'k1' });
    assert.deepEqual(r.names, ['Authorization', 'X-Api-Key']);
    assert.deepEqual(parseHeaderOptions(undefined), { headers: {}, names: [] });
  });
  for (const bad of ['NoColon', ': value', 'Bad Name: x', 'X-Empty:', 'X-Evil: a\r\nHost: b', 'Host: evil', 'Mcp-Session-Id: x', 'Content-Type: text/plain', 'X-Key: caf\u00e9']) {
    it(`refuses ${JSON.stringify(bad)} with exit 2`, () => {
      assert.throws(() => parseHeaderOptions([bad]), (e) => e.exit === 2 && e.code === 'invalid_header');
    });
  }
});

describe('redact()', () => {
  it('hides header values anywhere in a value', () => {
    const v = { a: 'token SECRET123 echoed', b: ['x', 'SECRET123'], c: { d: 'no' }, n: 5 };
    assert.deepEqual(redact(v, ['SECRET123']), { a: 'token [hidden] echoed', b: ['x', '[hidden]'], c: { d: 'no' }, n: 5 });
    assert.deepEqual(redact(v, []), v);
  });
});

describe('security-header-partial-echo: redact() hides parts of a --header value too', () => {
  const secrets = ['Bearer FAKE-SECRET-TOKEN-1234567890', 'Basic dXNlcjpwYXNzd29yZA==', 'X-Key: k3y'];
  it('the bare token, in any letter case, and any run of 8 characters of it', () => {
    assert.equal(redact('token FAKE-SECRET-TOKEN-1234567890 expired', secrets), 'token [hidden] expired');
    assert.equal(redact('token fake-secret-token-1234567890', secrets), 'token [hidden]');
    assert.equal(redact('starts with FAKE-SECR...', secrets), 'starts with [hidden]...');
    assert.equal(redact('ends 1234567890.', secrets), 'ends [hidden].');
    assert.equal(redact('basic part dXNlcjpwYXNzd29yZA== seen', secrets), 'basic part [hidden] seen');
  });
  it('leaves the words around it, "Bearer" and short pieces alone', () => {
    assert.equal(redact('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"', secrets), 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"');
    assert.equal(redact('nothing to hide: FAKE-SE', secrets), 'nothing to hide: FAKE-SE');
    assert.equal(redact('a value k3y', ['k3y']), 'a value k3y', 'values under 4 characters are not hidden');
    assert.deepEqual(redact({ list: ['x FAKE-SECRET-TOKEN y'], n: 1 }, secrets), { list: ['x [hidden] y'], n: 1 });
  });
});

describe('secretsInUrl() and maskUrl()', () => {
  it('finds credential-like query parameters and token-like path segments', () => {
    assert.deepEqual(secretsInUrl('https://x.example/mcp?api_key=abcdef123456&lang=en'), [{ where: 'query', name: 'api_key', kind: 'key' }]);
    assert.deepEqual(secretsInUrl('https://x.example/mcp?token=zz9988776655'), [{ where: 'query', name: 'token', kind: 'key' }]);
    assert.deepEqual(secretsInUrl('https://x.example/s/sk-abcdefghijklmnop/mcp'), [{ where: 'path', name: 'segment 2', kind: 'key' }]);
    assert.deepEqual(secretsInUrl('https://x.example/u/Zx81kQp02LmNv7RtYw3sAb9/mcp'), [{ where: 'path', name: 'segment 2', kind: 'key' }]);
    assert.deepEqual(secretsInUrl('https://x.example/t/123e4567-e89b-12d3-a456-426614174000/mcp'), [{ where: 'path', name: 'segment 2', kind: 'id' }]);
  });
  it('leaves ordinary URLs alone', () => {
    for (const u of ['https://mcp.example.com/mcp', 'https://api.example.com/v1/mcp?lang=en', 'https://x.example/key/mcp?key=a', 'http://localhost:3000/mcp', 'https://x.example/my-server-version-2024/mcp']) {
      assert.deepEqual(secretsInUrl(u), [], u);
    }
  });
  it('masks what it finds, keeps the rest', () => {
    assert.equal(maskUrl('https://x.example/mcp?api_key=abcdef123456&lang=en'), 'https://x.example/mcp?api_key=***&lang=en');
    assert.equal(maskUrl('https://x.example/s/sk-abcdefghijklmnop/mcp'), 'https://x.example/s/***/mcp');
    assert.equal(maskUrl('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp');
  });
});

describe('normalizeEndpoint() and isLoopback()', () => {
  it('adds https:// to a bare host and drops the fragment', () => {
    assert.equal(normalizeEndpoint('mcp.example.com/mcp#x'), 'https://mcp.example.com/mcp');
    assert.equal(normalizeEndpoint('http://localhost:3000/mcp'), 'http://localhost:3000/mcp');
  });
  for (const bad of ['', 'ftp://x.example/mcp', 'https://user:pass@x.example/mcp', 'http://']) {
    it(`refuses ${JSON.stringify(bad)}`, () => assert.throws(() => normalizeEndpoint(bad), (e) => e.exit === 2));
  }
  it('knows the addresses of this computer', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '0.0.0.0']) assert.ok(isLoopback(h), h);
    for (const h of ['example.com', '10.0.0.1', 'localhost.example.com']) assert.ok(!isLoopback(h), h);
  });
});

describe('JSON-RPC bodies', () => {
  it('parseSse() reads events with comments, CRLF and multi-line data, and keeps a partial event', () => {
    const buf = ': hello\r\n\r\nevent: message\r\ndata: {"a":\r\ndata: 1}\r\n\r\nid: 3\ndata: two\n\ndata: part';
    const r = parseSse(buf);
    assert.deepEqual(r.events, [
      { event: 'message', data: '{"a":\n1}' },
      { event: '', data: 'two' },
    ]);
    assert.equal(buf.slice(r.pos), 'data: part');
    assert.deepEqual(parseSse(buf, r.pos, true).events, [{ event: '', data: 'part' }]);
  });
  it('replyTo() finds the reply to an id in JSON, a batch or an SSE stream', () => {
    assert.equal(replyTo('{"jsonrpc":"2.0","id":7,"result":{"ok":1}}', 'application/json', 7).result.ok, 1);
    const batch = '[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":"2","result":{"n":2}}]';
    assert.equal(replyTo(batch, 'application/json', 2).result.n, 2);
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' + 'event: message\ndata: {"jsonrpc":"2.0","id":5,"method":"ping"}\n\n' + 'event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"x":true}}\n\n';
    assert.equal(replyTo(sse, 'text/event-stream', 5).result.x, true);
    assert.equal(replyTo('{"jsonrpc":"2.0","id":9,"result":{}}', 'application/json', 1), null);
    assert.equal(replyTo('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}', 'application/json', 1).error.code, -32700);
    assert.equal(replyTo('not json', 'application/json', 1), null);
    assert.deepEqual(messagesIn('', 'application/json'), []);
  });
  it('parseChallenge() reads the Bearer challenge', () => {
    const c = parseChallenge('Basic realm="x", Bearer resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp", scope="read write", error=invalid_token');
    assert.equal(c.scheme, 'Bearer');
    assert.equal(c.params.resource_metadata, 'https://a.example/.well-known/oauth-protected-resource/mcp');
    assert.equal(c.params.scope, 'read write');
    assert.equal(c.params.error, 'invalid_token');
    assert.equal(parseChallenge('Bearer realm="say \\"hi\\""').params.realm, 'say "hi"');
    assert.equal(parseChallenge('Basic realm="x"'), null);
    assert.equal(parseChallenge(''), null);
  });
  it('resourceCovers() wants the same origin and the endpoint at or below the resource path', () => {
    const t = [
      ['https://a.example', 'https://a.example/mcp', true],
      ['https://a.example/mcp', 'https://a.example/mcp', true],
      ['https://a.example/mcp/', 'https://a.example/mcp', true],
      ['https://a.example/api', 'https://a.example/api/mcp', true],
      ['https://a.example/mc', 'https://a.example/mcp', false],
      ['https://b.example/mcp', 'https://a.example/mcp', false],
      ['https://a.example:8443/mcp', 'https://a.example/mcp', false],
      ['http://a.example/mcp', 'https://a.example/mcp', false],
      ['not a url', 'https://a.example/mcp', false],
    ];
    for (const [res, ep, want] of t) assert.equal(resourceCovers(res, ep), want, `${res} vs ${ep}`);
  });
});

describe('probe(): Streamable HTTP, 2026-07-28 style', () => {
  it('uses server/discover with the protocol headers and _meta, then tools/list, and no initialize', async () => {
    await withFake({}, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, true);
      assert.equal(r.era, 'modern');
      assert.equal(r.protocol_version, MODERN_VERSION);
      assert.deepEqual(r.supported_versions, [MODERN_VERSION]);
      assert.equal(r.transport, 'streamable-http');
      assert.equal(r.reply_format, 'json');
      assert.equal(r.auth.kind, 'none');
      assert.equal(r.server.name, 'fake-docs');
      assert.equal(r.server.title, 'Fake Docs');
      assert.equal(r.tools_count, 2);
      assert.equal(r.tools[0].read_only, true);
      assert.equal(r.tools[0].input_schema, 'object');
      assert.match(r.instructions, /search_docs/);
      const calls = f.rpc();
      assert.deepEqual(calls.map((c) => c.method), ['server/discover', 'tools/list']);
      for (const c of calls) {
        assert.equal(c.headers['mcp-protocol-version'], MODERN_VERSION);
        assert.equal(c.headers['mcp-method'], c.method);
        assert.equal(c.headers['user-agent'], USER_AGENT);
        assert.equal(c.params._meta['io.modelcontextprotocol/protocolVersion'], MODERN_VERSION);
        assert.equal(c.params._meta['io.modelcontextprotocol/clientInfo'].name, CLIENT_INFO.name);
        assert.match(c.headers.accept, /application\/json/);
        assert.match(c.headers.accept, /text\/event-stream/);
      }
    });
  });
  it('bothEras also tries initialize and records whether legacy clients get in', async () => {
    await withFake({}, async (f) => {
      const r = await probe(f.url, { bothEras: true });
      assert.equal(r.era, 'modern');
      assert.equal(r.eras.modern.ok, true);
      assert.equal(r.eras.legacy.ok, true);
      assert.equal(r.eras.legacy.protocol_version, '2025-11-25');
    });
    await withFake({ legacy: false }, async (f) => {
      const r = await probe(f.url, { bothEras: true });
      assert.equal(r.eras.modern.ok, true);
      assert.equal(r.eras.legacy.ok, false);
    });
  });
  it('switches to the version a newer server names after -32022', async () => {
    await withFake({ modernVersions: ['2027-01-15'] }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, true);
      assert.equal(r.protocol_version, '2027-01-15');
      const discovers = f.rpc().filter((c) => c.method === 'server/discover');
      assert.deepEqual(discovers.map((c) => c.headers['mcp-protocol-version']), ['2026-07-28', '2027-01-15']);
    });
  });
  it('legacyVersions learns which initialize versions the server agrees to', async () => {
    await withFake({ modern: false, legacyVersions: ['2025-06-18', '2025-03-26'] }, async (f) => {
      const r = await probe(f.url, { legacyVersions: true });
      assert.equal(r.protocol_version, '2025-06-18');
      assert.deepEqual(r.legacy_versions, ['2025-06-18', '2025-03-26']);
    });
  });
});

describe('probe(): the initialize handshake', () => {
  for (const modernReply of ['method-not-found', 'not-initialized', 'http-404']) {
    it(`falls back to initialize when server/discover gets ${modernReply}`, async () => {
      await withFake({ modern: false, modernReply }, async (f) => {
        const r = await probe(f.url);
        assert.equal(r.mcp, true);
        assert.equal(r.era, 'legacy');
        assert.equal(r.protocol_version, '2025-11-25');
        assert.equal(r.eras.modern.ok, false);
        assert.equal(r.tools_count, 2);
        const methods = f.rpc().map((c) => c.method);
        assert.deepEqual(methods, ['server/discover', 'initialize', 'notifications/initialized', 'tools/list']);
        const init = f.rpc()[1];
        assert.equal(init.params.protocolVersion, '2025-11-25');
        assert.equal(init.params.clientInfo.name, CLIENT_INFO.name);
        assert.equal(f.rpc()[3].headers['mcp-protocol-version'], '2025-11-25');
      });
    });
  }
  it('SSE replies, a session id on every request, and DELETE at the end', async () => {
    await withFake({ modern: false, reply: 'sse', session: true }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, true);
      assert.equal(r.reply_format, 'sse');
      assert.equal(r.session.issued, true);
      assert.equal(r.session.ended, true);
      assert.deepEqual(f.deleted, ['fake-session-1']);
      const list = f.rpc().find((c) => c.method === 'tools/list');
      assert.equal(list.headers['mcp-session-id'], 'fake-session-1');
      const del = f.requests.find((q) => q.method === 'DELETE');
      assert.equal(del.headers['mcp-session-id'], 'fake-session-1');
    });
  });
  it('stops reading an SSE reply that stays open once the answer is in', async () => {
    await withFake({ modern: false, reply: 'sse', sseKeepOpen: true }, async (f) => {
      const t0 = Date.now();
      const r = await probe(f.url, { timeout: 5000 });
      assert.equal(r.mcp, true);
      assert.equal(r.tools_count, 2);
      assert.ok(Date.now() - t0 < 3000, 'did not wait for the stream to end');
    });
  });
});

describe('probe(): lists', () => {
  it('follows nextCursor through the pages', async () => {
    await withFake({ tools: manyTools(25), pageSize: 10 }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.tools_count, 25);
      assert.equal(r.tools_pages, 3);
      assert.equal(r.tools_truncated, false);
      const cursors = f.rpc().filter((c) => c.method === 'tools/list').map((c) => c.params.cursor);
      assert.deepEqual(cursors, [undefined, 'c10', 'c20']);
    });
  });
  it('stops at 20 pages or 1000 tools', async () => {
    await withFake({ tools: manyTools(1100), pageSize: 50 }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.tools_count, 1000);
      assert.equal(r.tools_pages, 20);
      assert.equal(r.tools_truncated, true);
    });
  });
  it('counts prompts and resources when offered, and skips tools when the capability is missing', async () => {
    await withFake({ prompts: [{ name: 'p1' }, { name: 'p2' }], resources: [{ uri: 'file:///a', name: 'a' }] }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.prompts_count, 2);
      assert.equal(r.resources_count, 1);
      assert.deepEqual(r.capabilities, ['tools', 'prompts', 'resources']);
    });
    await withFake({ capabilities: { prompts: {} }, prompts: [{ name: 'p' }] }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.tools_listed, false);
      assert.equal(r.tools_count, null);
      assert.ok(!f.rpc().some((c) => c.method === 'tools/list'));
    });
  });
  it('keeps odd tools apart: no name, no inputSchema', async () => {
    const tools = [...GOOD_TOOLS, { description: 'nameless' }, 'junk', { name: 'loose', description: 'No schema here at all.' }];
    await withFake({ tools }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.tools_count, 5);
      assert.equal(r.tools_invalid, 2);
      assert.equal(r.tools.find((t) => t.name === 'loose').input_schema, 'missing');
    });
  });
  it('cleans untrusted text from the server', async () => {
    const evil = '\u001b[31mred\u001b[0m\u202Etxt\u0007';
    await withFake({ serverInfo: { name: evil, title: `T${evil}` }, tools: [{ ...GOOD_TOOLS[0], description: `D${evil}` }] }, async (f) => {
      const r = await probe(f.url);
      const all = JSON.stringify(r);
      assert.ok(!all.includes('\\u001b'), 'no escape sequences');
      assert.ok(!all.includes('\\u202e'), 'no bidi marks');
      assert.match(r.server.name, /^\[31mred\[0mtxt$/);
    });
  });
});

describe('probe(): sign-in', () => {
  it('401 with resource_metadata: OAuth, with both metadata documents', async () => {
    await withFake({ auth: 'oauth' }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.reachable, true);
      assert.equal(r.mcp, false);
      assert.equal(r.auth.kind, 'oauth');
      assert.equal(r.auth.prm.ok, true);
      assert.equal(r.auth.prm.source, 'header');
      assert.equal(r.auth.prm.resource, f.url);
      assert.deepEqual(r.auth.prm.authorization_servers, [f.base]);
      assert.equal(r.auth.as.ok, true);
      assert.deepEqual(r.auth.as.code_challenge_methods_supported, ['S256']);
      assert.ok(r.auth.as.registration_endpoint);
      assert.equal(r.error, null);
    });
  });
  it('finds the metadata at the well-known address when the challenge does not name it', async () => {
    await withFake({ auth: 'oauth', prmHeader: false }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.auth.kind, 'oauth');
      assert.equal(r.auth.prm.source, 'well-known');
    });
  });
  it('refuses metadata for another resource', async () => {
    await withFake({ auth: 'oauth', prm: { resource: 'http://127.0.0.1:1/other' }, asServed: false }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.auth.prm, null);
      assert.ok(r.auth.prm_attempts.some((p) => p.problem === 'resource_mismatch'));
      assert.equal(r.auth.kind, 'api_key');
    });
  });
  it('401 without a Bearer challenge: a key or token', async () => {
    await withFake({ auth: 'apikey' }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.auth.kind, 'api_key');
      assert.equal(r.reachable, true);
      assert.equal(r.blocked, false);
    });
  });
  it('a firewall page is reported as blocked', async () => {
    await withFake({ auth: 'waf' }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.blocked, true);
      assert.equal(r.auth.kind, 'unknown');
      assert.match(r.error, /firewall or bot check \(HTTP 403\)/);
    });
  });
  it('WWW-Authenticate on a 200: sign-in is optional', async () => {
    await withFake({ auth: 'optional' }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, true);
      assert.equal(r.auth.kind, 'optional');
    });
  });
  it('handshake open but tools/list behind sign-in', async () => {
    await withFake({ auth: 'tools' }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, true);
      assert.equal(r.tools_listed, false);
      assert.match(r.tools_error, /needs sign-in/);
      assert.equal(r.auth.kind, 'oauth');
    });
  });
  it('--header values reach MCP requests only, and never the output', async () => {
    await withFake({ auth: 'oauth' }, async (f) => {
      const r = await probe(f.url, { headers: { Authorization: 'Bearer test-token' } });
      assert.equal(r.mcp, true);
      assert.equal(r.auth.with_your_headers, true);
      assert.deepEqual(r.headers_sent, ['Authorization']);
      assert.ok(!JSON.stringify(r).includes('test-token'));
      for (const q of f.requests) {
        if (q.method === 'POST') assert.equal(q.headers.authorization, 'Bearer test-token');
        else assert.equal(q.headers.authorization, undefined, `${q.method} ${q.path}`);
      }
    });
  });
  it('drops --header values on a redirect to another origin', async () => {
    await withFake({}, async (target) => {
      await withFake({ redirectTo: target.url }, async (first) => {
        const r = await probe(first.url, { headers: { Authorization: 'Bearer test-token' } });
        assert.equal(r.mcp, true);
        assert.equal(r.redirects.length > 0, true);
        assert.equal(r.redirects[0].cross_origin, true);
        assert.equal(r.endpoint, target.url);
        assert.ok(first.requests.some((q) => q.headers.authorization === 'Bearer test-token'));
        assert.ok(target.requests.every((q) => q.headers.authorization === undefined));
      });
    });
  });
});

describe('probe(): the HTTP+SSE transport and failures', () => {
  it('speaks the old HTTP+SSE transport: GET stream, endpoint event, replies on the stream', async () => {
    await withFake({ legacySse: true, path: '/sse', tools: manyTools(7), pageSize: 3 }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, true);
      assert.equal(r.transport, 'sse');
      assert.equal(r.protocol_version, '2024-11-05');
      assert.equal(r.tools_count, 7);
      assert.equal(r.eras.sse.ok, true);
      assert.ok(f.requests.some((q) => q.method === 'GET' && q.path === '/sse'));
      assert.ok(f.requests.some((q) => q.method === 'POST' && q.path.startsWith('/messages?sessionId=')));
    });
  });
  it('a server that does not answer in time', async () => {
    await withFake({ delayMs: 2000 }, async (f) => {
      const r = await probe(f.url, { timeout: 300 });
      assert.equal(r.reachable, false);
      assert.match(r.error, /no answer within/);
    });
  });
  it('nothing listening on the port', async () => {
    const f = await startFakeMcp();
    const url = f.url;
    await f.close();
    const r = await probe(url, { timeout: 2000 });
    assert.equal(r.reachable, false);
    assert.match(r.error, /refused the connection/);
  });
  it('cut-off JSON', async () => {
    await withFake({ broken: true }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.reachable, true);
      assert.equal(r.mcp, false);
      assert.match(r.error, /not valid JSON-RPC/);
    });
  });
  it('a web page', async () => {
    await withFake({ html: true }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.html, true);
      assert.equal(r.mcp, false);
      assert.match(r.error, /web page/);
    });
  });
  it('a server error', async () => {
    await withFake({ status: 500 }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, false);
      assert.match(r.error, /HTTP 500/);
    });
  });
  it('429 with Retry-After', async () => {
    await withFake({ rateLimit: 5 }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.retry_after, 0);
      assert.match(r.error, /HTTP 429/);
    });
  });
  it('410 that names the new URL', async () => {
    await withFake({ gone: 'https://new.example/mcp' }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.moved_to, 'https://new.example/mcp');
    });
  });
  it('an address that points to the real endpoint (like a directory page)', async () => {
    await withFake({ pointTo: 'https://vendor.example/mcp' }, async (f) => {
      const r = await probe(f.url);
      assert.equal(r.mcp, false);
      assert.equal(r.points_to.endpoint, 'https://vendor.example/mcp');
    });
  });
});

describe('probe(): server cards and DNS rebinding', () => {
  it('reads <endpoint>/server-card and /.well-known/mcp/server-card.json', async () => {
    const card = { $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json', name: 'com.example/docs', description: 'Docs', version: '1.2.3' };
    await withFake({ card, wellKnownCard: card }, async (f) => {
      const r = await probe(f.url, { cards: true });
      assert.equal(r.cards.length, 2);
      assert.deepEqual(r.cards.map((c) => c.found), [true, true]);
      assert.equal(r.cards[0].url, `${f.url}/server-card`);
      assert.equal(r.cards[0].cors, '*');
      assert.match(r.cards[0].content_type, /mcp-server-card\+json/);
      assert.equal(r.cards[0].card.name, 'com.example/docs');
      assert.equal(f.requests.find((q) => q.path === '/mcp/server-card').headers.accept.split(',')[0], 'application/mcp-server-card+json');
    });
    await withFake({}, async (f) => {
      const r = await probe(f.url, { cards: true });
      assert.deepEqual(r.cards.map((c) => [c.status, c.found]), [[404, false], [404, false]]);
    });
  });
  it('tells a server that refuses a foreign Host and Origin from one that does not', async () => {
    await withFake({ hostCheck: true, originCheck: true }, async (f) => {
      const r = await probe(f.url);
      const rb = await rebindingTest(r);
      assert.deepEqual(rb, { origin: { accepted: false, status: 403, error: null }, host: { accepted: false, status: 403, error: null } });
      const sent = f.requests.filter((q) => q.headers.origin === 'http://mcp-tc-check.invalid' || /mcp-tc-check\.invalid/.test(q.headers.host));
      assert.equal(sent.length, 2);
    });
    await withFake({ modern: false, session: true }, async (f) => {
      const r = await probe(f.url);
      const rb = await rebindingTest(r);
      assert.equal(rb.origin.accepted, true);
      assert.equal(rb.host.accepted, true);
      assert.equal(f.sessions.size, 0, 'sessions opened by the test are ended');
    });
  });
});

describe('stdio', () => {
  const FAKE = fileURLToPath(new URL('./helpers/fake-mcp.js', import.meta.url));
  /** Start the stdio fake with these options. */
  const run = (o = {}, opts = {}) => probeStdio(process.execPath, [FAKE, '--fake-stdio', JSON.stringify(o)], { timeout: 3000, ...opts });

  it('splitCommand() splits like a shell would, without running one', () => {
    assert.deepEqual(splitCommand('node bin/server.js --port 3000'), ['node', 'bin/server.js', '--port', '3000']);
    assert.deepEqual(splitCommand(`python -m "my server" 'a b' c\\ d`), ['python', '-m', 'my server', 'a b', 'c d']);
    assert.deepEqual(splitCommand('node C:\\dir\\x.js ""'), ['node', 'C:\\dir\\x.js', '']);
    assert.deepEqual(splitCommand('  '), []);
    assert.throws(() => splitCommand('node "open'), (e) => e.code === 'invalid_command');
    assert.equal(showCommand(['node', 'a b', "it's"]), "node 'a b' 'it'\\''s'");
  });
  it('2026-07-28 style over stdio, then initialize with bothEras', async () => {
    const r = await run({}, { bothEras: true });
    assert.equal(r.mcp, true);
    assert.equal(r.era, 'modern');
    assert.equal(r.transport, 'stdio');
    assert.equal(r.tools_count, 2);
    assert.equal(r.server.name, 'fake-stdio');
    assert.equal(r.eras.legacy.ok, true);
    assert.deepEqual(r.stdio.exit, { code: 0, signal: null });
  });
  it('initialize when server/discover is refused, with pages', async () => {
    const r = await run({ modern: false, tools: Array.from({ length: 7 }, (_, i) => ({ name: `t${i}`, description: 'A tool for the test suite.', inputSchema: { type: 'object' } })), pageSize: 3 });
    assert.equal(r.era, 'legacy');
    assert.equal(r.protocol_version, '2025-11-25');
    assert.equal(r.tools_count, 7);
    assert.equal(r.tools_pages, 3);
  });
  it('a server that ignores server/discover: waits briefly, then initialize', async () => {
    const t0 = Date.now();
    const r = await run({ modern: false, ignoreDiscover: true }, { timeout: 1000 });
    assert.equal(r.mcp, true);
    assert.equal(r.era, 'legacy');
    assert.match(r.eras.modern.error, /no reply to server\/discover within 1 s/);
    assert.ok(Date.now() - t0 < 2500);
  });
  it('answers the server\'s ping and counts non-JSON lines on stdout', async () => {
    const r = await run({ modern: false, pingFirst: true, noise: true });
    assert.equal(r.mcp, true);
    assert.equal(r.stdio.stdout_noise, 1);
  });
  it('a server that crashes: the error and its stderr', async () => {
    const r = await run({ crash: true });
    assert.equal(r.mcp, false);
    assert.match(r.error, /exited \(code 1\) before answering/);
    assert.match(r.stdio.stderr_tail, /Cannot find module 'zod'/);
  });
  it('a server that keeps running after stdin closes is stopped', async () => {
    const r = await run({ modern: false, hang: true });
    assert.equal(r.mcp, true);
    assert.equal(r.stdio.exit.signal, 'SIGTERM');
  });
  it('a command that does not exist', async () => {
    const r = await probeStdio('mcp-tc-no-such-command-xyz', [], { timeout: 1000 });
    assert.equal(r.mcp, false);
    assert.match(r.error, /command not found/);
  });
});
