import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, fixture, startFakeDirectory } from './helpers/fake-directory.js';
import { timing } from '../src/commands/scan.js';
import { clearIndexCache } from '../src/lib/directory.js';
import { EXIT } from '../src/lib/errors.js';

const FIX = new URL('./fixtures/clients/', import.meta.url);
const text = (name) => readFileSync(new URL(name, FIX), 'utf8');
const REDIRECTS = JSON.parse(text('directory-redirects.json')).redirects;

/**
 * A stand-in for mcp.tc's /directory and /api/index.json. Records every request.
 * @param {{rateLimitAt?: number}} [opts] answer 429 (Retry-After 120) to that /directory request (1-based)
 */
async function startFake(opts = {}) {
  const requests = [];
  let lookups = 0;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    const url = new URL(req.url, 'http://fake');
    if (url.pathname === '/directory') {
      lookups++;
      if (opts.rateLimitAt === lookups) {
        res.writeHead(429, { 'Retry-After': '120', 'Content-Type': 'text/plain' });
        return res.end('slow down');
      }
      const q = url.searchParams.get('q') || '';
      if (REDIRECTS[q]) {
        res.writeHead(303, { Location: REDIRECTS[q] });
        return res.end();
      }
      if (/^https?:\/\//.test(q)) {
        res.writeHead(303, { Location: `/submit?url=${encodeURIComponent(q)}` });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><p>results</p>');
    }
    if (url.pathname === '/api/index.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(fixture('index')));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** The q of each /directory request, in order. */
    sent: () => requests.filter((r) => r.url.startsWith('/directory')).map((r) => new URL(r.url, 'http://x').searchParams.get('q')),
    close: () => new Promise((r) => server.close(r)),
  };
}

let root;
let fake;
before(async () => {
  timing.gapMs = 0;
  root = mkdtempSync(join(tmpdir(), 'mcptc-scan-'));
  fake = await startFake();
});
after(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  fake.requests.length = 0;
  clearIndexCache();
});

let n = 0;
/** A home folder with every client's config file, and a project folder with .mcp.json. */
function fullHome() {
  const h = join(root, `h${++n}`);
  const cwd = join(h, 'work', 'proj');
  const put = (rel, body) => {
    mkdirSync(join(h, rel, '..'), { recursive: true });
    writeFileSync(join(h, rel), body);
  };
  put('.claude.json', text('claude.json').replace('{{CWD}}', cwd));
  put('work/proj/.mcp.json', text('project-mcp.json'));
  put('.cursor/mcp.json', text('cursor-mcp.json'));
  put('.config/Code/User/mcp.json', text('vscode-mcp.json'));
  put('.codex/config.toml', text('codex-config.toml'));
  put('.gemini/settings.json', text('gemini-settings.json'));
  put('.config/devin/mcp_config.json', '{ not json');
  return { h, cwd };
}
const scan = (argv, { h, cwd }, base = fake.base) => runCli(['scan', ...argv], { base, env: { HOME: h }, cwd, platform: 'linux' });

const EXPECTED_SENT = [
  'https://mcp.deepwiki.com/mcp',
  '@modelcontextprotocol/server-memory',
  'https://api.example.org/v1/mcp',
  'https://hooks.example.com',
  'https://mcp.notion.com/mcp',
  'https://mcp.example.com/mcp',
  'https://pypi.org/project/mcp-server-fetch',
  'https://api.githubcopilot.com/mcp/',
  '@modelcontextprotocol/server-filesystem',
  'https://sse.example.com/sse',
  'https://github.com/example-org/example-mcp',
];

