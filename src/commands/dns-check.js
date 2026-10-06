// mcp-tc dns-check: look for mcp-tc-verification= TXT records at a domain and at _mcp-tc.<domain>, with the system's
// resolver, and say what was found. mcp.tc also asks the domain's authoritative name servers, so it can see a new
// record before a caching resolver does.
import { promises as dns } from 'node:dns';
import { EXIT, UsageError } from '../lib/errors.js';

const PREFIX = 'mcp-tc-verification=';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'dns-check',
  summary: "Look for mcp.tc verification TXT records in a domain's DNS",
  usage: 'dns-check <domain>',
  description:
    'Looks up TXT records starting with mcp-tc-verification= at the domain and at _mcp-tc.<domain>, using your system resolver, and prints the tokens it finds.',
  args: [{ name: 'domain', required: true }],
  options: {},
  examples: ['mcp-tc dns-check example.com', 'mcp-tc dns-check https://mcp.example.com/mcp', 'mcp-tc dns-check example.com --json'],
  exits: [
    [0, 'a record was found'],
    [1, 'the lookups failed, so the answer is not known'],
    [3, 'no record found'],
  ],
};

/**
 * A domain name from what the person typed (a domain, a URL, a name with a trailing dot, an IDN), or a UsageError.
 * @param {string} input
 * @returns {{domain: string, strippedRecordName: boolean}}
 */
export function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) throw new UsageError('Missing <domain>. Usage: mcp-tc dns-check <domain>');
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      throw new UsageError(`"${input}" is not a valid domain or URL.`, {}, 'invalid_domain');
    }
  } else {
    s = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  }
  s = s.replace(/\.+$/, '');
  let strippedRecordName = false;
  if (s.startsWith('_mcp-tc.')) {
    s = s.slice('_mcp-tc.'.length);
    strippedRecordName = true;
  }
  let host;
  try {
    host = new URL(`http://${s}/`).hostname; // IDN to punycode
  } catch {
    throw new UsageError(`"${input}" is not a valid domain.`, {}, 'invalid_domain');
  }
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) {
    throw new UsageError('That is an IP address. DNS verification needs a domain name, like example.com.', {}, 'invalid_domain');
  }
  const labels = host.split('.');
  if (labels.length < 2 || host.length > 253 || !labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) {
    throw new UsageError(`"${input}" is not a valid domain. Use a name like example.com.`, {}, 'invalid_domain');
  }
  return { domain: host, strippedRecordName };
}

/**
 * @param {string} name
 * @returns {Promise<string[][]>}
 */
function systemResolveTxt(name) {
  const r = new dns.Resolver({ timeout: 4000, tries: 2 });
  return r.resolveTxt(name);
}

/**
 * One TXT lookup, summarised.
 * @param {string} name
 * @param {(name: string) => Promise<string[][]>} resolveTxt
 */
export async function lookup(name, resolveTxt) {
  try {
    const records = (await resolveTxt(name)).map((chunks) => chunks.join(''));
    const tokens = records.filter((r) => r.toLowerCase().startsWith(PREFIX)).map((r) => r.slice(PREFIX.length).trim());
    if (tokens.length) return { name, status: 'found', tokens, records: records.length };
    return { name, status: records.length ? 'other_txt' : 'no_txt', tokens: [], records: records.length };
  } catch (err) {
    const code = String((err && /** @type {any} */ (err).code) || '');
    const status = code === 'ENODATA' ? 'no_txt' : code === 'ENOTFOUND' ? 'nxdomain' : code === 'ETIMEOUT' ? 'timeout' : code === 'ESERVFAIL' ? 'servfail' : 'error';
    return { name, status, tokens: [], records: 0, ...(status === 'error' ? { error: code || 'unknown' } : {}) };
  }
}

/**
 * @param {any} ctx ctx.resolveTxt replaces the system resolver (tests)
 */
export async function run(ctx) {
  const { domain, strippedRecordName } = normalizeDomain(ctx.positionals[0]);
  const resolveTxt = ctx.resolveTxt || systemResolveTxt;
  const lookups = [];
  for (const name of [domain, `_mcp-tc.${domain}`]) lookups.push(await lookup(name, resolveTxt));
  const tokens = [...new Set(lookups.flatMap((l) => l.tokens))];
  const found = tokens.length > 0;
  const inconclusive = !found && lookups.some((l) => ['timeout', 'servfail', 'error'].includes(l.status));
  if (!found) ctx.setExitCode(inconclusive ? EXIT.ERROR : EXIT.NOT_FOUND);
  return {
    domain,
    found,
    tokens,
    complete: !lookups.some((l) => ['timeout', 'servfail', 'error'].includes(l.status)),
    lookups,
    resolver: 'system',
    note: 'mcp.tc also asks the domain\'s authoritative name servers, so a record you just added can reach mcp.tc before your resolver shows it.',
    ...(strippedRecordName ? { input_was_record_name: true } : {}),
  };
}

/** @param {{status: string, tokens: string[], records: number, error?: string}} l */
function statusText(l) {
  switch (l.status) {
    case 'found':
      return l.tokens.map((t) => `found: ${PREFIX}${t}`).join('; ');
    case 'other_txt':
      return `${l.records} TXT record${l.records === 1 ? '' : 's'}, none for mcp.tc`;
    case 'no_txt':
      return 'no TXT records';
    case 'nxdomain':
      return 'no such name (NXDOMAIN)';
    case 'timeout':
      return 'no answer (timed out)';
    case 'servfail':
      return 'the DNS server failed (SERVFAIL)';
    default:
      return `lookup failed (${l.error || 'unknown error'})`;
  }
}

/**
 * @param {any} r
 * @param {import('../lib/output.js').Output} out
 */
export function render(r, out) {
  out.print(`TXT records starting with ${PREFIX} (system resolver):`);
  out.print('');
  out.print(
    out.table(
      r.lookups,
      [
        { key: 'name', header: 'Name' },
        { key: 'status', header: 'Result', flex: true, format: (_v, l) => statusText(l), style: (t, l) => (l.status === 'found' ? out.style.green(t) : t) },
      ],
      { indent: 2, header: false },
    ),
  );
  out.print('');
  if (r.input_was_record_name) out.print(`Checked the domain ${r.domain} and its _mcp-tc name.`);
  if (r.found) {
    out.print(`Found ${r.tokens.length} token${r.tokens.length === 1 ? '' : 's'}. It must match the one mcp.tc shows you for this domain.`);
  } else if (!r.complete) {
    out.print('No token found, but some lookups failed. Check your connection and try again.');
  } else {
    out.print(`No ${PREFIX} record found at ${r.domain} or _mcp-tc.${r.domain}.`);
  }
  if (r.domain.startsWith('www.')) {
    out.print(out.style.dim('mcp.tc usually asks for the record on the domain without "www.": use the domain mcp.tc shows you.'));
  }
  out.print(out.style.dim(`Note: ${r.note}`));
}
