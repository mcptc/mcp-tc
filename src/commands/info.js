// mcp-tc info: one listing through the directory's get_server tool (POST /mcp).
import { accessState, clientOptions, mcpCall } from '../lib/directory.js';
import { UsageError } from '../lib/errors.js';
import { listingQuery } from '../lib/target.js';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'info',
  summary: 'Show one listing: what it does, how to connect, its tools',
  usage: 'info <slug|name|link>',
  description:
    "Shows the server's own URL or install command, what it needs (sign-in, an API key, a local install), its tools with their read-only and destructive hints, the checkmark, the last check and the listing link. Takes a slug (notion), a name (\"GitHub\") or a listing link (https://mcp.tc/i/notion).",
  args: [{ name: 'slug|name|link', required: true, variadic: true }],
  options: {},
  examples: ['mcp-tc info notion', 'mcp-tc info https://mcp.tc/i/deepwiki', 'mcp-tc info memory --json'],
  exits: [
    [0, 'done'],
    [2, 'usage error, including text that is not a slug, a name or a listing link (it is not sent)'],
    [3, 'no listing with that slug or name, or it was removed'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) after the retries'],
  ],
};

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const input = ctx.positionals.join(' ').trim();
  if (!input) throw new UsageError('Missing <slug|name|link>. Usage: mcp-tc info <slug|name|link>');
  if (input.length > 200) throw new UsageError('That is too long for a slug, name or link (200 characters at most).', {}, 'invalid_argument');
  // a URL, a credential or a token typed here is refused before anything is sent
  const ref = listingQuery(input, ctx.base);
  return mcpCall('get_server', { slug: ref.slug }, clientOptions(ctx));
}

const HEALTH = {
  ok: 'answered',
  auth: 'answered and asked for sign-in',
  down: 'did not answer',
};

const TRACKING = {
  tools: 'Tool list, version and listing edits',
  version: 'Version and listing edits',
  listing: 'Listing edits',
};

/**
 * "2026-10-05T22:43:54Z" becomes "2026-10-05 22:43 UTC"; anything else comes back cleaned.
 * @param {unknown} iso
 */
export function when(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/**
 * @param {{name: string, required?: boolean, secret?: boolean}[]} list
 */
function names(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list
    .map((v) => {
      const tags = [v.required ? 'required' : null, v.secret ? 'secret' : null].filter(Boolean);
      return tags.length ? `${v.name} (${tags.join(', ')})` : v.name;
    })
    .join(', ');
}

/**
 * @param {{read_only?: boolean|null, destructive?: boolean|null}} t
 */
export function toolHints(t) {
  if (t.destructive === true) return 'destructive';
  if (t.read_only === true) return 'read-only';
  if (t.read_only === false) return 'writes';
  return '';
}

/**
 * @param {any} d get_server structuredContent
 * @param {import('../lib/output.js').Output} out
 */
export function render(d, out) {
  const st = accessState(d.kind, d.auth);
  const c = (/** @type {unknown} */ v) => out.clean(v, { oneLine: true });
  out.print(out.style.bold(`${c(d.name)}${d.verified ? ' \u2713' : ''}`));
  if (d.tagline) out.print(out.paragraph(d.tagline));
  out.print('');

  const note = c(d.auth_note);
  const access = note && note.toLowerCase().startsWith(st.label.toLowerCase()) ? note : [st.label, note].filter(Boolean).join('. ');
  const pkg = d.package && d.package.identifier ? `${d.package.identifier}${d.package.registry ? ` (${d.package.registry})` : ''}` : '';
  const health = d.health && d.health !== 'unknown' ? HEALTH[/** @type {keyof typeof HEALTH} */ (d.health)] || d.health : '';
  /** @type {[string, unknown][]} */
  const rows = [
    ['Vendor', d.vendor],
    ['Category', d.category_name ? `${d.category_name}${d.category ? ` (${d.category})` : ''}` : d.category],
    ['Access', access],
    ['Server URL', d.endpoint],
    ['Install', d.install_command],
    ['Package', d.install_command ? '' : pkg],
    ['Transport', d.transport],
    ['Environment', names(d.env_vars)],
    ['Headers', names(d.headers)],
    ['Checkmark', d.verified ? d.verified_by || 'Verified' : 'Not verified'],
    ['Last check', [when(d.last_checked), health].filter(Boolean).join(', ')],
    ['Version', d.server_version],
    ['Listing', d.link],
    ['Homepage', d.homepage],
    ['Repository', d.repository],
    ['Docs', d.docs],
    ['History', d.history_url],
    ['Tracked', d.tracking ? TRACKING[/** @type {keyof typeof TRACKING} */ (d.tracking)] || d.tracking : ''],
    ['Tools read', when(d.tools_checked)],
    ['Last change', when(d.last_changed)],
  ];
  out.print(out.fields(rows));

  if (d.description) {
    out.print('');
    out.print(out.style.bold('About'));
    out.print(out.paragraph(d.description, { indent: 2 }));
  }
  if (Array.isArray(d.capabilities) && d.capabilities.length) {
    out.print('');
    out.print(out.style.bold('What you can do'));
    for (const cap of d.capabilities) out.print(out.bullet(cap, { indent: 2 }));
  }

  const tools = Array.isArray(d.tools) ? d.tools : [];
  out.print('');
  out.print(out.style.bold(`Tools (${tools.length})`));
  if (!tools.length) {
    out.print(
      `  mcp.tc has no tool list for this server yet.${d.kind === 'remote' && d.auth !== 'none' ? ' Servers that need sign-in often show their tools only after it.' : ''}`,
    );
  } else {
    out.print(
      out.table(
        tools,
        [
          { key: 'name', header: 'Tool', keep: true },
          { key: 'read_only', header: 'Hints', format: (_v, t) => toolHints(t) },
          { key: 'summary', header: 'What it does', flex: true },
        ],
        { indent: 2 },
      ),
    );
    out.print(out.style.dim("  Hints come from the server's own tool annotations; blank means the server doesn't say."));
  }

  if (Array.isArray(d.example_prompts) && d.example_prompts.length) {
    out.print('');
    out.print(out.style.bold('Example prompts'));
    for (const p of d.example_prompts) out.print(out.bullet(p, { indent: 2 }));
  }

  if (Array.isArray(d.recent_changes) && d.recent_changes.length) {
    out.print('');
    out.print(out.style.bold('Recent changes'));
    out.print(
      out.table(
        d.recent_changes,
        [
          { key: 'at', header: 'When', format: (v) => when(v) },
          { key: 'kind', header: 'What' },
          { key: 'source', header: 'By' },
          { key: 'summary', header: 'Summary', flex: true },
        ],
        { indent: 2 },
      ),
    );
  }

  const clients = Array.isArray(d.setup) ? d.setup.map((/** @type {any} */ g) => c(g.client)).filter(Boolean) : [];
  out.print('');
  if (clients.length) {
    out.print(`Add it to a client: mcp-tc add ${c(d.slug)} --client <id>`);
    out.print(out.style.dim(`Clients: ${clients.join(', ')}`));
  } else {
    out.print(`Setup steps: ${c(d.link)}`);
  }
}
