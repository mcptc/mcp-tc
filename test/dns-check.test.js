import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomain, lookup, run, render, meta } from '../src/commands/dns-check.js';
import { createOutput } from '../src/lib/output.js';
import { EXIT } from '../src/lib/errors.js';
import { runCli } from './helpers/fake-directory.js';

/** A resolver answering from a table: name -> records (string[][]) or an error code. */
function resolver(table) {
  const asked = [];
  const fn = async (name) => {
    asked.push(name);
    const v = table[name];
    if (v === undefined) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
    if (typeof v === 'string') throw Object.assign(new Error(`queryTxt ${v}`), { code: v });
    return v;
  };
  return { fn, asked };
}

/** Run the command in-process with an injected resolver. */
async function check(domain, table) {
  let exit = 0;
  const r = resolver(table);
  const result = await run({ positionals: [domain], args: {}, resolveTxt: r.fn, setExitCode: (c) => (exit = c) });
  let text = '';
  const stream = { isTTY: false, write: (s) => ((text += s), true) };
  render(result, createOutput({ stdout: stream, stderr: stream, env: {} }));
  return { result, exit, text, asked: r.asked };
}

describe('normalizeDomain()', () => {
  const ok = [
    ['example.com', 'example.com'],
    ['  Example.COM.  ', 'example.com'],
    ['https://mcp.example.com/mcp?key=1', 'mcp.example.com'],
    ['example.com/path', 'example.com'],
    ['example.com:8443', 'example.com'],
    ['_mcp-tc.example.com', 'example.com'],
    ['b\u00FCcher.example', 'xn--bcher-kva.example'],
  ];
  for (const [input, want] of ok) {
    it(`${JSON.stringify(input)} -> ${want}`, () => assert.equal(normalizeDomain(input).domain, want));
  }
  it('notes a record name given as the domain', () => {
    assert.equal(normalizeDomain('_mcp-tc.example.com').strippedRecordName, true);
  });
  for (const bad of ['', 'localhost', '127.0.0.1', 'http://[::1]/', 'exa mple.com', '-bad-.com', `${'a'.repeat(64)}.com`]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(() => normalizeDomain(bad), (e) => e.exit === EXIT.USAGE);
    });
  }
});

describe('lookup()', () => {
  it('joins TXT chunks and finds the token', async () => {
    const r = resolver({ 'a.com': [['mcp-tc-verification=ABC', 'DEF'], ['v=spf1 -all']] });
    assert.deepEqual(await lookup('a.com', r.fn), { name: 'a.com', status: 'found', tokens: ['ABCDEF'], records: 2 });
  });
  it('tells NXDOMAIN, no TXT, other TXT, timeout and failures apart', async () => {
    const r = resolver({ 'n.com': 'ENODATA', 'o.com': [['google-site-verification=x']], 't.com': 'ETIMEOUT', 's.com': 'ESERVFAIL', 'e.com': 'ECONNREFUSED' });
    assert.equal((await lookup('x.com', r.fn)).status, 'nxdomain');
    assert.equal((await lookup('n.com', r.fn)).status, 'no_txt');
    assert.equal((await lookup('o.com', r.fn)).status, 'other_txt');
    assert.equal((await lookup('t.com', r.fn)).status, 'timeout');
    assert.equal((await lookup('s.com', r.fn)).status, 'servfail');
    const e = await lookup('e.com', r.fn);
    assert.equal(e.status, 'error');
    assert.equal(e.error, 'ECONNREFUSED');
  });
});

describe('mcp-tc dns-check', () => {
  it('found at the domain: exit 0, token shown', async () => {
    const c = await check('example.com', { 'example.com': [['mcp-tc-verification=TOKEN123']], '_mcp-tc.example.com': 'ENOTFOUND' });
    assert.equal(c.exit, 0);
    assert.equal(c.result.found, true);
    assert.deepEqual(c.result.tokens, ['TOKEN123']);
    assert.deepEqual(c.asked, ['example.com', '_mcp-tc.example.com']);
    assert.match(c.text, /example\.com\s+found: mcp-tc-verification=TOKEN123/);
    assert.match(c.text, /_mcp-tc\.example\.com\s+no such name \(NXDOMAIN\)/);
    assert.match(c.text, /Found 1 token\./);
    assert.match(c.text, /authoritative name servers/);
  });

  it('found at _mcp-tc.<domain>: exit 0', async () => {
    const c = await check('example.com', { 'example.com': [['v=spf1 -all']], '_mcp-tc.example.com': [['mcp-tc-verification=XYZ']] });
    assert.equal(c.exit, 0);
    assert.deepEqual(c.result.tokens, ['XYZ']);
    assert.match(c.text, /example\.com\s+1 TXT record, none for mcp\.tc/);
  });

  it('nothing found: exit 3', async () => {
    const c = await check('example.com', { 'example.com': 'ENODATA' });
    assert.equal(c.exit, EXIT.NOT_FOUND);
    assert.equal(c.result.found, false);
    assert.equal(c.result.complete, true);
    assert.match(c.text, /No mcp-tc-verification= record found at example\.com or _mcp-tc\.example\.com\./);
  });

  it('lookups failed and nothing found: exit 1, marked incomplete', async () => {
    const c = await check('example.com', { 'example.com': 'ETIMEOUT', '_mcp-tc.example.com': 'ETIMEOUT' });
    assert.equal(c.exit, EXIT.ERROR);
    assert.equal(c.result.complete, false);
    assert.match(c.text, /some lookups failed/);
  });

  it('a www. name gets a hint', async () => {
    const c = await check('www.example.com', {});
    assert.match(c.text, /without "www\."/);
  });

  it('result keys are stable for --json', async () => {
    const c = await check('example.com', { 'example.com': [['mcp-tc-verification=T']] });
    assert.deepEqual(Object.keys(c.result), ['domain', 'found', 'tokens', 'complete', 'lookups', 'resolver', 'note']);
  });

  it('bad input is a usage error before any lookup (exit 2)', async () => {
    const r = await runCli(['dns-check', '10.0.0.1', '--json']);
    assert.equal(r.code, 2);
    assert.equal(r.json().error.code, 'invalid_domain');
    assert.equal((await runCli(['dns-check'])).code, 2);
  });

  it('help says what the exit codes mean', async () => {
    assert.deepEqual(meta.exits.map(([c]) => c), [0, 1, 3]);
    const h = await runCli(['dns-check', '--help']);
    assert.match(h.stdout, /Exit codes:\n {2}0 {2}a record was found\n {2}1 {2}the lookups failed, so the answer is not known\n {2}2 {2}usage error.*\n {2}3 {2}no record found/);
  });
});