describe('mcp-tc scan', () => {
  it('--offline: lists every server and sends nothing', async () => {
    const r = await scan(['--offline', '--json'], fullHome());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.requests.length, 0);
    const j = r.json();
    assert.equal(j.offline, true);
    assert.equal(j.counts.servers, 17);
    assert.ok(j.servers.every((s) => s.lookup.status === 'skipped' && s.lookup.reason === 'offline'));
    assert.deepEqual(j.sent, []);
    assert.deepEqual(
      j.files.map((f) => `${f.client}|${f.scope}|${f.status}|${f.servers}`),
      [
        'Claude Code|user|read|3',
        'Claude Code, VS Code|project|read|2',
        'Cursor|user|read|4',
        'VS Code|user|read|2',
        'Devin Desktop|user|unreadable|0',
        'Codex|user|read|3',
        'Gemini CLI|user|read|3',
      ],
    );
  });

  it('sends only cleaned addresses and package names, once each, then the index', async () => {
    const r = await scan(['--json'], fullHome());
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fake.sent(), EXPECTED_SENT);
    assert.deepEqual(r.json().sent, EXPECTED_SENT);
    assert.equal(fake.requests.at(-1).url, '/api/index.json');
    assert.equal(fake.requests.length, EXPECTED_SENT.length + 1);
    for (const q of fake.requests) {
      assert.equal(q.method, 'GET');
      const all = q.url + JSON.stringify(q.headers);
      assert.ok(!/FAKE|someone|localhost|server\.js|Bearer|api_key|token=/i.test(all), `leak in ${all}`);
      assert.match(q.headers['user-agent'], /^mcp-tc-cli\//);
      assert.equal(q.headers.authorization, undefined);
      assert.equal(q.headers.cookie, undefined);
    }
  });

  it('reports listings with name, access, checkmark and link', async () => {
    const r = await scan(['--json'], fullHome());
    const j = r.json();
    const by = (name, client) => j.servers.find((s) => s.name === name && (!client || s.client === client));
    assert.deepEqual(by('deepwiki', 'Claude Code').listing, { slug: 'deepwiki', name: 'DeepWiki', state: 'ok', state_label: 'No sign-in', verified: true, link: `${fake.base}/i/deepwiki` });
    assert.equal(by('memory').listing.state_label, 'Local');
    assert.equal(by('notion').listing.state_label, 'Sign-in');
    assert.equal(by('keyed').scope, 'local');
    assert.equal(by('keyed').lookup.status, 'not_listed');
    assert.equal(by('keyed').submit_url, 'https://api.example.org/v1/mcp');
    assert.equal(by('pathkey').submit_url, null);
    // only the host was sent (the path looked like a key), and mcp.tc matches servers by host and path: no claim
    // that it is missing
    assert.equal(by('pathkey').lookup.status, 'not_found_by_url');
    assert.deepEqual(by('local-dev').lookup, { status: 'skipped', sent: null, reason: 'local_address' });
    assert.deepEqual(by('script').lookup, { status: 'skipped', sent: null, reason: 'local_command' });
    assert.equal(by('fs').submit_url, 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem');
    assert.equal(by('stream').lookup.status, 'listed', 'Gemini httpUrl, already looked up for another client');
    assert.equal(by('sse-server').transport, 'sse');
    assert.deepEqual(j.counts, { servers: 17, listed: 6, not_listed: 7, not_found_by_url: 1, listing_link: 0, skipped: 3, error: 0 });
    assert.deepEqual(by('docker-fetch').lookup, { status: 'skipped', sent: null, reason: 'container_image' });
    assert.ok(!r.stdout.includes('elsewhere'), "other projects' servers are not read");
  });

  it('never prints keys, headers, environment values or arguments', async () => {
    const h = fullHome();
    for (const argv of [['--json'], []]) {
      const r = await scan(argv, h);
      assert.ok(!/FAKE|someone|server\.js/.test(r.stdout + r.stderr), r.stdout);
    }
  });

  it('human output: per file, listing or a way to suggest it', async () => {
    const r = await scan([], fullHome());
    assert.match(r.stdout, /^Found 17 MCP servers in 7 config files\.$/m);
    assert.match(r.stdout, /^Claude Code: ~\/\.claude\.json$/m);
    assert.match(r.stdout, /^Claude Code, VS Code: ~\/work\/proj\/\.mcp\.json \(this folder\)$/m);
    assert.match(r.stdout, /^ {2}deepwiki +https:\/\/mcp\.deepwiki\.com\/mcp$/m);
    assert.match(r.stdout, new RegExp(`On mcp\\.tc: DeepWiki \u2713, No sign-in: ${fake.base.replace(/[.]/g, '\\.')}/i/deepwiki`));
    assert.match(r.stdout, /^ {2}memory +npx @modelcontextprotocol\/server-memory$/m);
    assert.match(r.stdout, /^ {2}keyed +https:\/\/api\.example\.org\/v1\/mcp\?\.\.\. \(this folder only\)$/m);
    assert.match(r.stdout, /Not on mcp\.tc\. Suggest it: mcp-tc submit https:\/\/api\.example\.org\/v1\/mcp/);
    assert.match(r.stdout, /^ {2}pathkey +https:\/\/hooks\.example\.com\/\.\.\.$/m);
    assert.match(r.stdout, /Not found by this URL\. mcp\.tc matches a server by its host and path; find it by name with: mcp-tc search <name>/);
    assert.ok(!/submit https:\/\/hooks\.example\.com/.test(r.stdout));
    assert.match(r.stdout, /^ {2}bridge +npx mcp-remote https:\/\/mcp\.example\.com\/mcp$/m);
    assert.match(r.stdout, /^ {2}local-dev +http:\/\/localhost:8787\/\.\.\.$/m);
    assert.match(r.stdout, /not looked up: an address on this computer or a private network/);
    assert.match(r.stdout, /^ {2}script +node$/m);
    assert.match(r.stdout, /^ {2}docker-fetch +docker mcp\/fetch$/m);
    assert.match(r.stdout, /Could not read it \(not valid JSON or TOML\)\./);
    assert.match(r.stdout, /^On mcp\.tc: 6 listed, 7 not listed, 1 not found by URL, 3 not looked up\.$/m);
    assert.match(r.stdout, /mcp-tc submit <url>, or at https:\/\/mcp\.tc\/submit/);
  });

  it('--client limits the files read and the lookups', async () => {
    const r = await scan(['--client', 'cursor', '--json'], fullHome());
    assert.deepEqual(r.json().files.map((f) => f.client), ['Cursor']);
    assert.deepEqual(fake.sent(), ['https://mcp.notion.com/mcp', 'https://mcp.example.com/mcp']);
  });

  it('rate limited: stops looking up, keeps the local list, exit 4', async () => {
    const limited = await startFake({ rateLimitAt: 2 });
    try {
      const r = await scan(['--json'], fullHome(), limited.base);
      assert.equal(r.code, EXIT.RATE_LIMITED);
      const j = r.json();
      // a partial result: still "ok", with the reason under "partial" (documented in scan --help)
      assert.equal(j.ok, true);
      assert.equal(j.error, undefined);
      assert.equal(j.partial.code, 'rate_limited');
      assert.equal(limited.sent().length, 2);
      assert.equal(j.counts.listed, 4, 'deepwiki in four files, from the one lookup that worked');
      assert.equal(j.counts.error, 10);
      assert.ok(!limited.requests.some((q) => q.url === '/api/index.json'), 'no index after a 429');
    } finally {
      await limited.close();
    }
    const again = await startFake({ rateLimitAt: 1 });
    try {
      const h = await scan([], fullHome(), again.base);
      assert.equal(h.code, EXIT.RATE_LIMITED);
      assert.match(h.stderr, /The lookups stopped, so this list is partial: .*HTTP 429/);
      assert.match(h.stdout, /not looked up: the lookups stopped \(see the error\)/);
    } finally {
      await again.close();
    }
  });

  it('nothing to scan', async () => {
    const h = join(root, 'empty');
    mkdirSync(h);
    const r = await scan([], { h, cwd: h });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /No MCP client config files found/);
    assert.equal(fake.requests.length, 0);
  });

  it('a config with no servers sends nothing', async () => {
    const h = join(root, 'few');
    mkdirSync(join(h, '.cursor'), { recursive: true });
    writeFileSync(join(h, '.cursor', 'mcp.json'), '{"mcpServers": {}}');
    const r = await scan([], { h, cwd: h });
    assert.match(r.stdout, /No servers\./);
    assert.equal(fake.requests.length, 0);
  });
});

