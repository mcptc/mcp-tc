import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startFakeDirectory, runCli, fixture } from './helpers/fake-directory.js';
import { main } from '../src/cli.js';
import { EXIT } from '../src/lib/errors.js';
import { FAST_POLL_MS, NOTE_MAX, SLOW_POLL_MS, formatDuration, parseDuration, prepareNote, prepareUrl, timing } from '../src/commands/submit.js';

// A fake clock: every wait in submit (status checks, a 429's Retry-After) advances it at once and is recorded.
let clock = 1_000_000;
/** @type {number[]} */
const sleeps = [];
const realTiming = { ...timing };

let fake;
before(async () => {
  fake = await startFakeDirectory();
  timing.now = () => clock;
  timing.sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };
});
after(async () => {
  Object.assign(timing, realTiming);
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  sleeps.length = 0;
});

const cli = (argv, opts = {}) => runCli(['submit', ...argv], { base: fake.base, ...opts });
const posts = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/submit');
const reads = () => fake.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/s/'));
const SUBMIT = fixture('submit');
const ENDPOINT = 'https://mcp.example.com/mcp';

/** Run in-process with a terminal on stdin (scripted answer) and stderr as a stream, as readline needs. */
async function inTerminal(argv, answer) {
  let stdout = '';
  let stderr = '';
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false });
  const err = new PassThrough();
  err.on('data', (d) => {
    stderr += d;
    if (/\[y\/N\] $/.test(stderr)) setImmediate(() => stdin.write(`${answer}\n`));
  });
  const code = await main(['submit', ...argv], {
    stdout: /** @type {any} */ ({ isTTY: false, write: (s) => ((stdout += s), true) }),
    stderr: /** @type {any} */ (err),
    stdin,
    env: { PATH: process.env.PATH, COLUMNS: '100', MCPTC_BASE_URL: fake.base },
  });
  return { code, stdout, stderr };
}

