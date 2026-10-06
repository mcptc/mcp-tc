import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, verdict } from '../src/commands/doctor.js';
import { EXIT } from '../src/lib/errors.js';
import { fixture, runCli } from './helpers/fake-directory.js';
import { startFakeMcp } from './helpers/fake-mcp.js';

/** get_server answers recorded from mcp.tc, pointed at the local fake server. */
function listings(fake) {
  const remote = structuredClone(fixture('mcp-get-deepwiki').message.result.structuredContent);
  remote.slug = 'fake';
  remote.name = 'Fake Docs';
  remote.link = 'https://mcp.tc/i/fake';
  remote.endpoint = fake.url;
  const signin = { ...structuredClone(remote), slug: 'fake-signin', auth: 'none' };
  const local = structuredClone(fixture('mcp-get-memory').message.result.structuredContent);
  const shell = { ...structuredClone(local), slug: 'shell-steps', name: 'Shell Steps', install_command: null, homepage: 'https://vendor.example/install' };
  return { fake: remote, 'fake-signin': signin, memory: local, 'shell-steps': shell };
}

let fake;
/** Run doctor with mcp.tc's base pointed at the fake's /dir stand-in. */
const doctor = (args) => runCli(['doctor', ...args], { env: { MCPTC_BASE_URL: `${fake.base}/dir` } });

before(async () => {
  fake = await startFakeMcp();
  fake.set({ directory: listings(fake) });
});
after(() => fake.close());

describe('resolveTarget()', () => {
  const t = [
    ['https://mcp.example.com/mcp', { kind: 'url', url: 'https://mcp.example.com/mcp' }],
    ['mcp.example.com/mcp', { kind: 'url', url: 'https://mcp.example.com/mcp' }],
    ['localhost:3000/mcp', { kind: 'url', url: 'http://localhost:3000/mcp' }],
    ['127.0.0.1:8080', { kind: 'url', url: 'http://127.0.0.1:8080' }],
    ['https://mcp.tc/i/notion', { kind: 'listing', slug: 'notion' }],
    ['mcp.tc/it/i/notion', { kind: 'listing', slug: 'notion' }],
    ['notion', { kind: 'listing', slug: 'notion' }],
    ['Hugging Face', { kind: 'listing', slug: 'Hugging Face' }],
    ['something-mcp-2025-edition', { kind: 'listing', slug: 'something-mcp-2025-edition' }],
    // security-doctor-creds-sent-to-mcptc: with a user name, a path or a query, the input is a URL (checked locally)
    ['admin:Sup3rSecret@mcp.internal.example.com/mcp', { kind: 'url', url: 'https://admin:Sup3rSecret@mcp.internal.example.com/mcp' }],
    ['ghp_FAKEtoken1234567890@api.example.com/mcp', { kind: 'url', url: 'https://ghp_FAKEtoken1234567890@api.example.com/mcp' }],
    ['host/path?key=value', { kind: 'url', url: 'https://host/path?key=value' }],
    ['ftp://mcp.example.com/mcp', { kind: 'url', url: 'ftp://mcp.example.com/mcp' }],
  ];
  for (const [input, want] of t) {
    it(`${input} -> ${want.kind}`, () => assert.deepEqual(resolveTarget(input, 'https://mcp.tc'), want));
  }
});

