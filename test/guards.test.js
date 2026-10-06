// Guards that keep input away from mcp.tc: an mcp.tc page is never suggested as a server, and add never sends text
// shaped like a URL or a credential to get_server. Both refuse before any request.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDirectory, runCli } from './helpers/fake-directory.js';
import { EXIT } from '../src/lib/errors.js';
import { prepareUrl } from '../src/commands/submit.js';

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

describe('submit refuses mcp.tc addresses', () => {
  it('a listing link names the listing and suggests info', () => {
    assert.throws(() => prepareUrl('https://mcp.tc/i/notion'), (e) => e.code === 'mcptc_link' && /mcp-tc info notion/.test(e.message));
    assert.throws(() => prepareUrl('mcp.tc/it/i/deepwiki'), (e) => e.code === 'mcptc_link' && /mcp-tc info deepwiki/.test(e.message));
  });

  it('any other mcp.tc address is not a server either', () => {
    assert.throws(() => prepareUrl('https://www.mcp.tc/directory'), (e) => e.code === 'mcptc_link');
  });

  it('nothing is sent for it', async () => {
    const r = await runCli(['submit', 'https://mcp.tc/i/notion', '--yes', '--json'], { base: fake.base });
    assert.equal(r.code, EXIT.USAGE);
    assert.equal(JSON.parse(r.stdout).error.code, 'mcptc_link');
    assert.equal(fake.requests.filter((q) => q.method === 'POST').length, 0);
  });
});

describe('add sends only listing-shaped input to mcp.tc', () => {
  for (const input of ['admin:Sup3rSecret@mcp.example.com/mcp', 'https://mcp.example.com/mcp?key=abc', 'sk_live_0123456789abcdefABCDEF']) {
    it(`refuses ${input.slice(0, 24)}… before any request`, async () => {
      const r = await runCli(['add', input, '--client', 'cursor', '--dry-run', '--json'], { base: fake.base });
      assert.equal(r.code, EXIT.USAGE);
      assert.equal(JSON.parse(r.stdout).error.code, 'invalid_listing');
      assert.equal(fake.requests.length, 0);
      assert.ok(!r.stdout.includes('Sup3rSecret') && !r.stderr.includes('Sup3rSecret'));
    });
  }

  it('a slug and a listing link still work', async () => {
    const r = await runCli(['add', 'https://mcp.tc/i/deepwiki', '--client', 'claude-ai', '--json'], { base: fake.base });
    assert.equal(r.code, EXIT.OK, r.stderr);
    assert.ok(fake.requests.some((q) => q.method === 'POST' && q.path === '/mcp'));
  });
});

describe('the exit code table', () => {
  it('has the interrupt code a shell reports for Ctrl+C', () => {
    assert.equal(EXIT.INTERRUPTED, 130);
  });
});