describe('submit: what is sent', () => {
  it('keeps a clean endpoint URL as it is', () => {
    assert.deepEqual(prepareUrl(ENDPOINT), { url: ENDPOINT, kind: 'url', changes: [] });
    assert.equal(prepareUrl('https://github.com/example/weather-mcp').url, 'https://github.com/example/weather-mcp');
    assert.equal(prepareUrl('https://mcp.example.com').url, 'https://mcp.example.com');
  });
  it('adds https:// to a bare host and upgrades http://', () => {
    const a = prepareUrl('mcp.example.com/mcp');
    assert.equal(a.url, ENDPOINT);
    assert.deepEqual(a.changes.map((c) => c.code), ['added_https']);
    const b = prepareUrl('http://mcp.example.com/mcp');
    assert.equal(b.url, ENDPOINT);
    assert.deepEqual(b.changes.map((c) => c.code), ['https']);
  });
  it('removes credentials, the fragment and key-like query parameters, and keeps the rest', () => {
    const r = prepareUrl('https://me:hunter2@mcp.example.com/mcp?api_key=abc&token=x&region=eu&id=8f14e45f-ceea-467a-9d2c-6b1b9b2a7e11&sid=aB3dE5fG7hJ9kL1mN3pQ5#top');
    assert.equal(r.url, 'https://mcp.example.com/mcp?region=eu');
    assert.deepEqual(r.changes.map((c) => c.code), ['credentials_removed', 'fragment_removed', 'query_removed']);
    assert.deepEqual(r.changes[2].parameters, ['api_key', 'token', 'id', 'sid']);
    assert.ok(!JSON.stringify(r).includes('hunter2'));
    assert.ok(!JSON.stringify(r).includes('abc'));
  });
  it('refuses a URL with a key or an account ID in its path, before sending anything', () => {
    for (const u of ['https://mcp.example.com/sk-abcdefghijklmnop12345/mcp', 'https://mcp.example.com/u/8f14e45f-ceea-467a-9d2c-6b1b9b2a7e11/sse']) {
      assert.throws(() => prepareUrl(u), (e) => e.code === 'personal_url' && e.exit === EXIT.USAGE && /Nothing was sent/.test(e.message), u);
    }
    // on code hosts and registries the path is a name
    assert.equal(prepareUrl('https://github.com/acme/Neo4jServerForAgents2026edition').kind, 'url');
  });
  it('refuses private addresses, other schemes, spaces and very long URLs', () => {
    for (const [u, code] of [
      ['http://localhost:3000/mcp', 'not_public'],
      ['localhost:3000/mcp', 'not_public'],
      ['https://192.168.1.20/mcp', 'not_public'],
      ['https://mcp.internal/mcp', 'not_public'],
      ['ftp://example.com/x', 'invalid_url'],
      ['git@github.com:owner/repo.git', 'invalid_url'],
      ['claude mcp add x https://mcp.example.com/mcp', 'invalid_url'],
      [`https://mcp.example.com/${'a'.repeat(2100)}`, 'too_long'],
      ['', 'missing_url'],
    ]) {
      assert.throws(() => prepareUrl(u), (e) => e.code === code && e.exit === EXIT.USAGE, `${u.slice(0, 40)} -> ${code}`);
    }
  });
  it('turns npm: and pypi: into the package page, without the version', () => {
    assert.equal(prepareUrl('npm:@example/weather-mcp@1.2.0').url, 'https://www.npmjs.com/package/@example/weather-mcp');
    assert.equal(prepareUrl('npm:weather-mcp@latest').url, 'https://www.npmjs.com/package/weather-mcp');
    assert.equal(prepareUrl('pypi:weather-mcp==0.3').url, 'https://pypi.org/project/weather-mcp/');
    assert.deepEqual(prepareUrl('npm:x-mcp').changes.map((c) => c.code), ['npm_page']);
    assert.throws(() => prepareUrl('npm:'), (e) => e.code === 'invalid_package');
    assert.throws(() => prepareUrl('pypi:not a name'), (e) => e.code === 'invalid_url');
  });
  it('passes an official registry name as it is, and asks for npm: on a bare package name', () => {
    assert.deepEqual(prepareUrl('io.github.example/weather-mcp'), { url: 'io.github.example/weather-mcp', kind: 'registry_name', changes: [] });
    assert.throws(() => prepareUrl('@example/weather-mcp'), (e) => e.code === 'invalid_url' && /npm:@example\/weather-mcp/.test(e.message));
    assert.throws(() => prepareUrl('weather-mcp'), (e) => /npm:weather-mcp or pypi:weather-mcp/.test(e.message));
  });
  it('cuts the note to 500 characters and drops control characters', () => {
    assert.deepEqual(prepareNote(undefined), { text: null, cut: false, length: 0 });
    assert.deepEqual(prepareNote('   '), { text: null, cut: false, length: 0 });
    assert.equal(prepareNote('a\u0007b\u001b[31m').text, 'ab[31m');
    const long = prepareNote('x'.repeat(NOTE_MAX + 20));
    assert.equal(long.text.length, NOTE_MAX);
    assert.equal(long.cut, true);
    assert.equal(long.length, NOTE_MAX + 20);
  });
  it('reads --wait durations', () => {
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('5m'), 300_000);
    assert.equal(parseDuration('1h'), 3_600_000);
    assert.equal(parseDuration('1m30s'), 90_000);
    assert.equal(parseDuration('45'), 45_000);
    assert.equal(parseDuration('0'), 0);
    for (const bad of ['', 'soon', '5 m', '-1', '1.5m', '2h', '3601']) assert.throws(() => parseDuration(bad), (e) => e.exit === EXIT.USAGE, bad);
    assert.equal(formatDuration(600_000), '10m');
    assert.equal(formatDuration(90_000), '1m30s');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(3_600_000), '1h');
  });
});

