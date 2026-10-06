// Version and User-Agent, read once from package.json so a release changes one file.
import { readFileSync } from 'node:fs';

/** @type {{version: string, name: string}} */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** The package version, like "0.1.0". */
export const VERSION = pkg.version;

/** Repository link sent in the User-Agent so mcp.tc and server operators can see who is calling. */
export const REPO_URL = 'https://github.com/mcptc/mcp-tc';

/** Sent on every request. Never a browser User-Agent. */
export const USER_AGENT = `mcp-tc-cli/${VERSION} (+${REPO_URL})`;
