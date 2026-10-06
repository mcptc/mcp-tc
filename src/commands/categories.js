// mcp-tc categories: the directory's list_categories tool (POST /mcp).
import { clientOptions, mcpCall } from '../lib/directory.js';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'categories',
  summary: 'List the directory categories and how many servers each has',
  usage: 'categories',
  description: 'Use a slug from this list with: mcp-tc search --category <slug>',
  args: [],
  options: {},
  examples: ['mcp-tc categories', 'mcp-tc categories --json'],
  exits: [
    [0, 'done'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) after the retries'],
  ],
};

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  return mcpCall('list_categories', {}, clientOptions(ctx));
}

/**
 * @param {any} data list_categories structuredContent
 * @param {import('../lib/output.js').Output} out
 */
export function render(data, out) {
  const cats = Array.isArray(data.categories) ? data.categories : [];
  out.print(
    out.table(cats, [
      { key: 'slug', header: 'Slug', keep: true },
      { key: 'name', header: 'Name', max: 32 },
      { key: 'count', header: 'Servers', format: (v) => String(Number(v) || 0) },
      { key: 'description', header: 'About', flex: true },
    ]),
  );
  out.print('');
  const total = Number(data.total_servers);
  out.print(`${Number.isFinite(total) ? `${total} servers in ` : ''}${cats.length} categories.`);
  out.print('Search one: mcp-tc search --category <slug> [words]');
}
