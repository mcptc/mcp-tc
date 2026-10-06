import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDirectory, runCli, fixture } from './helpers/fake-directory.js';

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(() => fake.close());
beforeEach(() => fake.reset());
const cli = (argv) => runCli(argv, { base: fake.base });
const recorded = fixture('mcp-categories').message.result.structuredContent;

describe('mcp-tc categories', () => {
  it('lists every category with its slug, name and count', async () => {
    const r = await cli(['categories']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Slug\s+Name\s+Servers\s+About$/m);
    for (const c of recorded.categories) {
      assert.match(r.stdout, new RegExp(`^${c.slug}\\s+${c.name.replace(/[&]/g, '\\$&')}\\s+${c.count}\\s`, 'm'), c.slug);
    }
    // the totals come from the answer, not from the CLI
    assert.match(r.stdout, new RegExp(`^${recorded.total_servers} servers in ${recorded.categories.length} categories\\.$`, 'm'));
    assert.match(r.stdout, /^Search one: mcp-tc search --category <slug> \[words\]$/m);
  });

  it('--json returns list_categories structuredContent', async () => {
    const { ok, command, ...rest } = (await cli(['categories', '--json'])).json();
    assert.equal(ok, true);
    assert.equal(command, 'categories');
    assert.deepEqual(rest, recorded);
  });

  it('sends list_categories with no arguments', async () => {
    await cli(['categories']);
    const body = JSON.parse(fake.requests[0].body);
    assert.equal(body.params.name, 'list_categories');
    assert.deepEqual(body.params.arguments, {});
  });

  it('takes no arguments', async () => {
    const r = await cli(['categories', 'extra']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /takes no arguments/);
  });
});
