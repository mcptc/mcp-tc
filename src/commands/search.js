// mcp-tc search: the directory's search_servers tool (POST /mcp), as a compact table.
import { UsageError } from '../lib/errors.js';
import { accessState, clientOptions, mcpCall } from '../lib/directory.js';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'search',
  summary: 'Search the directory for MCP servers',
  usage: 'search [query] [--category <slug>] [--auth none|sign-in|local] [--limit <n>]',
  description:
    "Looks for every word in the servers' names, vendors, taglines and tags. Results come in the directory's default order, featured first. With no words, it lists the directory in that order.",
  args: [{ name: 'query', variadic: true }],
  options: {
    category: { type: 'string', valueName: 'slug', description: 'Only servers in this category (slugs: mcp-tc categories)' },
    auth: {
      type: 'string',
      valueName: 'kind',
      choices: ['none', 'sign-in', 'local'],
      description: 'none: remote, no sign-in. sign-in: remote, needs sign-in or an API key. local: runs on your computer',
    },
    limit: { type: 'string', valueName: 'n', int: { min: 1, max: 25 }, description: 'How many results, 1 to 25 (default 10)' },
  },
  examples: [
    'mcp-tc search github',
    'mcp-tc search postgres --auth none',
    'mcp-tc search --category databases --limit 25',
    'mcp-tc search "issue tracker" --json',
  ],
  exits: [
    [0, 'done, also when nothing matches'],
    [2, 'usage error, including a category mcp.tc does not have'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) after the retries'],
  ],
};

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const query = ctx.positionals.join(' ').replace(/\s+/g, ' ').trim();
  if (query.length > 100) {
    throw new UsageError('The search words can be up to 100 characters long.', {}, 'invalid_argument');
  }
  /** @type {Record<string, unknown>} */
  const args = {};
  if (query) args.query = query;
  if (ctx.args.category) args.category = String(ctx.args.category).trim();
  if (ctx.args.auth) args.auth = ctx.args.auth;
  if (ctx.args.limit !== undefined) args.limit = ctx.args.limit;
  const data = await mcpCall('search_servers', args, clientOptions(ctx));
  // keep the request beside the answer so render() can describe it; dropped from --json output below
  Object.defineProperty(data, '__request', { value: { query, category: args.category ?? null, auth: args.auth ?? null }, enumerable: false });
  return data;
}

/**
 * @param {any} data search_servers structuredContent
 * @param {import('../lib/output.js').Output} out
 */
export function render(data, out) {
  const req = data.__request || {};
  const results = Array.isArray(data.results) ? data.results : [];
  const what = describe(req);
  if (!results.length) {
    out.print(`No servers match${what ? ` ${what}` : ''}. Try fewer or other words, another category, or no --auth filter.`);
    return;
  }
  const total = Number(data.total) || results.length;
  const noun = total === 1 ? 'server' : 'servers';
  const head = what ? `${total} ${noun} ${total === 1 ? 'matches' : 'match'} ${what}` : `${total} ${noun} in the directory`;
  out.print(`${head}, featured first.${results.length < total ? ` Showing ${results.length}.` : ''}`);
  out.print('');
  out.print(
    out.table(results, [
      // the checkmark stays when a narrow terminal cuts the name, and the slug (typed back into info) is never cut
      { key: 'name', header: 'Name', max: 32, suffix: (r) => (r.verified ? ' \u2713' : '') },
      { key: 'slug', header: 'Slug', keep: true },
      {
        key: 'auth',
        header: 'Access',
        format: (_v, r) => accessState(r.kind, r.auth).label,
        style: (text, r) => paint(out, accessState(r.kind, r.auth).key, text),
      },
      { key: 'tagline', header: 'Tagline', flex: true },
    ]),
  );
  out.print('');
  if (results.some((/** @type {any} */ r) => r.verified)) {
    out.print(out.style.dim('\u2713 Verified: the checkmark says who runs the server, not that it is safe.'));
  }
  if (data.more_url) out.print(`More results on mcp.tc: ${out.clean(data.more_url, { oneLine: true })}`);
  out.print(`Details and setup: mcp-tc info <slug>`);
}

/**
 * @param {{query?: string, category?: string|null, auth?: string|null}} req
 */
function describe(req) {
  const parts = [];
  if (req.query) parts.push(`"${req.query}"`);
  if (req.category) parts.push(`in ${req.category}`);
  if (req.auth === 'none') parts.push('with no sign-in');
  if (req.auth === 'sign-in') parts.push('that need sign-in or a key');
  if (req.auth === 'local') parts.push('that run locally');
  return parts.join(' ');
}

/**
 * Color for an access state: green for no sign-in, yellow for sign-in or a key, dim for local and unconfirmed.
 * @param {import('../lib/output.js').Output} out
 * @param {string} key
 * @param {string} text
 */
export function paint(out, key, text) {
  if (key === 'ok') return out.style.green(text);
  if (key === 'auth' || key === 'key' || key === 'opt') return out.style.yellow(text);
  return out.style.dim(text);
}
