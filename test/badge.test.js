import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeDirectory, runCli, fixture, GONE_SLUG } from './helpers/fake-directory.js';
import { snippetsFrom, FORMATS } from '../src/commands/badge.js';

let fake;
before(async () => {
  fake = await startFakeDirectory();
});
after(() => fake.close());
beforeEach(() => fake.reset());
const cli = (argv) => runCli(argv, { base: fake.base });
const deepwiki = fixture('listing-deepwiki').body;

describe('snippetsFrom()', () => {
  it('builds the four snippets from the listing JSON addresses', () => {
    const s = snippetsFrom(deepwiki);
    assert.deepEqual(Object.keys(s), ['md', 'html', 'js', 'iframe']);
    assert.equal(s.md, '[![DeepWiki on mcp.tc](https://mcp.tc/i/deepwiki/badge.svg)](https://mcp.tc/i/deepwiki)');
    assert.equal(s.html, '<a href="https://mcp.tc/i/deepwiki"><img src="https://mcp.tc/i/deepwiki/badge.svg" alt="DeepWiki on mcp.tc" height="20"></a>');
    assert.equal(s.js, '<script src="https://mcp.tc/w/deepwiki.js" async></script>');
    assert.equal(
      s.iframe,
      '<iframe src="https://mcp.tc/embed/deepwiki" title="DeepWiki on mcp.tc" width="420" height="200" loading="lazy" allow="clipboard-write" style="border:0;border-radius:8px;max-width:100%"></iframe>',
    );
  });

  it('uses only addresses from the JSON: a changed address shows up as is', () => {
    const moved = structuredClone(deepwiki);
    moved.embeds.widget = 'https://cdn.example.mcp.tc/w/deepwiki.js?v=2';
    assert.equal(snippetsFrom(moved).js, '<script src="https://cdn.example.mcp.tc/w/deepwiki.js?v=2" async></script>');
  });

  it('leaves out a format whose address is missing or not http(s)', () => {
    const d = structuredClone(deepwiki);
    delete d.embeds.iframe;
    d.embeds.widget = 'javascript:alert(1)';
    const s = snippetsFrom(d);
    assert.deepEqual(Object.keys(s), ['md', 'html']);
    const noLink = { ...structuredClone(deepwiki), link: null };
    assert.equal(snippetsFrom(noLink).md, undefined);
  });

  it('escapes names in Markdown and HTML', () => {
    const d = { ...structuredClone(deepwiki), name: 'A] "B" <C> & [D' };
    const s = snippetsFrom(d);
    assert.ok(s.md.startsWith('[![A\\] "B" <C> & \\[D on mcp.tc]('), s.md);
    assert.match(s.html, /alt="A\] &quot;B&quot; &lt;C&gt; &amp; \[D on mcp\.tc"/);
    assert.match(s.iframe, /title="A\] &quot;B&quot; &lt;C&gt; &amp; \[D on mcp\.tc"/);
  });
});

describe('mcp-tc badge', () => {
  it('prints all four snippets with titles', async () => {
    const r = await cli(['badge', 'deepwiki']);
    assert.equal(r.code, 0);
    for (const t of ['README badge (Markdown)', 'Badge (HTML)', 'Website card (script tag)', 'Compact card (iframe)']) assert.ok(r.stdout.includes(t), t);
    const s = snippetsFrom(deepwiki);
    for (const f of FORMATS) assert.ok(r.stdout.includes(s[f]), f);
    assert.match(r.stdout, /https:\/\/mcp\.tc\/embed/);
    assert.equal(fake.requests[0].path, '/i/deepwiki.json');
  });

  it('--format prints only that snippet, ready to append to a file', async () => {
    const r = await cli(['badge', 'deepwiki', '--format', 'md']);
    assert.equal(r.stdout, `${snippetsFrom(deepwiki).md}\n`);
  });

  it('--lang asks the JSON for that language and uses its addresses', async () => {
    const r = await cli(['badge', 'notion', '--lang', 'it', '--json']);
    assert.equal(fake.requests[0].path, '/i/notion.json?lang=it');
    const doc = r.json();
    assert.equal(doc.lang, 'it');
    assert.equal(doc.link, 'https://mcp.tc/it/i/notion');
    assert.equal(doc.snippets.js, '<script src="https://mcp.tc/w/notion.js?lang=it" async></script>');
    assert.match(doc.snippets.iframe, /src="https:\/\/mcp\.tc\/embed\/notion\?lang=it"/);
    assert.match(doc.snippets.md, /\(https:\/\/mcp\.tc\/i\/notion\/badge\.svg\)\]\(https:\/\/mcp\.tc\/it\/i\/notion\)$/);
    const human = await cli(['badge', 'notion', '--lang', 'it']);
    assert.match(human.stdout, /The alt text is English/);
  });

  it('English sends no ?lang=', async () => {
    await cli(['badge', 'deepwiki', '--lang', 'en']);
    assert.equal(fake.requests[0].path, '/i/deepwiki.json');
  });

  it('--json shape', async () => {
    const doc = (await cli(['badge', 'deepwiki', '--format', 'js', '--json'])).json();
    assert.deepEqual(Object.keys(doc), ['ok', 'command', 'slug', 'name', 'link', 'lang', 'format', 'snippets']);
    assert.deepEqual(Object.keys(doc.snippets), ['js']);
  });

  it('unknown or removed listing: exit 3; bad options: exit 2', async () => {
    assert.equal((await cli(['badge', 'zz-none'])).code, 3);
    assert.equal((await cli(['badge', GONE_SLUG])).code, 3);
    assert.equal((await cli(['badge', 'deepwiki', '--format', 'png'])).code, 2);
    assert.equal((await cli(['badge', 'deepwiki', '--lang', 'pt'])).code, 2);
    assert.equal((await cli(['badge', 'Not A Slug'])).code, 2);
  });
});