describe('mcp-tc doctor <url>', () => {
  it('reports a working server: exit 0, human summary', async () => {
    fake.reset();
    const r = await doctor([fake.url]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Server URL\s+http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.match(r.stdout, /Protocol\s+2026-07-28 \(server\/discover\)/);
    assert.match(r.stdout, /Transport\s+Streamable HTTP, JSON replies/);
    assert.match(r.stdout, /Access\s+No sign-in/);
    assert.match(r.stdout, /Server\s+fake-docs 1\.2\.3 \(Fake Docs\)/);
    assert.match(r.stdout, /Tools\s+2 \(2 read-only\)/);
    assert.match(r.stdout, /The server answers MCP without sign-in\./);
    assert.match(r.stderr, /^Connecting to http:\/\/127\.0\.0\.1:\d+\/mcp \.\.\./);
    assert.ok(!fake.requests.some((q) => q.path.startsWith('/dir')), 'no directory lookup for a URL');
  });

  it('--json: one document with stable keys', async () => {
    const r = await doctor([fake.url, '--json']);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    const d = r.json();
    assert.equal(d.ok, true);
    assert.equal(d.command, 'doctor');
    assert.equal(d.verdict, 'ok');
    assert.equal(d.local, false);
    assert.equal(d.listing, null);
    for (const k of ['url', 'endpoint', 'reachable', 'mcp', 'status', 'error', 'era', 'protocol_version', 'supported_versions', 'transport', 'reply_format', 'session', 'server', 'auth', 'tools_count', 'tools', 'prompts_count', 'resources_count', 'redirects', 'headers_sent', 'timing']) {
      assert.ok(k in d.report, k);
    }
    assert.equal(d.report.tools.length, 2);
    assert.deepEqual(Object.keys(d.report.tools[0]), ['name', 'title', 'description', 'read_only', 'destructive']);
  });

  it('a legacy server with SSE replies and a session', async () => {
    const f = await startFakeMcp({ modern: false, reply: 'sse', session: true });
    try {
      const r = await doctor([f.url]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Protocol\s+2025-11-25 \(initialize\)/);
      assert.match(r.stdout, /replies as SSE streams/);
      assert.match(r.stdout, /Mcp-Session-Id issued, ended with DELETE/);
    } finally {
      await f.close();
    }
  });

  it('OAuth: exit 0, metadata summary, never signs in', async () => {
    const f = await startFakeMcp({ auth: 'oauth' });
    try {
      const r = await doctor([f.url]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Access\s+Sign-in \(OAuth\)/);
      assert.match(r.stdout, /Metadata\s+http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp/);
      assert.match(r.stdout, /client registration: yes; PKCE S256: yes/);
      assert.match(r.stdout, /asks for OAuth sign-in/);
      assert.ok(!f.requests.some((q) => /authorize|token|register/.test(q.path)), 'no sign-in attempt');
      const j = (await doctor([f.url, '--json'])).json();
      assert.equal(j.verdict, 'sign_in');
      assert.equal(j.report.auth.kind, 'oauth');
      assert.equal(j.report.auth.resource_metadata.ok, true);
    } finally {
      await f.close();
    }
  });

  it('a key or token: exit 0, verdict api_key', async () => {
    const f = await startFakeMcp({ auth: 'apikey' });
    try {
      const r = await doctor([f.url, '--json']);
      assert.equal(r.code, 0);
      assert.equal(r.json().verdict, 'api_key');
    } finally {
      await f.close();
    }
  });

  it('--header: sent, named, never printed', async () => {
    const f = await startFakeMcp({ auth: 'oauth' });
    try {
      const r = await doctor([f.url, '--header', 'Authorization: Bearer test-token']);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /Your headers\s+Authorization/);
      assert.match(r.stdout, /with the headers you gave/);
      assert.ok(!r.stdout.includes('test-token') && !r.stderr.includes('test-token'));
      const j = await doctor([f.url, '--header', 'Authorization: Bearer test-token', '--json']);
      assert.ok(!j.stdout.includes('test-token'));
      assert.equal(j.json().report.mcp, true);
      const bad = await doctor([f.url, '--header', 'nonsense', '--json']);
      assert.equal(bad.code, EXIT.USAGE);
      assert.equal(bad.json().error.code, 'invalid_header');
    } finally {
      await f.close();
    }
  });

  it('unreachable: exit 5', async () => {
    const f = await startFakeMcp();
    const url = f.url;
    await f.close();
    const r = await doctor([url, '--json']);
    assert.equal(r.code, EXIT.UNREACHABLE);
    const d = r.json();
    assert.equal(d.ok, true);
    assert.equal(d.verdict, 'unreachable');
    assert.match(d.report.error, /refused/);
    const h = await doctor([url]);
    assert.match(h.stdout, /The server could not be reached/);
  });

  it('not an MCP server (a web page): exit 5', async () => {
    const f = await startFakeMcp({ html: true });
    try {
      const r = await doctor([f.url, '--json']);
      assert.equal(r.code, EXIT.UNREACHABLE);
      assert.equal(r.json().verdict, 'not_mcp');
    } finally {
      await f.close();
    }
  });

  it('a firewall page: exit 5, verdict blocked', async () => {
    const f = await startFakeMcp({ auth: 'waf' });
    try {
      const r = await doctor([f.url, '--json']);
      assert.equal(r.code, EXIT.UNREACHABLE);
      assert.equal(r.json().verdict, 'blocked');
    } finally {
      await f.close();
    }
  });

  it('--timeout gives up on a slow server', async () => {
    const f = await startFakeMcp({ delayMs: 3000 });
    try {
      const t0 = Date.now();
      const r = await doctor([f.url, '--timeout', '1', '--json']);
      assert.equal(r.code, EXIT.UNREACHABLE);
      assert.match(r.json().report.error, /no answer within 1 s/);
      assert.ok(Date.now() - t0 < 2500);
      const bad = await doctor([f.url, '--timeout', '0']);
      assert.equal(bad.code, EXIT.USAGE);
    } finally {
      await f.close();
    }
  });

  it('an address that points to the real endpoint', async () => {
    const f = await startFakeMcp({ pointTo: 'https://vendor.example/mcp' });
    try {
      const r = await doctor([f.url]);
      assert.equal(r.code, EXIT.UNREACHABLE);
      assert.match(r.stdout, /It points to the server's own URL: https:\/\/vendor\.example\/mcp/);
    } finally {
      await f.close();
    }
  });

  it('masks a key in the URL wherever it prints it', async () => {
    const r = await doctor([`${fake.url}?api_key=abcdef123456`]);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('abcdef123456') && !r.stderr.includes('abcdef123456'));
    assert.match(r.stdout, /api_key=\*\*\*/);
  });
});

