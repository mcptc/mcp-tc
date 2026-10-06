// Sign-in settings and the token check. This server only checks tokens: your identity provider (the authorization
// server) signs users in and issues them. Before you go live, fill in the two places marked "Fill in".
import type { AuthInfo, AuthMetadataOptions, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

import { DEV_ACCESS_TOKEN, DEV_TOKEN_ACTIVE, MCP_SERVER_URL, OAUTH_ISSUER } from './config.js';

/** Scopes every token needs. Use the scope names your authorization server issues for this server. */
export const REQUIRED_SCOPES = ['mcp'];

/**
 * What /.well-known/oauth-protected-resource/mcp publishes (RFC 9728), plus the authorization server's own
 * metadata (RFC 8414) that the router mirrors.
 */
export const authMetadata: AuthMetadataOptions = {
    // Fill in: copy these values from your provider's /.well-known/oauth-authorization-server (or
    // /.well-known/openid-configuration) document. The two endpoints below are placeholders.
    oauthMetadata: {
        issuer: OAUTH_ISSUER,
        authorization_endpoint: new URL('/authorize', OAUTH_ISSUER).href,
        token_endpoint: new URL('/token', OAUTH_ISSUER).href,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256']
    },
    resourceServerUrl: MCP_SERVER_URL,
    scopesSupported: REQUIRED_SCOPES,
    resourceName: '{{title}}'
};

/** Checks each bearer token. requireBearerAuth (src/index.ts) calls it on every request to /mcp. */
export const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
        // Development shortcut. It works only while the server listens on localhost, takes localhost Host headers
        // only and MCP_SERVER_URL is on this machine (DEV_TOKEN_ACTIVE in src/config.ts). Anywhere else the server
        // refuses to start while DEV_ACCESS_TOKEN is set, so a deployed server never accepts it.
        if (DEV_TOKEN_ACTIVE && sameText(token, DEV_ACCESS_TOKEN)) {
            return {
                token,
                clientId: 'dev',
                scopes: REQUIRED_SCOPES,
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                resource: MCP_SERVER_URL
            };
        }

        // Fill in: verify real tokens here, then return their AuthInfo. Two common ways:
        //   - A JWT: check its signature with your provider's public keys (JWKS), then its "iss" and "exp" claims.
        //     The jose package does this: jwtVerify(token, createRemoteJWKSet(jwksUrl), { issuer }).
        //   - An opaque token: ask your provider's introspection endpoint (RFC 7662).
        // AuthInfo needs:
        //   token     the token itself
        //   clientId  the "client_id" or "sub" claim
        //   scopes    the token's scopes, as a list
        //   expiresAt the "exp" claim, in seconds. Required: a token without it is refused.
        //   resource  the "aud" value that names this server, as a URL. requireBearerAuth compares it with
        //             MCP_SERVER_URL (expectedResource) and refuses a token issued for any other server.
        // Throw OAuthError(InvalidToken) for a token you don't accept: the client gets 401 and can sign in again.
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'This server does not recognize the token.');
    }
};

/** Compares two strings in time that does not depend on where they differ. */
function sameText(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