describe('submit: the request', () => {
  it('sends JSON with our User-Agent and no browser headers, and the note only when given', async () => {
    const r = await cli([ENDPOINT, '--yes', '--note', 'The official server of Example.', '--json']);
    assert.equal(r.code, 0, r.stdout);
    const [p] = posts();
    assert.equal(posts().length, 1);
    assert.equal(p.headers['content-type'], 'application/json');
    assert.equal(p.headers.accept, 'application/json');
    assert.match(p.headers['user-agent'], /^mcp-tc-cli\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/mcptc\/mcp-tc\)$/);
    for (const h of ['origin', 'cookie', 'sec-fetch-site', 'referer', 'authorization']) assert.equal(p.headers[h], undefined, h);
    assert.deepEqual(JSON.parse(p.body), { url: ENDPOINT, note: 'The official server of Example.' });
    fake.reset();
    await cli([ENDPOINT, '--yes', '--no-wait']);
    assert.deepEqual(JSON.parse(posts()[0].body), { url: ENDPOINT });
  });
  it('sends what it shows: secrets never leave the computer or reach the output', async () => {
    const r = await cli(['https://me:hunter2@mcp.example.com/mcp?api_key=SECRETKEY123&region=eu', '--yes', '--no-wait']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(posts()[0].body), { url: 'https://mcp.example.com/mcp?region=eu' });
    for (const text of [r.stdout, r.stderr, posts()[0].body]) {
      assert.ok(!text.includes('hunter2') && !text.includes('SECRETKEY123'));
    }
    assert.match(r.stderr, /Removed the user name and password\./);
    assert.match(r.stderr, /Removed the query parameter "api_key", which can hold a key or a token\./);
  });
  it('sends nothing for a URL it refuses', async () => {
    const r = await cli(['https://mcp.example.com/ghp_abcdefghijklmnopqrstuvwxyz1234/mcp', '--yes', '--json']);
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'personal_url');
    assert.equal(fake.requests.length, 0);
  });
  it('warns and cuts a note longer than 500 characters', async () => {
    const r = await cli([ENDPOINT, '--yes', '--no-wait', '--note', 'n'.repeat(620)]);
    assert.match(r.stderr, /Warning: The note has 620 characters; mcp\.tc keeps 500/);
    assert.equal(JSON.parse(posts()[0].body).note.length, 500);
  });
  it('sends an npm package as its page', async () => {
    await cli(['npm:@example/weather-mcp', '--yes', '--no-wait']);
    assert.deepEqual(JSON.parse(posts()[0].body), { url: 'https://www.npmjs.com/package/@example/weather-mcp' });
  });
});

