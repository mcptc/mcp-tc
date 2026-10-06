// The HTTP side: one Streamable HTTP endpoint, /mcp, served by Express. No sessions: every request gets a fresh
// server from buildServer(), so you can run as many copies as you like behind any load balancer.
import { readFile } from 'node:fs/promises';

{{#bearer}}
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
{{/bearer}}
{{^bearer}}
import { createMcpExpressApp } from '@modelcontextprotocol/express';
{{/bearer}}
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { NextFunction, Request, Response } from 'express';

{{#bearer}}
import { authMetadata, REQUIRED_SCOPES, verifier } from './auth.js';
import {
    ALLOWED_HOSTS,
    ALLOWED_ORIGINS,
    BROWSER_ORIGINS,
    DEV_ACCESS_TOKEN,
    DEV_TOKEN_ACTIVE,
    HOST,
    LISTENS_LOCALLY,
    MCP_SERVER_URL,
    MCP_SERVER_URL_SET,
    OAUTH_ISSUER,
    PORT
} from './config.js';
{{/bearer}}
{{^bearer}}
import { ALLOWED_HOSTS, ALLOWED_ORIGINS, BROWSER_ORIGINS, HOST, LISTENS_LOCALLY, PORT } from './config.js';
{{/bearer}}
import { buildServer } from './server.js';

if (!LISTENS_LOCALLY && ALLOWED_HOSTS.length === 0) {
    // Without a host list, a server reachable from other machines would answer any Host header (DNS rebinding).
    console.error(`HOST is ${HOST}, so set ALLOWED_HOSTS to the hostnames clients use, for example ALLOWED_HOSTS=mcp.example.com`);
    process.exit(1);
}
{{#bearer}}
if ((!LISTENS_LOCALLY || ALLOWED_HOSTS.length > 0) && !MCP_SERVER_URL_SET) {
    // Tokens are issued for the public URL, and the sign-in metadata names it: the localhost default is wrong here.
    console.error('The server is reachable from other machines, so set MCP_SERVER_URL to its public URL, for example MCP_SERVER_URL=https://mcp.example.com/mcp');
    process.exit(1);
}
if (DEV_ACCESS_TOKEN && !DEV_TOKEN_ACTIVE) {
    // The development token is a password that never expires: it must not open a server that others can reach.
    console.error(
        'DEV_ACCESS_TOKEN is set, but this server is reachable from other machines or MCP_SERVER_URL is not on this machine. ' +
            'Remove DEV_ACCESS_TOKEN: it is for trying the server on localhost only.'
    );
    process.exit(1);
}
{{/bearer}}

// The MCP handler: answers 2026-07-28 requests and, by default, older clients too (legacy: 'stateless').
const handler = createMcpHandler(buildServer);
const node = toNodeHandler(handler);

// createMcpExpressApp adds Host and Origin validation in front of every route, then express.json().
// With no lists it allows localhost only; with ALLOWED_HOSTS it allows exactly those hostnames.
const origins = ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : ALLOWED_HOSTS;
const app = createMcpExpressApp({
    host: HOST,
    ...(ALLOWED_HOSTS.length > 0 ? { allowedHosts: ALLOWED_HOSTS } : {}),
    ...(origins.length > 0 ? { allowedOrigins: origins } : {})
});

// Browsers. A web page on one of the allowed origins may call /mcp and read the answers: the Origin check above has
// already refused every other origin with 403, so this only adds the CORS headers a browser needs, and answers the
// preflight (OPTIONS) before any sign-in check.
const ALLOW_HEADERS = 'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID';
const EXPOSE_HEADERS = 'WWW-Authenticate, MCP-Protocol-Version';
app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && BROWSER_ORIGINS.includes(originHostname(origin))) {
        res.vary('Origin');
        res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': EXPOSE_HEADERS });
        if (req.method === 'OPTIONS') {
            const asked = req.headers['access-control-request-headers'];
            res.set({
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': typeof asked === 'string' && /^[\w-]+(\s*,\s*[\w-]+)*$/.test(asked) && asked.length <= 1024 ? asked : ALLOW_HEADERS,
                'Access-Control-Max-Age': '86400'
            });
        }
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});

// The server card describes this server for directories and registries. Write it with
//   npx mcp-tc card --url <your public /mcp URL> --out .well-known/mcp/server-card.json
// Until that file exists, these two addresses answer 404. The card is public, so any web page may read it.
const CARD_FILE = new URL('../.well-known/mcp/server-card.json', import.meta.url);
app.get(['/mcp/server-card', '/.well-known/mcp/server-card.json'], async (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
        res.type('application/json').send(await readFile(CARD_FILE, 'utf8'));
    } catch {
        res.status(404).json({ error: 'No server card yet. See "Get listed on mcp.tc" in README.md.' });
    }
});
{{#bearer}}

// Sign-in. This server is an OAuth resource server: it checks access tokens that your authorization server issued
// and never issues tokens itself. There is no login page here; see src/auth.ts for what to fill in.
//
// 1. Publish the OAuth 2.0 Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource/mcp.
//    It names your authorization server, so a client knows where to send the user to sign in. The router also
//    mirrors your authorization server's metadata at /.well-known/oauth-authorization-server for older clients.
app.use(mcpAuthMetadataRouter(authMetadata));

// 2. Require a valid bearer token on /mcp. A request without one gets 401 with
//    WWW-Authenticate: Bearer ... resource_metadata="<the address above>", which is how a client starts its sign-in.
//    A valid token without the required scopes gets 403 insufficient_scope.
const requireToken = requireBearerAuth({
    verifier,
    requiredScopes: REQUIRED_SCOPES,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_SERVER_URL),
    // The audience check (RFC 8707): accept only tokens issued for this server's URL, so a token meant for another
    // service can't be replayed here. It needs @modelcontextprotocol/express 2.0.2 or later: 2.0.1 ignores this option.
    expectedResource: MCP_SERVER_URL
});

app.all('/mcp', requireToken, (req, res) => void node(req, res, req.body));
{{/bearer}}
{{^bearer}}

// express.json() already read the body, so pass it on as the third argument.
app.all('/mcp', (req, res) => void node(req, res, req.body));
{{/bearer}}

const http = app.listen(PORT, HOST, () => {
    console.error(`{{serverName}} MCP server: http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}/mcp`);
{{#bearer}}
    if (OAUTH_ISSUER === 'https://auth.example.com') {
        console.error('OAUTH_ISSUER is not set: clients cannot sign in until it names your authorization server.');
    }
    if (DEV_TOKEN_ACTIVE) console.error('DEV_ACCESS_TOKEN is set: the server accepts it as a token. Development only.');
{{/bearer}}
});

// Stop cleanly: end in-flight requests, then close the listener.
function stop(): void {
    void handler.close().finally(() => http.close());
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** The hostname of an Origin header, lowercase, or '' for "null" and anything that is not an http(s) origin. */
function originHostname(value: string): string {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : '';
    } catch {
        return '';
    }
}
