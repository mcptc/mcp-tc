// mcp-tc open: open a listing page in the browser with the system's opener (never through a shell).
// On Windows the opener is started by its full path: Windows looks for a bare program name in the current folder
// before PATH, so a rundll32.exe planted in a cloned repository would otherwise run.
import path from 'node:path';
import { LANGS, clientOptions, listingExists, requireSlug } from '../lib/directory.js';
import { UsageError } from '../lib/errors.js';

/** @type {import('../lib/args.js').CommandMeta} */
export const meta = {
  name: 'open',
  summary: 'Open a listing page in your browser',
  usage: 'open <slug> [--lang en|it|fr|de|es] [--print]',
  description:
    'Opens https://mcp.tc/i/<slug>, or the page in another language with --lang. When there is no browser to open (no display, or --json), it prints the link instead.',
  args: [{ name: 'slug', required: true }],
  options: {
    lang: { type: 'string', valueName: 'lang', choices: [...LANGS], description: 'Page language: en (default), it, fr, de or es' },
    print: { type: 'boolean', description: 'Only print the link, do not open a browser' },
  },
  examples: ['mcp-tc open notion', 'mcp-tc open github --lang de', 'mcp-tc open deepwiki --print'],
  exits: [
    [0, 'opened, or the link printed'],
    [3, 'no listing with that slug, or it was removed'],
    [4, 'mcp.tc kept limiting requests (HTTP 429) after the retries'],
  ],
};

/**
 * The command that opens a URL on this system, or null when there is nothing to open it with.
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string|undefined>} env
 * @returns {{command: string, args: string[]}|null}
 */
export function openerFor(platform, env) {
  if (platform === 'darwin') return { command: 'open', args: [] };
  // rundll32 hands the URL to the default browser without cmd.exe, so nothing in it is parsed as a command
  if (platform === 'win32') return { command: path.win32.join(windowsDir(env), 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler'] };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { command: 'xdg-open', args: [] };
}

/**
 * The Windows folder (%SystemRoot%), when the environment gives an absolute local path for it.
 * @param {Record<string, string|undefined>} env
 */
export function windowsDir(env) {
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR']) {
    const v = env[key];
    if (v && /^[A-Za-z]:\\/.test(v)) return v;
  }
  return 'C:\\Windows';
}

/**
 * @param {any} ctx
 */
export async function run(ctx) {
  const { slug, lang: linkLang } = requireSlug(ctx.positionals[0], ctx.base);
  const lang = ctx.args.lang || linkLang || 'en';
  if (!LANGS.includes(lang)) throw new UsageError(`--lang must be one of: ${LANGS.join(', ')}.`);
  await listingExists(slug, clientOptions(ctx));
  const url = `${ctx.base}${lang === 'en' ? '' : `/${lang}`}/i/${slug}`;
  if (ctx.json || ctx.args.print) return { url, opened: false };

  const opener = openerFor(ctx.platform, ctx.env);
  if (!opener) return { url, opened: false, reason: 'no_display' };
  const started = await new Promise((resolve) => {
    let child;
    try {
      /** @type {Record<string, any>} */
      const options = { detached: true, stdio: 'ignore', shell: false };
      // and the programs it starts don't look in the current folder either
      if (ctx.platform === 'win32') options.env = { ...ctx.env, NoDefaultCurrentDirectoryInExePath: '1' };
      child = ctx.spawn(opener.command, [...opener.args, url], options);
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
  return started ? { url, opened: true } : { url, opened: false, reason: 'no_opener' };
}

/**
 * @param {{url: string, opened: boolean, reason?: string}} r
 * @param {import('../lib/output.js').Output} out
 */
export function render(r, out) {
  if (r.opened) {
    out.print(`Opened ${r.url}`);
    return;
  }
  if (r.reason === 'no_display') out.info('No display found to open a browser on.');
  if (r.reason === 'no_opener') out.info('Could not start a browser.');
  out.print(r.url);
}