describe('submit: asking first', () => {
  it('without a terminal and without --yes it stops before sending (exit 2)', async () => {
    const r = await cli([ENDPOINT, '--json'], { stdin: { isTTY: false } });
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(r.json().error.code, 'needs_confirmation');
    assert.equal(fake.requests.length, 0);
    assert.equal(r.stderr, '');
  });
  it('in a terminal it shows what will be sent and the review note, then asks', async () => {
    const no = await inTerminal([ENDPOINT, '--note', 'Hi.'], 'n');
    assert.equal(no.code, EXIT.ERROR);
    assert.match(no.stderr, /mcp-tc will send this suggestion to 127\.0\.0\.1:\d+:\n {2}URL {3}https:\/\/mcp\.example\.com\/mcp\n {2}Note {2}Hi\./);
    assert.match(no.stderr, /including with an AI model, and a person may\s+review them\. Sending a suggestion doesn't mean the server will be listed\./);
    assert.match(no.stderr, /Send this suggestion to 127\.0\.0\.1:\d+\? \[y\/N\]/);
    assert.match(no.stderr, /Cancelled: nothing was sent\./);
    assert.equal(posts().length, 0);
    const yes = await inTerminal([ENDPOINT, '--no-wait'], 'y');
    assert.equal(yes.code, 0);
    assert.equal(posts().length, 1);
    assert.match(yes.stdout, /^Sent to 127\.0\.0\.1:\d+: https:\/\/mcp\.example\.com\/mcp$/m);
  });
  it('says when the input is a registry name', async () => {
    const r = await cli(['io.github.example/weather-mcp', '--yes', '--no-wait']);
    assert.match(r.stderr.replace(/\s+/g, ' '), /URL io\.github\.example\/weather-mcp \(an MCP Registry name; add https:\/\/ if you meant a web address\)/);
    assert.deepEqual(JSON.parse(posts()[0].body), { url: 'io.github.example/weather-mcp' });
  });
});

describe('submit: following the status', () => {
  it('listed: prints the link, exit 0, and the JSON keys', async () => {
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, 0);
    const doc = r.json();
    assert.deepEqual(Object.keys(doc), [
      'ok', 'command', 'sent', 'changes', 'state', 'terminal', 'timed_out', 'waited_seconds', 'token', 'status_url', 'page', 'existing_submission', 'listing', 'status',
    ]);
    assert.equal(doc.ok, true);
    assert.equal(doc.command, 'submit');
    assert.deepEqual(doc.sent, { url: ENDPOINT, kind: 'url', note: null });
    assert.equal(doc.state, 'listed');
    assert.equal(doc.terminal, true);
    assert.equal(doc.timed_out, false);
    assert.match(doc.token, /^faketok\d{6}$/);
    assert.equal(doc.status_url, `${fake.base}/s/${doc.token}.json`);
    assert.equal(doc.page, `${fake.base}/s/${doc.token}`);
    assert.equal(fake.requests[1].path, `/s/${doc.token}.json`);
    assert.deepEqual(doc.listing, { slug: 'weather-mcp', name: 'Weather MCP', link: `${fake.base}/i/weather-mcp` });
    assert.equal(doc.status.state, 'listed');
    assert.equal(doc.status.title, 'It’s listed');
    assert.equal(doc.waited_seconds, 20);
    assert.equal(r.stderr, '');
  });
  it('people see what was sent, the status page, progress on stderr and the link', async () => {
    const r = await cli([ENDPOINT, '--yes']);
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split('\n');
    assert.match(lines[0], /^Sent to 127\.0\.0\.1:\d+: https:\/\/mcp\.example\.com\/mcp$/);
    assert.match(lines[1], new RegExp(`^Status page: ${fake.base}/s/faketok\\d{6}$`));
    assert.equal(lines[2], `Listed: ${fake.base}/i/weather-mcp`);
    assert.equal(lines[3], 'Details and setup: mcp-tc info weather-mcp');
    assert.match(r.stderr, /Waiting up to 10m for the result\./);
    assert.match(r.stderr, /^\[0:10\] Checking the server: Connecting to it/m);
    assert.match(r.stderr, /^\[0:15\] Writing the listing: Summarizing/m);
    assert.doesNotMatch(r.stdout, /\u001b\[/);
  });
  it('checks every 5 s for the first minute, then every 10 s', async () => {
    fake.planSubmit({ states: [...Array(14).fill('queued'), ...Array(3).fill('reviewing'), 'listed'] });
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, 0);
    assert.deepEqual(sleeps, [...Array(12).fill(FAST_POLL_MS), ...Array(6).fill(SLOW_POLL_MS)]);
    assert.equal(reads().length, 18);
    assert.equal(r.json().waited_seconds, 120);
  });
  it('pending: exit 10, with the link it will have and the status page', async () => {
    fake.planSubmit({ states: ['queued', 'reviewing', 'pending'] });
    const r = await cli([ENDPOINT, '--yes']);
    assert.equal(r.code, EXIT.WAITING);
    assert.match(r.stdout, /^Waiting for review: We found the server\. A person reviews it before its link goes live\.$/m);
    assert.match(r.stdout, new RegExp(`^Its link, once it goes live: ${fake.base}/i/weather-mcp$`, 'm'));
    assert.match(r.stdout, /^Status page: /m);
  });
  it('rejected: exit 11 with mcp.tc’s message', async () => {
    fake.planSubmit({ states: ['checking', 'rejected_none'] });
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.NOT_ACCEPTED);
    const doc = r.json();
    assert.equal(doc.ok, true);
    assert.equal(doc.state, 'rejected');
    assert.equal(doc.listing, null);
    fake.planSubmit({ states: ['rejected'] });
    const h = await cli([ENDPOINT, '--yes']);
    assert.equal(h.code, EXIT.NOT_ACCEPTED);
    assert.match(h.stdout, /^Not listed: This server didn’t pass our checks, so it won’t be listed\.$/m);
  });
  it('error: exit 1, with the state in the JSON document', async () => {
    fake.planSubmit({ states: ['queued', 'failed'] });
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.ERROR);
    assert.equal(r.json().ok, true);
    assert.equal(r.json().state, 'error');
    fake.planSubmit({ states: ['error'] });
    const h = await cli([ENDPOINT, '--yes']);
    assert.match(h.stdout, /^Something went wrong: We couldn’t finish checking this server\./m);
  });
  it('duplicate in the status: exit 0 and the listing', async () => {
    fake.planSubmit({ states: ['checking', 'duplicate'], listing: { slug: 'deepwiki', name: 'DeepWiki' } });
    const r = await cli([ENDPOINT, '--yes']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, new RegExp(`^Already listed: ${fake.base}/i/deepwiki$`, 'm'));
  });
  it('--wait runs out: exit 12, the last state, and the status page', async () => {
    fake.planSubmit({ states: ['reviewing'] });
    const r = await cli([ENDPOINT, '--yes', '--wait', '30s', '--json']);
    assert.equal(r.code, EXIT.WAIT_TIMEOUT);
    const doc = r.json();
    assert.equal(doc.timed_out, true);
    assert.equal(doc.terminal, false);
    assert.equal(doc.state, 'reviewing');
    assert.equal(doc.waited_seconds, 30);
    assert.equal(sleeps.reduce((a, b) => a + b, 0), 30_000);
    fake.planSubmit({ states: ['reviewing'] });
    const h = await cli([ENDPOINT, '--yes', '--wait', '1m30s']);
    assert.equal(h.code, EXIT.WAIT_TIMEOUT);
    assert.match(h.stdout, /^Still being checked after 1m30s \(Writing the listing\)\. Follow it on the status page: /m);
  });
  it('--no-wait and --wait 0 stop after the 202, exit 0', async () => {
    for (const flag of [['--no-wait'], ['--wait', '0']]) {
      fake.reset();
      const r = await cli([ENDPOINT, '--yes', ...flag, '--json']);
      assert.equal(r.code, 0);
      assert.equal(reads().length, 0);
      const doc = r.json();
      assert.equal(doc.state, 'queued');
      assert.equal(doc.terminal, false);
      assert.equal(doc.status, null);
    }
    const h = await cli([ENDPOINT, '--yes', '--no-wait']);
    assert.match(h.stdout, /^Queued\. The status page updates by itself; as JSON: http:\/\/127\.0\.0\.1:\d+\/s\/faketok\d+\.json$/m);
  });
  it('--wait with --no-wait, or a bad --wait, is a usage error and sends nothing', async () => {
    for (const argv of [['--wait', '5m', '--no-wait'], ['--wait', 'soon'], ['--wait', '2h']]) {
      const r = await cli([ENDPOINT, '--yes', ...argv, '--json']);
      assert.equal(r.code, EXIT.USAGE, argv.join(' '));
    }
    assert.equal(fake.requests.length, 0);
  });
  it('a URL already waiting: follows that suggestion and says so', async () => {
    fake.planSubmit({ existing: true, states: ['reviewing', 'listed'] });
    const r = await cli([ENDPOINT, '--yes']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /already waiting to be checked/);
    fake.planSubmit({ existing: true });
    assert.equal((await cli([ENDPOINT, '--yes', '--no-wait', '--json'])).json().existing_submission, true);
  });
  it('already listed when sent: exit 0, the listing, no status reads', async () => {
    const r = await cli(['https://mcp.deepwiki.com/mcp', '--yes', '--json']);
    assert.equal(r.code, 0);
    const doc = r.json();
    assert.equal(doc.state, 'duplicate');
    assert.equal(doc.token, null);
    assert.deepEqual(doc.listing, { slug: 'deepwiki', name: 'DeepWiki', link: `${fake.base}/i/deepwiki` });
    assert.equal(reads().length, 0);
    const h = await cli(['https://mcp.deepwiki.com/mcp', '--yes']);
    assert.match(h.stdout, new RegExp(`^Already listed: ${fake.base}/i/deepwiki\nDetails and setup: mcp-tc info deepwiki$`, 'm'));
  });
  it('a 429 on a status read: waits for Retry-After, then goes on', async () => {
    // answers in order: the POST, a 429 for the first status read, then the status
    fake.respond(202, fill(SUBMIT.accepted, 'tok429aaaa'), { Location: `${fake.base}/s/tok429aaaa.json` });
    fake.respond(429, '<html>slow down</html>', { 'Retry-After': '25' });
    fake.respond(200, fill(SUBMIT.status.listed, 'tok429aaaa', { slug: 'deepwiki', name: 'DeepWiki' }));
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json().state, 'listed');
    assert.deepEqual(sleeps, [FAST_POLL_MS, 25_000]);
  });
  it('a status that disappears: exit 1, with the token kept in the error', async () => {
    fake.respond(202, fill(SUBMIT.accepted, 'tokgone123'), {});
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.ERROR);
    const e = r.json().error;
    assert.equal(e.code, 'status_missing');
    assert.equal(e.token, 'tokgone123');
    assert.equal(e.status_url, `${fake.base}/s/tokgone123.json`);
  });
  it('status reads that fail with 5xx are tried again, then reported', async () => {
    fake.planSubmit({ states: ['listed'] });
    const r0 = await cli([ENDPOINT, '--yes', '--no-wait', '--json']);
    const token = r0.json().token;
    fake.reset();
    fake.respond(202, fill(SUBMIT.accepted, token), {});
    fake.fail(2, 502);
    const ok = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(ok.code, 0, ok.stdout);
    fake.reset();
    fake.respond(202, fill(SUBMIT.accepted, token), {});
    fake.fail(3, 502);
    const bad = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(bad.code, EXIT.ERROR);
    assert.equal(bad.json().error.code, 'server_error');
  });
});