describe('mcp-tc scan: review fixes', () => {
  /** A home folder with one Cursor file holding these servers. */
  function cursorOnly(servers) {
    const h = join(root, `r${++n}`);
    mkdirSync(join(h, '.cursor'), { recursive: true });
    writeFileSync(join(h, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: servers }));
    return { h, cwd: h };
  }

  it('an mcp.tc listing link in a config: reported as a page, with the add command; nothing sent for it, no submit suggestion', async () => {
    const home = cursorOnly({
      old: { url: 'https://mcp.tc/i/deepwiki' },
      bridged: { command: 'npx', args: ['-y', 'mcp-remote', 'https://www.mcp.tc/it/i/notion?x=1'] },
    });
    const r = await scan(['--json'], home);
    assert.equal(r.code, 0, r.stderr);
    const j = r.json();
    assert.deepEqual(fake.sent(), [], 'no address lookup for a listing link');
    assert.deepEqual(j.sent, []);
    const old = j.servers.find((s) => s.name === 'old');
    assert.equal(old.lookup.status, 'listing_link');
    assert.equal(old.submit_url, null);
    assert.equal(old.fix, 'mcp-tc add deepwiki --client cursor');
    assert.equal(old.listing.slug, 'deepwiki');
    assert.equal(old.listing.name, 'DeepWiki', 'named from the directory index');
    assert.equal(j.servers.find((s) => s.name === 'bridged').listing.slug, 'notion');
    assert.equal(j.counts.listing_link, 2);
    assert.equal(j.counts.not_listed, 0);
    const t = await scan([], home);
    assert.match(t.stdout, /This is the mcp\.tc page for DeepWiki ✓, not the server\. Use the server's own URL: mcp-tc add deepwiki --client cursor/);
    assert.match(t.stdout, /2 entries point at an mcp\.tc listing page instead of the server/);
    assert.ok(!/mcp-tc submit/.test(t.stdout), t.stdout);
  });

  it('a root-path endpoint: "not found by this URL" (no submit suggestion) when mcp.tc answers with the suggest form', async () => {
    const r = await scan(['--json'], cursorOnly({ root: { url: 'https://mcp.root-example.com/' } }));
    const s = r.json().servers[0];
    assert.deepEqual(fake.sent(), ['https://mcp.root-example.com']);
    assert.equal(s.lookup.status, 'not_found_by_url');
    assert.equal(s.submit_url, null);
    assert.equal(r.json().counts.not_listed, 0);
  });

  it('a root-path endpoint that mcp.tc matches: listed', async () => {
    const dir = await startFakeDirectory();
    try {
      dir.respond(303, '', { Location: '/i/deepwiki' });
      const r = await scan(['--json'], cursorOnly({ root: { url: 'https://mcp.deepwiki.com' } }), dir.base);
      assert.equal(r.json().servers[0].lookup.status, 'listed');
      assert.equal(r.json().servers[0].listing.slug, 'deepwiki');
    } finally {
      await dir.close();
    }
  });

  it('addresses on a private network, tailnet names and plain http URLs are never sent', async () => {
    const r = await scan(
      ['--json'],
      cursorOnly({
        tail: { url: 'http://devbox.tail1a2b3.ts.net:3000/mcp' },
        tailtls: { url: 'https://devbox.tail1a2b3.ts.net/mcp' },
        k8s: { url: 'http://mcp.default.svc:8080/mcp' },
        mapped: { url: 'http://[::127.0.0.1]:3000/mcp' },
        bench: { url: 'https://198.18.0.5/mcp' },
        nat64: { url: 'https://[64:ff9b::a00:1]/mcp' },
        nip: { url: 'https://10.0.0.1.nip.io/mcp' },
        bcast: { url: 'https://255.255.255.255/mcp' },
        plain: { url: 'http://mcp.example.org/mcp' },
        bridge: { command: 'npx', args: ['-y', 'mcp-remote', 'http://intranet/mcp'] },
      }),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fake.requests.length, 0, JSON.stringify(fake.requests.map((q) => q.url)));
    const j = r.json();
    assert.ok(j.servers.every((s) => s.lookup.sent === null));
    assert.equal(j.servers.find((s) => s.name === 'plain').lookup.reason, 'not_https');
    assert.equal(j.servers.find((s) => s.name === 'tailtls').lookup.reason, 'local_address');
    const t = await scan([], cursorOnly({ plain: { url: 'http://mcp.example.org/mcp' } }));
    assert.match(t.stdout, /not looked up: a plain http address \(public MCP servers use https\)/);
  });

  it('a Cloudflare block on /directory: not "not listed"; scan stops asking, exit 1, partial result', async () => {
    const dir = await startFakeDirectory();
    try {
      dir.block(1, '1010');
      const home = cursorOnly({ a: { url: 'https://mcp.deepwiki.com/mcp' }, b: { url: 'https://mcp.notion.com/mcp' } });
      const r = await scan(['--json'], home, dir.base);
      assert.equal(r.code, EXIT.ERROR);
      const j = r.json();
      assert.equal(j.ok, true);
      assert.equal(j.partial.code, 'blocked');
      assert.match(j.partial.message, /HTTP 403/);
      assert.equal(dir.requests.length, 1, 'one request, then nothing: no second lookup, no index');
      assert.ok(j.servers.every((s) => s.lookup.status === 'error' && s.submit_url === null));
      assert.equal(j.counts.not_listed, 0);
      dir.reset();
      dir.block(1, '1010');
      const t = await scan([], home, dir.base);
      assert.ok(!/Not on mcp\.tc|Suggest it/.test(t.stdout), t.stdout);
      assert.match(t.stderr, /The lookups stopped, so this list is partial: .*HTTP 403/);
    } finally {
      await dir.close();
    }
  });

  it('a 404 or other unexpected answer from /directory (a wrong MCPTC_BASE_URL): stops, never "not listed"', async () => {
    const dir = await startFakeDirectory();
    try {
      dir.fail(1, 404);
      const r = await scan(['--json'], cursorOnly({ a: { url: 'https://mcp.deepwiki.com/mcp' }, b: { url: 'https://mcp.notion.com/mcp' } }), dir.base);
      assert.equal(r.code, EXIT.ERROR);
      assert.equal(r.json().partial.code, 'unexpected_status');
      assert.equal(r.json().counts.not_listed, 0);
      assert.equal(dir.requests.length, 1);
    } finally {
      await dir.close();
    }
  });

  it('help documents the partial result and its exit codes', async () => {
    const r = await runCli(['help', 'scan']);
    const text = r.stdout.replace(/\s+/g, ' ');
    assert.match(text, /"partial": \{code, message\}/);
    assert.match(text, /exit code is 4 when mcp\.tc is limiting requests, 1 otherwise/);
  });
});

// Read-only check against https://mcp.tc: one address lookup and the index. Run with MCPTC_LIVE=1.
describe('live mcp.tc (MCPTC_LIVE=1)', { skip: process.env.MCPTC_LIVE !== '1' && 'set MCPTC_LIVE=1 to run against https://mcp.tc' }, () => {
  it('finds a listed server URL', async () => {
    const h = join(root, 'live');
    mkdirSync(join(h, '.cursor'), { recursive: true });
    writeFileSync(join(h, '.cursor', 'mcp.json'), '{"mcpServers": {"dw": {"url": "https://mcp.deepwiki.com/mcp"}}}');
    const r = await scan(['--json'], { h, cwd: h }, 'https://mcp.tc');
    const s = r.json().servers[0];
    assert.equal(s.lookup.status, 'listed');
    assert.equal(s.listing.slug, 'deepwiki');
    assert.equal(s.listing.link, 'https://mcp.tc/i/deepwiki');
    assert.equal(s.listing.state_label, 'No sign-in');
  });
});
