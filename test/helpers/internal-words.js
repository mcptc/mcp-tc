// The check that keeps the mcp.tc site's own setup (its hosts, paths, file, table and setting names) out of this
// public repository. The list of those names is itself private, so it is not in the repository: put one regular
// expression per line in .internal-words at the package root (git ignores it; lines starting with # are comments).
// Without that file, the tests that use it are skipped with a note.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const WORDS_FILE = '.internal-words';
/** Never part of the repository: skipped when git can't list the files. */
const SKIP = new Set(['node_modules', '.git', '.claude', 'coverage', WORDS_FILE, '.test-ledger.json', '.npmrc']);

/**
 * The patterns from .internal-words, or null when the file is not there.
 * @param {string} root package folder
 * @returns {RegExp[]|null}
 */
export function internalWords(root) {
  const file = join(root, WORDS_FILE);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'));
}

/**
 * Every file of the repository as it would be committed: tracked files plus new ones git doesn't ignore, relative to
 * the root with forward slashes. Without git, every file outside node_modules, .git and the local-only files.
 * @param {string} root
 * @returns {string[]}
 */
export function repoFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out
      .split('\0')
      .filter(Boolean)
      .filter((f) => f !== WORDS_FILE && existsSync(join(root, f)))
      .sort();
  } catch {
    return walk(root, root).sort();
  }
}

/**
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
function walk(root, dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.endsWith('.tgz')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(root, p));
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/**
 * file:line for every line of a text that matches one of the patterns. Binary files (a NUL byte) give nothing.
 * @param {string} text
 * @param {RegExp[]} words
 * @param {string} where
 */
export function internalHits(text, words, where) {
  if (text.slice(0, 8192).includes('\0')) return [];
  /** @type {string[]} */
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (words.some((re) => re.test(line))) hits.push(`${where}:${i + 1}`);
  });
  return hits;
}