describe('security-doctor-creds-sent-to-mcptc: nothing but a slug or a name goes to mcp.tc', () => {
  it('resolveTarget() refuses names that look like a credential, before any request', () => {
    for (const input of ['user:password', 'ghp_FAKEtoken1234567890abcd', '123e4567-e89b-12d3-a456-426614174000', 'key=value with space', 'a@b c']) {
      assert.throws(() => resolveTarget(input, 'https://mcp.tc'), (e) => e.code === 'invalid_listing' && e.exit === EXIT.USAGE && !e.message.includes(input), input);
    }
  });
  it('a URL with a user name and password but no scheme is refused locally, and mcp.tc gets nothing', async () => {
    for (const input of ['admin:Sup3rSecret@mcp.internal.example.com/mcp', 'ghp_FAKEtoken1234567890@api.example.com/mcp']) {
      fake.reset();
      const r = await doctor([input, '--json']);
      assert.equal(r.code, EXIT.USAGE, input);
      assert.equal(r.json().error.code, 'invalid_url');
      assert.deepEqual(fake.requests, [], `${input}: no request at all`);
      assert.ok(!r.stdout.includes('Sup3rSecret') && !r.stdout.includes('FAKEtoken'), 'the secret is not repeated');
    }
  });
  it('a bare token or user:password is refused without a request, and not repeated', async () => {
    for (const input of ['ghp_FAKEtoken1234567890abcd', 'admin:Sup3rSecret']) {
      fake.reset();
      const r = await doctor([input, '--json']);
      assert.equal(r.code, EXIT.USAGE, input);
      assert.equal(r.json().error.code, 'invalid_listing');
      assert.deepEqual(fake.requests, []);
      assert.ok(!r.stdout.includes(input));
    }
  });
});

describe('security-header-partial-echo: a token the server quotes back is hidden in every output', () => {
  it('the bare token, its lowercase and its first characters never appear', async () => {
    const f = await startFakeMcp({ auth: 'oauth', echoToken: true, token: 'right-token' });
    const secret = 'FAKE-SECRET-TOKEN-1234567890';
    try {
      for (const extra of [['--json'], []]) {
        const r = await doctor([f.url, '--header', `Authorization: Bearer ${secret}`, ...extra]);
        const all = (r.stdout + r.stderr).toLowerCase();
        assert.ok(!all.includes(secret.toLowerCase()), 'the token');
        assert.ok(!all.includes(secret.slice(0, 12).toLowerCase()), 'its first 12 characters');
        assert.ok(!all.includes(secret.slice(-10).toLowerCase()), 'its last 10 characters');
      }
      // the server's own text around it stays readable
      const j = await doctor([f.url, '--header', `Authorization: Bearer ${secret}`, '--json']);
      assert.match(JSON.stringify(j.json().report.auth), /\[hidden\]/);
      assert.match(j.json().report.auth.www_authenticate || '', /error_description="token \[hidden\] expired"/);
    } finally {
      await f.close();
    }
  });
});

describe('correctness-3: a 410 on the old HTTP+SSE GET', () => {
  it('reports the URL as moved and names the new one: exit 5 and "Try the new URL"', async () => {
    const f = await startFakeMcp({ path: '/sse' });
    f.set({ retiredSse: `${f.base}/mcp` });
    try {
      const r = await doctor([f.url, '--json']);
      assert.equal(r.code, EXIT.UNREACHABLE);
      const rep = r.json().report;
      assert.equal(rep.moved_to, `${f.base}/mcp`);
      assert.equal(rep.status, 410);
      assert.match(rep.error, /gone \(HTTP 410\); it points to http:\/\/127\.0\.0\.1:\d+\/mcp/);
      const h = await doctor([f.url]);
      assert.match(h.stdout, /Try the new URL: mcp-tc doctor http:\/\/127\.0\.0\.1:\d+\/mcp/);
    } finally {
      await f.close();
    }
  });
});