describe('submit: answers that are not a queued suggestion', () => {
  for (const code of ['empty', 'too_long', 'invalid_url', 'personal_url', 'blocked']) {
    it(`422 ${code}: exit 11, mcp.tc's message as it is, never sent again`, async () => {
      fake.submitError(code);
      const r = await cli([ENDPOINT, '--yes', '--json']);
      assert.equal(r.code, EXIT.NOT_ACCEPTED);
      const e = r.json().error;
      assert.equal(r.json().ok, false);
      assert.equal(e.code, code);
      assert.equal(e.status, 422);
      assert.equal(e.message, SUBMIT.errors[code].body.message);
      assert.equal(posts().length, 1);
      assert.deepEqual(sleeps, []);
    });
  }
  it('422 for people: the message alone', async () => {
    fake.submitError('blocked');
    const r = await cli([ENDPOINT, '--yes']);
    assert.match(r.stderr, /^Error: We can’t accept suggestions from this site\.$/m);
  });
  for (const scope of ['ip_day', 'global_day']) {
    it(`429 ${scope}: never retried, exit 4 with the scope and the wait`, async () => {
      fake.submitError(scope);
      const r = await cli([ENDPOINT, '--yes', '--json']);
      assert.equal(r.code, EXIT.RATE_LIMITED);
      const e = r.json().error;
      assert.equal(e.code, 'rate_limited');
      assert.equal(e.scope, scope);
      assert.equal(e.retry_after, SUBMIT.errors[scope].body.retry_after);
      assert.equal(posts().length, 1);
      assert.deepEqual(sleeps, []);
    });
  }
  it('429 ip_day for people: mcp.tc’s message and the wait in words', async () => {
    fake.submitError('ip_day');
    const r = await cli([ENDPOINT, '--yes']);
    assert.match(r.stderr, /Error: You’ve sent a lot of suggestions today\. Please try again tomorrow\. 127\.0\.0\.1:\d+ asks to wait about 12 hours\./);
  });
  it('429 ip_hour with a long wait: not retried, exit 4', async () => {
    fake.submitError('ip_hour');
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.RATE_LIMITED);
    assert.equal(r.json().error.retry_after, 1800);
    assert.equal(posts().length, 1);
  });
  it('429 ip_hour with a wait of 60 s or less: tried once more', async () => {
    fake.submitError('ip_hour_short');
    const r = await cli([ENDPOINT, '--yes', '--no-wait', '--json']);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(posts().length, 2);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 20_000 && sleeps[0] <= 20_250, String(sleeps[0]));
    fake.reset();
    sleeps.length = 0;
    fake.submitError('ip_hour_short');
    fake.submitError('ip_hour_short');
    const twice = await cli([ENDPOINT, '--yes', '--no-wait', '--json']);
    assert.equal(twice.code, EXIT.RATE_LIMITED);
    assert.equal(posts().length, 2, 'never a third time');
  });
  it('an HTML 429 from the web server (no Retry-After): waits 10 s, tries once more', async () => {
    fake.submitError('nginx_429');
    const r = await cli([ENDPOINT, '--yes', '--no-wait']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /limiting requests \(HTTP 429\)\. Trying once more in 10 s\./);
    assert.ok(sleeps[0] >= 10_000 && sleeps[0] <= 10_250);
    assert.equal(posts().length, 2);
    fake.reset();
    sleeps.length = 0;
    fake.submitError('nginx_429');
    fake.submitError('nginx_429');
    const twice = await cli([ENDPOINT, '--yes', '--no-wait', '--json']);
    assert.equal(twice.code, EXIT.RATE_LIMITED);
    assert.equal(twice.json().error.retry_after, null);
    assert.equal(posts().length, 2);
  });
  it('Cloudflare’s 429 with a wait over 60 s: not retried, exit 4', async () => {
    fake.submitError('cloudflare_429');
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.RATE_LIMITED);
    assert.equal(r.json().error.retry_after, 120);
    assert.equal(posts().length, 1);
  });
  it('503 paused: exit 1 with the wait', async () => {
    fake.submitError('paused');
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.ERROR);
    assert.equal(r.json().error.code, 'paused');
    assert.equal(r.json().error.retry_after, 3600);
    assert.equal(posts().length, 1);
  });
  for (const [name, status] of [['invalid_request', 400], ['cross_site', 403], ['not_found', 404], ['too_large', 413]]) {
    it(`${status} ${name}: exit 1 with mcp.tc's code and message`, async () => {
      fake.submitError(name);
      const r = await cli([ENDPOINT, '--yes', '--json']);
      assert.equal(r.code, EXIT.ERROR);
      assert.equal(r.json().error.code, name);
      assert.equal(r.json().error.status, status);
      assert.equal(posts().length, 1);
    });
  }
  it('a site without the JSON endpoint (an HTML page): unsupported, exit 1', async () => {
    fake.submitError('form_page');
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.ERROR);
    assert.equal(r.json().error.code, 'unsupported');
    assert.match(r.json().error.message, /\/submit instead/);
  });
  it('a 502 is reported, not sent again', async () => {
    fake.submitError('bad_gateway');
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.ERROR);
    assert.equal(r.json().error.code, 'server_error');
    assert.equal(posts().length, 1);
  });
  it('a Cloudflare block is reported as such, exit 1', async () => {
    fake.block(1, '1010');
    const r = await cli([ENDPOINT, '--yes', '--json']);
    assert.equal(r.code, EXIT.ERROR);
    assert.equal(r.json().error.code, 'blocked');
  });
  it('mcp.tc unreachable: network error, exit 1', async () => {
    const r = await runCli(['submit', ENDPOINT, '--yes', '--json'], { env: { MCPTC_BASE_URL: 'http://127.0.0.1:1' } });
    assert.equal(r.code, EXIT.ERROR);
    assert.equal(r.json().error.code, 'network_error');
  });
});

