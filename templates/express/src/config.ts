// Settings, read once from environment variables. The defaults are for running on your own machine.

/** The port to listen on. */
export const PORT = Number(process.env.PORT ?? 3000);

/**
 * The address to listen on. 127.0.0.1 accepts connections from this machine only. In a container, or anywhere the
 * server must be reachable from other machines, use 0.0.0.0 and set ALLOWED_HOSTS.
 */
export const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * Hostnames clients use to reach the server, comma separated, for example "mcp.example.com". A request whose Host
 * header names another host gets 403: this blocks DNS rebinding. Empty: localhost only.
 */
export const ALLOWED_HOSTS = list(process.env.ALLOWED_HOSTS);

/**
 * Hostnames of web pages that may call the server from a browser, comma separated. Their requests get CORS headers,
 * so the page can read the answers; a page on any other site gets 403. Requests without an Origin header (Claude
 * Code, curl and most other clients) always pass. Empty: the same hostnames as ALLOWED_HOSTS (localhost when that is
 * empty too).
 */
export const ALLOWED_ORIGINS = list(process.env.ALLOWED_ORIGINS);

/** The localhost names, as Host and Origin checks compare them. */
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** True when the server listens on this machine only. */
export const LISTENS_LOCALLY = [...LOCAL_HOSTS, '::1'].includes(HOST);

/** Hostnames of the web pages whose requests pass the Origin check, and so get CORS headers. */
export const BROWSER_ORIGINS =
    ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : ALLOWED_HOSTS.length > 0 ? ALLOWED_HOSTS : LISTENS_LOCALLY ? LOCAL_HOSTS : [];
{{#bearer}}

/**
 * The public URL of the MCP endpoint, for example "https://mcp.example.com/mcp". Access tokens must be issued for
 * exactly this URL (their audience), and the sign-in metadata names it. Required once the server is reachable from
 * other machines (HOST is not localhost, or ALLOWED_HOSTS is set): src/index.ts refuses to start without it.
 */
export const MCP_SERVER_URL_SET = (process.env.MCP_SERVER_URL ?? '').trim() !== '';
export const MCP_SERVER_URL = new URL(MCP_SERVER_URL_SET ? (process.env.MCP_SERVER_URL as string).trim() : `http://127.0.0.1:${PORT}/mcp`);

/** Your authorization server (identity provider), as its issuer URL. */
export const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? 'https://auth.example.com';

/**
 * Development only: a token that the server accepts, so you can try it with curl before you connect a real identity
 * provider. Make one with: node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
 */
export const DEV_ACCESS_TOKEN = process.env.DEV_ACCESS_TOKEN ?? '';

/**
 * The development token works only while nothing but this machine can reach the server: it listens on localhost,
 * takes localhost Host headers only (ALLOWED_HOSTS is empty) and MCP_SERVER_URL is on this machine. Set anywhere
 * else, src/index.ts refuses to start, so a forgotten DEV_ACCESS_TOKEN can't open a deployed server.
 */
export const DEV_TOKEN_ACTIVE =
    DEV_ACCESS_TOKEN !== '' && LISTENS_LOCALLY && ALLOWED_HOSTS.length === 0 && LOCAL_HOSTS.includes(MCP_SERVER_URL.hostname);
{{/bearer}}

function list(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}