describe('mcp-tc doctor <slug>', () => {
  it('looks the listing up on mcp.tc, then connects to the server itself', async () => {
    fake.reset();
    const r = await doctor(['fake']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Fake Docs \(https:\/\/mcp\.tc\/i\/fake, listed as No sign-in\)/);
    assert.match(r.stdout, /The server answers MCP without sign-in\./);
    const lookups = fake.requests.filter((q) => q.path === '/dir/mcp');
    assert.equal(lookups.length, 1);
    assert.equal(JSON.parse(lookups[0].body).params.arguments.slug, 'fake');
    assert.ok(fake.requests.some((q) => q.path === '/mcp' && JSON.parse(q.body).method === 'server/discover'));
  });

  it('takes an mcp.tc link too', async () => {
    const r = await doctor(['https://mcp.tc/i/fake', '--json']);
    assert.equal(r.code, 0);
    const d = r.json();
    assert.equal(d.listing.slug, 'fake');
    assert.equal(d.listing.access, 'No sign-in');
    assert.equal(d.report.mcp, true);
  });

  it('notes when the listing and the server disagree about sign-in', async () => {
    const f = await startFakeMcp({ auth: 'oauth' });
    const l = listings(f);
    fake.set({ directory: { ...listings(fake), 'fake-signin': l['fake-signin'] } });
    try {
      const r = await doctor(['fake-signin']);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /mcp\.tc lists it as "No sign-in", but it asked for sign-in now\./);
    } finally {
      fake.set({ directory: listings(fake) });
      await f.close();
    }
  });

  it('a local listing: nothing to connect to, prints the install command', async () => {
    fake.reset();
    const r = await doctor(['memory']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Memory runs on your computer: there is no server URL to connect to\./);
    assert.match(r.stdout, /Install\s+npx -y @modelcontextprotocol\/server-memory/);
    assert.match(r.stdout, /mcp-tc add memory --client <id>/);
    assert.ok(!fake.requests.some((q) => q.path === '/mcp'), 'no connection attempt');
    const j = (await doctor(['memory', '--json'])).json();
    assert.equal(j.local, true);
    assert.equal(j.verdict, 'local');
    assert.equal(j.report, null);
    assert.equal(j.listing.install_command, 'npx -y @modelcontextprotocol/server-memory');
  });

  it("a local listing without a command points to the vendor's instructions", async () => {
    const r = await doctor(['shell-steps']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Install it with the vendor's own instructions: https:\/\/vendor\.example\/install/);
  });

  it('an unknown slug: exit 3', async () => {
    const r = await doctor(['zz-nothing', '--json']);
    assert.equal(r.code, EXIT.NOT_FOUND);
    assert.equal(r.json().error.code, 'not_found');
  });
});

describe('verdict()', () => {
  const base = { reachable: true, blocked: false, mcp: false, error: null, auth: { kind: null } };
  it('names each outcome', () => {
    assert.equal(verdict({ ...base, reachable: false }), 'unreachable');
    assert.equal(verdict({ ...base, blocked: true }), 'blocked');
    assert.equal(verdict({ ...base, auth: { kind: 'oauth' } }), 'sign_in');
    assert.equal(verdict({ ...base, auth: { kind: 'api_key' } }), 'api_key');
    assert.equal(verdict({ ...base, mcp: true, auth: { kind: 'none' } }), 'ok');
    assert.equal(verdict(base), 'not_mcp');
  });
});

// Read-only checks against https://mcp.tc: its own MCP server, by URL and by its listing slug (one get_server call),
// five requests in all, a second apart. Run with MCPTC_LIVE=1.
describe('live mcp.tc (MCPTC_LIVE=1)', { skip: process.env.MCPTC_LIVE !== '1' && 'set MCPTC_LIVE=1 to run against https://mcp.tc' }, () => {
  const live = (args) => runCli(['doctor', ...args], { env: { MCPTC_BASE_URL: 'https://mcp.tc' } });
  const pause = () => new Promise((r) => setTimeout(r, 1000));
  it('doctor https://mcp.tc/mcp: the 2026-07-28 style, no sign-in, three tools', async () => {
    const r = await live(['https://mcp.tc/mcp', '--json']);
    assert.equal(r.code, 0, r.stdout);
    const d = r.json().report;
    assert.equal(d.era, 'modern');
    assert.equal(d.auth.kind, 'none');
    assert.ok(d.tools_count >= 1);
    assert.ok(d.tools.every((t) => t.read_only === true));
    await pause();
  });
  it('doctor mcp-tc: the listing points to the same server', async () => {
    const r = await live(['mcp-tc', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json().listing.endpoint, 'https://mcp.tc/mcp');
    assert.equal(r.json().report.mcp, true);
  });
});
