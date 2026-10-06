// mcp-tc badge: README badge, website card and iframe snippets for a listing.
// Every address comes from the listing JSON (/i/{slug}.json: "link" and the "embeds" URLs), so a change on mcp.tc
// reaches the snippets without a new release. The markup around them is the one https://mcp.tc/embed shows.
import { LANGS, clientOptions, listingJson, requireSlug } from '../lib/directory.js';
import { CliError, EXIT, UsageError } from '../lib/errors.js';

export const FORMATS = Object.freeze(['md', 'html', 'js', 'iframe']);

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'badge',
  summary: 'Print badge, website card and iframe snippets for a listing',
  usage: 'badge <slug> [--format md|html|js|iframe] [--lang en|it|fr|de|es]',
  description:
    'md and html: the README badge linked to the listing. js: the website card (one script tag). iframe: the compact card for pages that do not allow scripts. --lang sets the language of the card and the iframe, and links to the listing page in that language once it is translated; the badge itself has no language. With --format, only that snippet is printed, ready to paste or append to a file.',
  args: [{ name: 'slug', required: true }],
  options: {
    format: { type: 'string', valueName: 'format', choices: [...FORMATS], description: 'Only this snippet: md, html, js or iframe' },
    lang: { type: 'string', valueName: 'lang', choices: [...LANGS], description: 'Language of the card, the iframe and the link: en (default), it, fr, de or es' },
  },
  examples: ['mcp-tc badge notion', 'mcp-tc badge my-server --format md >> README.md', 'mcp-tc badge deepwiki --format js --lang it'],
  exits: [
    [0, 'done'],
    [3, 'no listing with that slug, or it was removed'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) after the retries'],
  ],
};

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** @param {string} s */
function escapeMdText(s) {
  return s.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * An http(s) URL from the listing JSON, or null.
 * @param {unknown} v
 */
function urlField(v) {
  if (typeof v !== 'string' || v.length > 500 || /[\s<>"'`\\]/.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The four snippets from a listing JSON document. A format whose address is missing is left out.
 * @param {any} listing
 * @returns {Partial<Record<'md'|'html'|'js'|'iframe', string>>}
 */
export function snippetsFrom(listing) {
  const e = listing && typeof listing.embeds === 'object' && listing.embeds ? listing.embeds : {};
  const page = urlField(listing.link);
  const badge = urlField(e.badge);
  const widget = urlField(e.widget);
  const iframe = urlField(e.iframe);
  const name = String(listing.name || listing.slug || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .slice(0, 120);
  const alt = `${name} on mcp.tc`;
  /** @type {Partial<Record<'md'|'html'|'js'|'iframe', string>>} */
  const s = {};
  if (badge && page) {
    s.md = `[![${escapeMdText(alt)}](${badge})](${page})`;
    s.html = `<a href="${escapeHtml(page)}"><img src="${escapeHtml(badge)}" alt="${escapeHtml(alt)}" height="20"></a>`;
  }
  if (widget) s.js = `<script src="${escapeHtml(widget)}" async></script>`;
  if (iframe) {
    s.iframe = `<iframe src="${escapeHtml(iframe)}" title="${escapeHtml(alt)}" width="420" height="200" loading="lazy" allow="clipboard-write" style="border:0;border-radius:8px;max-width:100%"></iframe>`;
  }
  return s;
}

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const { slug, lang: linkLang } = requireSlug(ctx.positionals[0], ctx.base);
  const lang = ctx.args.lang || linkLang || 'en';
  if (!LANGS.includes(lang)) throw new UsageError(`--lang must be one of: ${LANGS.join(', ')}.`);
  const listing = await listingJson(slug, { ...clientOptions(ctx), lang });
  const all = snippetsFrom(listing);
  const wanted = ctx.args.format ? [ctx.args.format] : FORMATS;
  /** @type {Record<string, string>} */
  const snippets = {};
  for (const f of wanted) {
    const v = all[/** @type {keyof typeof all} */ (f)];
    if (v === undefined) {
      throw new CliError(
        'format_unavailable',
        `The listing data for "${listing.slug}" has no address for the ${f} snippet, so mcp-tc can't print it. See https://mcp.tc/embed`,
        EXIT.ERROR,
        { format: f },
      );
    }
    snippets[f] = v;
  }
  return { slug: listing.slug, name: listing.name, link: listing.link, lang, format: ctx.args.format || null, snippets };
}

const TITLES = {
  md: 'README badge (Markdown)',
  html: 'Badge (HTML)',
  js: 'Website card (script tag)',
  iframe: 'Compact card (iframe)',
};

/**
 * @param {{format: string|null, lang: string, snippets: Record<string, string>}} r
 * @param {import('../lib/output.js').Output} out
 */
export function render(r, out) {
  if (r.format) {
    out.print(r.snippets[r.format]);
    return;
  }
  const keys = Object.keys(r.snippets);
  keys.forEach((k, i) => {
    out.print(out.style.bold(TITLES[/** @type {keyof typeof TITLES} */ (k)] || k));
    out.print(r.snippets[k]);
    if (i < keys.length - 1) out.print('');
  });
  out.print('');
  if (r.lang !== 'en') out.print(out.style.dim('The alt text is English: translate "on mcp.tc" for your page.'));
  out.print(out.style.dim('Options (themes, sizes, languages): https://mcp.tc/embed'));
}
