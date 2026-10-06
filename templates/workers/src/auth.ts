// Sign-in settings and the token check. This worker only checks tokens: your identity provider (the authorization
// server) signs users in and issues them. Before you go live, fill in the two places marked "Fill in".
import type { AuthInfo, AuthMetadataOptions, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { getOAuthProtectedResourceMetadataUrl, OAuthError, OAuthErrorCode, requireBearerAuth } from '@modelcontextprotocol/server';

/** Scopes every token needs. Use the scope names your authorization server issues for this server. */
export const REQUIRED_SCOPES = ['mcp'];

export interface AuthSettings {
    /**
     * The public URL of the MCP endpoint, for example "https://mcp.example.com/mcp". Required on Cloudflare: until it
     * is set, every request there gets 500. `npm run dev` uses http://127.0.0.1:8787/mcp when it is empty.
     */
    MCP_SERVER_URL?: string;
    /** Your authorization server (identity provider), as its issuer URL. */
    OAUTH_ISSUER?: string;
    /**
     * Development only, in .dev.vars together with DEV_MODE=1: a token accepted for requests to localhost. Never set
     * it on Cloudflare (no `wrangler secret put`, no `wrangler secret bulk .dev.vars`).
     */
    DEV_ACCESS_TOKEN?: string;
    /** Development only, in .dev.vars: "1" lets requests to localhost use DEV_ACCESS_TOKEN. */
    DEV_MODE?: string;
}

export interface Auth {
    /** What /.well-known/oauth-protected-resource/mcp publishes (RFC 9728), for oauthMetadataResponse(). */
    metadata: AuthMetadataOptions;
    /** Resolves to the verified AuthInfo, or to the 401/403 response to send back. */
    gate: (request: Request) => Promise<AuthInfo | Response>;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const cache = new Map<string, Auth>();

/**
 * The sign-in pieces for the worker's settings, built once and reused while the settings stay the same. `local` is
 * true for a request to localhost (`npm run dev`), which a deployed worker never gets. Returns a 500 response when
 * the settings can't work for this request.
 */
export function authFor(settings: AuthSettings, local: boolean): Auth | Response {
    const configured = (settings.MCP_SERVER_URL ?? '').trim();
    let serverUrl: URL;
    try {
        serverUrl = new URL(configured || 'http://127.0.0.1:8787/mcp');
    } catch {
        return misconfigured('MCP_SERVER_URL in wrangler.jsonc is not a valid URL.');
    }
    // Tokens are issued for the public URL: a deployed worker can't work with the localhost default.
    if (!local && LOCAL_HOSTS.includes(serverUrl.hostname)) {
        return misconfigured("Set MCP_SERVER_URL in wrangler.jsonc to this worker's public /mcp URL, then deploy again.");
    }
    const issuer = settings.OAUTH_ISSUER || 'https://auth.example.com';
    // The development token needs DEV_MODE=1 and a request to localhost, so a deployed worker never accepts it, even
    // if DEV_ACCESS_TOKEN reached Cloudflare by mistake.
    const devToken = local && settings.DEV_MODE === '1' && settings.DEV_ACCESS_TOKEN ? settings.DEV_ACCESS_TOKEN : '';

    const key = JSON.stringify([serverUrl.href, issuer, devToken]);
    const known = cache.get(key);
    if (known) return known;

    const verifier: OAuthTokenVerifier = {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
            // Development shortcut: only for requests to localhost with DEV_MODE=1 (see devToken above).
            if (devToken && sameText(token, devToken)) {
                return { token, clientId: 'dev', scopes: REQUIRED_SCOPES, expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: serverUrl };
            }

            // Fill in: verify real tokens here, then return their AuthInfo. Two common ways:
            //   - A JWT: check its signature with your provider's public keys (JWKS), then its "iss" and "exp" claims.
            //     The jose package runs on Workers: jwtVerify(token, createRemoteJWKSet(jwksUrl), { issuer }).
            //   - An opaque token: ask your provider's introspection endpoint (RFC 7662).
            // AuthInfo needs:
            //   token     the token itself
            //   clientId  the "client_id" or "sub" claim
            //   scopes    the token's scopes, as a list
            //   expiresAt the "exp" claim, in seconds. Required: a token without it is refused.
            //   resource  the "aud" value that names this server, as a URL. The gate compares it with
            //             MCP_SERVER_URL (expectedResource) and refuses a token issued for any other server.
            // Throw OAuthError(InvalidToken) for a token you don't accept: the client gets 401 and can sign in again.
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'This server does not recognize the token.');
        }
    };

    const auth: Auth = {
        metadata: {
            // Fill in: copy these values from your provider's /.well-known/oauth-authorization-server (or
            // /.well-known/openid-configuration) document. The two endpoints below are placeholders.
            oauthMetadata: {
                issuer,
                authorization_endpoint: new URL('/authorize', issuer).href,
                token_endpoint: new URL('/token', issuer).href,
                response_types_supported: ['code'],
                code_challenge_methods_supported: ['S256']
            },
            resourceServerUrl: serverUrl,
            scopesSupported: REQUIRED_SCOPES,
            resourceName: '{{title}}'
        },
        // A request without a valid token gets 401 with WWW-Authenticate: Bearer ... resource_metadata="...",
        // which is how a client finds your authorization server and starts its sign-in.
        gate: requireBearerAuth({
            verifier,
            requiredScopes: REQUIRED_SCOPES,
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(serverUrl),
            // The audience check (RFC 8707): accept only tokens issued for this server's URL.
            expectedResource: serverUrl
        })
    };
    if (cache.size >= 4) cache.clear();
    cache.set(key, auth);
    return auth;
}

/** A 500 answer that says which setting to fix. */
function misconfigured(message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
    });
}

/** Compares two strings in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
