import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  request,
  requestJson,
  parseRetryAfter,
  backoffDelay,
  networkError,
  checkBlocked,
  MAX_ATTEMPTS,
  DEFAULT_RETRY_MS,
} from '../src/lib/http.js';
import { CliError, EXIT } from '../src/lib/errors.js';
import { USER_AGENT, VERSION } from '../src/version.js';

/** A tiny server whose answers each test scripts. */
let server;
let base;
/** @type {((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void)[]} */
let script = [];
/** @type {{method: string, url: string, headers: any, body: string}[]} */
let seen = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const step = script.length > 1 ? script.shift() : script[0];
      if (step) step(req, res, body);
      else res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
beforeEach(() => {
  script = [];
  seen = [];
});

const ok = (text = 'ok', type = 'text/plain') => (_q, res) => {
  res.writeHead(200, { 'Content-Type': type });
  res.end(text);
};
const tooMany = (retryAfter) => (_q, res) => {
  res.writeHead(429, retryAfter === undefined ? {} : { 'Retry-After': retryAfter });
  res.end('slow down');
};
/** Records waits instead of sleeping. */
function fakeClock() {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

describe('version and User-Agent', () => {
  it('reads the version from package.json and names the project', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
    assert.equal(USER_AGENT, `mcp-tc-cli/${VERSION} (+https://github.com/mcptc/mcp-tc)`);
  });

  it('sends the User-Agent on every request and never a caller-supplied one', async () => {
    script = [ok()];
    await request(`${base}/x`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    assert.equal(seen[0].headers['user-agent'], USER_AGENT);
  });
});

describe('request()', () => {
  it('returns status, headers and text without throwing for 404', async () => {
    script = [(_q, res) => { res.writeHead(404, { 'X-A': 'b' }); res.end('nope'); }];
    const res = await request(`${base}/missing`);
    assert.equal(res.status, 404);
    assert.equal(res.ok, false);
    assert.equal(res.headers.get('x-a'), 'b');
    assert.equal(res.text, 'nope');
  });

  it('sends a JSON body with its content type', async () => {
    script = [ok('{"a":1}', 'application/json')];
    const res = await requestJson(`${base}/j`, { method: 'POST', json: { q: 1 } });
    assert.deepEqual(res.data, { a: 1 });
    assert.equal(seen[0].headers['content-type'], 'application/json');
    assert.equal(seen[0].headers.accept, 'application/json');
    assert.equal(seen[0].body, '{"q":1}');
  });

  it('json() throws bad_response for a body that is not JSON', async () => {
    script = [ok('<html>')];
    const res = await request(`${base}/h`);
    assert.throws(() => res.json(), (e) => e instanceof CliError && e.code === 'bad_response');
  });

  it('keeps 3xx answers with redirect: manual', async () => {
    script = [(_q, res) => { res.writeHead(303, { Location: '/i/x' }); res.end(); }];
    const res = await request(`${base}/directory?q=a`, { redirect: 'manual', readBody: false });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/i/x');
    assert.equal(res.text, '');
  });

  it('times out with the host in the message', async () => {
    script = [() => {}]; // never answers
    await assert.rejects(request(`${base}/slow`, { timeout: 150 }), (e) => {
      assert.equal(e.code, 'timeout');
      assert.equal(e.exit, EXIT.ERROR);
      assert.match(e.message, /127\.0\.0\.1:\d+ did not answer within 0 s|did not answer/);
      return true;
    });
  });

  it('refuses bodies over maxBytes', async () => {
    script = [ok('x'.repeat(5000))];
    await assert.rejects(request(`${base}/big`, { maxBytes: 1000 }), (e) => e.code === 'response_too_large');
  });

  it('rejects non-http URLs as usage errors', async () => {
    await assert.rejects(request('file:///etc/passwd'), (e) => e.code === 'invalid_url' && e.exit === EXIT.USAGE);
    await assert.rejects(request('not a url'), (e) => e.code === 'invalid_url');
  });

  it('reports a refused connection as network_error naming the host', async () => {
    const tmp = createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const port = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    await assert.rejects(request(`http://127.0.0.1:${port}/`), (e) => {
      assert.equal(e.code, 'network_error');
      assert.equal(e.details.host, `127.0.0.1:${port}`);
      assert.match(e.message, /refused the connection/);
      return true;
    });
  });
});

describe('429 handling', () => {
  it('honours Retry-After in seconds and then succeeds', async () => {
    script = [tooMany('3'), tooMany('2'), ok('done')];
    const clock = fakeClock();
    const notices = [];
    const res = await request(`${base}/r`, { sleep: clock.sleep, random: () => 0, onRetry: (i) => notices.push(i) });
    assert.equal(res.text, 'done');
    assert.deepEqual(clock.waits, [3000, 2000]);
    assert.equal(seen.length, 3);
    assert.deepEqual(notices.map((n) => n.attempt), [1, 2]);
    assert.equal(notices[0].maxAttempts, MAX_ATTEMPTS);
  });

  it('adds at most 250 ms of jitter to Retry-After', async () => {
    script = [tooMany('1'), ok()];
    const clock = fakeClock();
    await request(`${base}/r`, { sleep: clock.sleep, random: () => 0.999 });
    assert.ok(clock.waits[0] >= 1000 && clock.waits[0] <= 1250, String(clock.waits[0]));
  });

  it('reads Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    assert.equal(parseRetryAfter('Tue, 06 Oct 2026 12:00:07 GMT', now), 7000);
    assert.equal(parseRetryAfter('Tue, 06 Oct 2026 11:59:00 GMT', now), 0);
    assert.equal(parseRetryAfter('12', now), 12000);
    assert.equal(parseRetryAfter('soon', now), null);
    assert.equal(parseRetryAfter(null, now), null);
  });

  it('backs off 10 s, 20 s, 40 s with up to 25% jitter when Retry-After is missing', () => {
    assert.equal(backoffDelay(1, () => 0), DEFAULT_RETRY_MS);
    assert.equal(backoffDelay(2, () => 0), 20_000);
    assert.equal(backoffDelay(3, () => 0), 40_000);
    assert.equal(backoffDelay(1, () => 1), 12_500);
  });

  it('caps the total wait at 60 s and makes at most 4 attempts', async () => {
    script = [tooMany(undefined)];
    const clock = fakeClock();
    await assert.rejects(request(`${base}/r`, { sleep: clock.sleep, random: () => 0 }), (e) => {
      assert.equal(e.code, 'rate_limited');
      assert.equal(e.exit, EXIT.RATE_LIMITED);
      assert.equal(e.details.attempts, 4);
      return true;
    });
    assert.equal(seen.length, 4);
    // 10 s + 20 s, then the 40 s step is cut to what is left of 60 s
    assert.deepEqual(clock.waits, [10_000, 20_000, 30_000]);
    assert.ok(clock.waits.reduce((a, b) => a + b, 0) <= 60_000);
  });

  it('gives up at once when Retry-After is longer than the wait left', async () => {
    script = [tooMany('120')];
    const clock = fakeClock();
    await assert.rejects(request(`${base}/r`, { sleep: clock.sleep }), (e) => {
      assert.equal(e.code, 'rate_limited');
      assert.equal(e.details.retry_after, 120);
      assert.match(e.message, /try again in 120 s/);
      return true;
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(clock.waits, []);
  });

  it('maxAttempts: 1 means no retry', async () => {
    script = [tooMany('0')];
    await assert.rejects(request(`${base}/r`, { maxAttempts: 1 }), (e) => e.code === 'rate_limited' && e.details.attempts === 1);
    assert.equal(seen.length, 1);
  });

  it('really waits with tiny Retry-After values (no fake clock)', async () => {
    script = [tooMany('0'), tooMany('0'), ok('fine')];
    const t0 = Date.now();
    const res = await request(`${base}/r`);
    assert.equal(res.text, 'fine');
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe('Cloudflare refusals', () => {
  it('reports error 1010 as blocked', async () => {
    script = [(_q, res) => { res.writeHead(403, { 'cf-ray': 'abc-FRA', 'Content-Type': 'text/plain' }); res.end('error code: 1010'); }];
    await assert.rejects(request(`${base}/`), (e) => {
      assert.equal(e.code, 'blocked');
      assert.equal(e.exit, EXIT.ERROR);
      assert.equal(e.details.cloudflare_error, 1010);
      assert.match(e.message, /does not try to get around this/);
      return true;
    });
  });

  it('reports a challenge page as blocked', async () => {
    script = [(_q, res) => { res.writeHead(403, { 'cf-ray': 'abc', 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' }); res.end('<html>'); }];
    await assert.rejects(request(`${base}/`), (e) => e.code === 'blocked' && /challenge/.test(e.message));
  });

  it('leaves an ordinary 403 to the caller', async () => {
    script = [(_q, res) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"forbidden"}'); }];
    const res = await request(`${base}/`);
    assert.equal(res.status, 403);
  });

  it('can be switched off', async () => {
    script = [(_q, res) => { res.writeHead(403, { 'cf-ray': 'abc', 'Content-Type': 'text/html' }); res.end('<html>'); }];
    const res = await request(`${base}/`, { detectBlock: false });
    assert.equal(res.status, 403);
  });

  it('checkBlocked ignores other statuses', () => {
    assert.doesNotThrow(() => checkBlocked({ status: 200, headers: new Headers({ 'cf-ray': 'x' }), text: 'error code: 1010' }, 'h'));
  });
});

describe('networkError()', () => {
  const cases = [
    ['ENOTFOUND', /DNS lookup failed/],
    ['EAI_AGAIN', /DNS lookup failed/],
    ['ECONNREFUSED', /refused the connection/],
    ['ECONNRESET', /closed unexpectedly/],
    ['UND_ERR_CONNECT_TIMEOUT', /in time/],
    ['CERT_HAS_EXPIRED', /TLS certificate/],
    ['EWHATEVER', /Could not reach example\.com \(EWHATEVER\)/],
  ];
  for (const [code, re] of cases) {
    it(`maps ${code}`, () => {
      const e = networkError(Object.assign(new TypeError('fetch failed'), { cause: { code } }), 'example.com');
      assert.equal(e.code, 'network_error');
      assert.equal(e.exit, EXIT.ERROR);
      assert.equal(e.details.cause, code);
      assert.match(e.message, re);
    });
  }

  it('looks inside an AggregateError cause', () => {
    const e = networkError(Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }] } }), 'h');
    assert.match(e.message, /refused/);
  });
});
