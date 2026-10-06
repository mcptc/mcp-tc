#!/usr/bin/env node
// `npm test`: runs every test/*.test.js file with node --test. The file list is built here because npm runs scripts
// through cmd.exe on Windows, which leaves a glob like test/*.test.js unexpanded, and Node.js 20 does not expand it
// either. Options after `npm test --` go to node --test, for example: npm test -- --test-name-pattern=doctor
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The test files, relative to the package folder, sorted.
 * @param {string} [root]
 */
export function testFiles(root = ROOT) {
  return readdirSync(join(root, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => join('test', f));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...testFiles()], { cwd: ROOT, stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}
