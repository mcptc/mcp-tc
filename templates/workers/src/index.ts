// The worker: one Streamable HTTP endpoint, /mcp. Cloudflare Workers call the default export's fetch() for every
// request; Deno and Bun serve the same { fetch } shape. No sessions: every request gets a fresh server from
// buildServer(), so nothing needs to be shared between requests or instances.
{{#bearer}}
import { createMcpHandler, oauthMetadataResponse } from '@modelcontextprotocol/server';

import { authFor, type AuthSettings } from './auth.js';
import { checkHostAndOrigin, isLocalRequest, preflight, withCors, type GuardSettings } from './guard.js';
{{/bearer}}
{{^bearer}}
import { createMcpHandler } from '@modelcontextprotocol/server';

import { checkHostAndOrigin, preflight, withCors, type GuardSettings } from './guard.js';
{{/bearer}}
import { buildServer } from './server.js';

/** Settings from wrangler.jsonc ("vars"){{#bearer}}, secrets (`wrangler secret put`) and, for `npm run dev` only, .dev.vars{{/bearer}}. */
export type Env = GuardSettings{{#bearer}} & AuthSettings{{/bearer}};

// The MCP handler: answers 2026-07-28 requests and, by default, older clients too (legacy: 'stateless').
const handler = createMcpHandler(buildServer);

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        // 1. Host and Origin, before anything else (src/guard.ts).
        const refused = checkHostAndOrigin(request, env);
        if (refused) return refused;

        // 2. Browsers: a web page on an allowed origin may call the worker. Its preflight is answered here, before
        //    sign-in, and every answer below carries the CORS headers it needs.
        if (request.method === 'OPTIONS') return preflight(request);
        return withCors(request, await route(request, env));
    }
};

async function route(request: Request, env: Env): Promise<Response> {
{{#bearer}}
    // 3. Sign-in metadata (RFC 9728) at /.well-known/oauth-protected-resource/mcp, plus a mirror of your
    //    authorization server's metadata at /.well-known/oauth-authorization-server. See src/auth.ts.
    const auth = authFor(env, isLocalRequest(request));
    if (auth instanceof Response) return auth;
    const metadata = oauthMetadataResponse(request, auth.metadata);
    if (metadata) return metadata;

{{/bearer}}
    // One endpoint. Everything else is 404.
    if (new URL(request.url).pathname !== '/mcp') {
        return new Response('Not found. The MCP endpoint is /mcp.\n', { status: 404 });
    }
{{#bearer}}

    // 4. A valid bearer token, or the 401/403 challenge that starts the client's sign-in.
    const authInfo = await auth.gate(request);
    if (authInfo instanceof Response) return authInfo;
    // Tools read the verified caller as ctx.http?.authInfo.
    return handler.fetch(request, { authInfo });
{{/bearer}}
{{^bearer}}

    return handler.fetch(request);
{{/bearer}}
}