describe('submit: review fixes', () => {
  /** In a terminal, press a key at the question instead of answering. */
  async function pressAt(argv, key) {
    let stdout = '';
    let stderr = '';
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false });
    const err = new PassThrough();
    err.on('data', (d) => {
      stderr += d;
      if (/\[y\/N\] $/.test(stderr)) setImmediate(() => stdin.write(key));
    });
    const code = await main(['submit', ...argv], {
      stdout: /** @type {any} */ ({ isTTY: false, write: (t) => ((stdout += t), true) }),
      stderr: /** @type {any} */ (err),
      stdin,
      env: { PATH: process.env.PATH, COLUMNS: '100', MCPTC_BASE_URL: fake.base },
    });
    return { code, stdout, stderr };
  }

  it('ux-prompt-ctrl-c-exit-0: Ctrl+C at the question exits 130 with the JSON error document; nothing is sent', async () => {
    const r = await pressAt([ENDPOINT, '--json'], '\u0003');
    assert.equal(r.code, 130);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual([doc.ok, doc.command, doc.error.code], [false, 'submit', 'cancelled']);
    assert.equal(posts().length, 0);
    const human = await pressAt([ENDPOINT], '\u0003');
    assert.equal(human.code, 130);
    assert.match(human.stderr, /\[y\/N\] (\u001b\[\d+G)?\r?\nError: Cancelled\.\n$/);
    const eof = await pressAt([ENDPOINT, '--json'], '\u0004');
    assert.equal(eof.code, 1);
    assert.equal(JSON.parse(eof.stdout).error.code, 'cancelled');
    assert.equal(posts().length, 0);
  });

  it('ux-dash-value-misleading-error: a note that starts with "-" gets the equals-sign hint, and --note=... works', async () => {
    const r = await cli([ENDPOINT, '--note', '- maintained by Example', '--yes', '--no-wait']);
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /A value that starts with "-" needs an equals sign: --note="-\.\.\.", as one argument\./);
    assert.equal(posts().length, 0);
    const ok = await cli([ENDPOINT, '--note=- maintained by Example', '--yes', '--no-wait', '--json']);
    assert.equal(ok.code, 0, ok.stdout);
    assert.deepEqual(JSON.parse(posts()[0].body), { url: ENDPOINT, note: '- maintained by Example' });
  });

  it('ux-stderr-colors-follow-stdout: the preview on stderr takes stderr\'s colors', async () => {
    let stderr = '';
    let stdout = '';
    const code = await main(['submit', ENDPOINT, '--yes', '--no-wait'], {
      stdout: /** @type {any} */ ({ isTTY: true, columns: 100, write: (t) => ((stdout += t), true) }),
      stderr: /** @type {any} */ ({ isTTY: false, write: (t) => ((stderr += t), true) }),
      env: { PATH: process.env.PATH, MCPTC_BASE_URL: fake.base },
    });
    assert.equal(code, 0);
    assert.match(stderr, /URL {3}https:\/\/mcp\.example\.com\/mcp/);
    assert.doesNotMatch(stderr, /\u001b\[/);
  });
});

describe('submit: help', () => {
  it('documents the exit codes, the review and the options', async () => {
    const r = await runCli(['help', 'submit']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage: mcp-tc submit <url>/);
    for (const want of [/an AI model/, /a person may review/, /doesn't mean the server will be listed/, /10 waiting for a person's review/, /11 not accepted/, /12 --wait ran out/, /4 rate limited/, /--no-wait/, /--note <text>/, /npm:<package>/]) {
      assert.match(r.stdout.replace(/\s+/g, ' '), want);
    }
  });
});

/**
 * A fixture answer with the fake's base URL and the values filled in.
 * @param {any} v
 * @param {string} token
 * @param {{slug?: string, name?: string}} [l]
 */
function fill(v, token, l = {}) {
  return JSON.parse(
    JSON.stringify(v)
      .replaceAll('https://mcp.tc', fake.base)
      .replaceAll('{token}', token)
      .replaceAll('{slug}', l.slug || 'weather-mcp')
      .replaceAll('{name}', l.name || 'Weather MCP'),
  );
}
