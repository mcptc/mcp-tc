// Host and Origin checks, written out by hand: a bare fetch handler has no app factory to add them, and
// createMcpHandler checks neither header.
//
// Host: every request must name one of your hostnames. This blocks DNS rebinding, where a web page points a domain
// it controls at your server's address.
// Origin: browsers add it to cross-site requests. A request from a web page whose hostname is not on your list gets
// 403, as the MCP specification requires. Requests without an Origin header (Claude Code, curl and most other
// clients) pass, so this check does not replace sign-in.
// CORS: a web page whose hostname is on the list may call the worker from a browser and read the answers.

/** Always allowed, so `npm run dev` works without settings. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export interface GuardSettings {
    /** Hostnames of this worker, comma separated (wrangler.jsonc "vars"). */
    ALLOWED_HOSTS?: string;
    /**
     * Hostnames of web pages that may call it from a browser, comma separated: their requests get CORS headers.
     * Empty: the same as ALLOWED_HOSTS.
     */
    ALLOWED_ORIGINS?: string;
}

/** A 403 response when the request must be refused, or undefined when it may go on. */
export function checkHostAndOrigin(request: Request, settings: GuardSettings): Response | undefined {
    const hosts = [...LOCAL_HOSTS, ...list(settings.ALLOWED_HOSTS)];
    const host = hostnameOf(request.headers.get('host') ?? new URL(request.url).host);
    if (!host || !hosts.includes(host)) {
        return forbidden(`Host not allowed: ${host ?? 'missing'}. Add it to ALLOWED_HOSTS in wrangler.jsonc.`);
    }

    const origin = request.headers.get('origin');
    if (origin === null) return undefined;
    const origins = list(settings.ALLOWED_ORIGINS);
    const allowed = [...LOCAL_HOSTS, ...(origins.length > 0 ? origins : list(settings.ALLOWED_HOSTS))];
    const originHost = originHostname(origin);
    if (!originHost || !allowed.includes(originHost)) {
        return forbidden(`Origin not allowed: ${originHost ?? 'invalid'}. Add its hostname to ALLOWED_ORIGINS in wrangler.jsonc.`);
    }
    return undefined;
}

/**
 * True when the request was sent to localhost: `npm run dev` on your machine. On Cloudflare a request always names
 * the worker's own hostname, so this is never true there.
 */
export function isLocalRequest(request: Request): boolean {
    const host = hostnameOf(request.headers.get('host') ?? '');
    const urlHost = hostnameOf(new URL(request.url).host);
    return host !== null && urlHost !== null && LOCAL_HOSTS.includes(host) && LOCAL_HOSTS.includes(urlHost);
}

const ALLOW_HEADERS = 'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID';
const EXPOSE_HEADERS = 'WWW-Authenticate, MCP-Protocol-Version';

/**
 * The answer to a browser's preflight (OPTIONS). Call it after checkHostAndOrigin(), which has already refused
 * every origin that is not on the list.
 */
export function preflight(request: Request): Response {
    const headers = new Headers(corsHeaders(request));
    if (headers.has('Access-Control-Allow-Origin')) {
        const asked = request.headers.get('access-control-request-headers');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        headers.set('Access-Control-Allow-Headers', asked && asked.length <= 1024 && /^[\w-]+(\s*,\s*[\w-]+)*$/.test(asked) ? asked : ALLOW_HEADERS);
        headers.set('Access-Control-Max-Age', '86400');
    }
    return new Response(null, { status: 204, headers });
}

/** The response with the CORS headers for the request's Origin added (unchanged when there is no Origin). */
export function withCors(request: Request, response: Response): Response {
    const cors = corsHeaders(request);
    if (Object.keys(cors).length === 0) return response;
    const out = new Response(response.body, response);
    for (const [name, value] of Object.entries(cors)) {
        if (name === 'Vary') out.headers.append('Vary', value);
        else out.headers.set(name, value);
    }
    return out;
}

/** CORS headers for a request that passed checkHostAndOrigin() with an Origin header. */
function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get('origin');
    if (!origin || !originHostname(origin)) return {};
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': EXPOSE_HEADERS, Vary: 'Origin' };
}

/** The hostname in a Host header ("example.com:8787" gives "example.com"), lowercase, or null. */
function hostnameOf(value: string): string | null {
    if (!value || /[\s/@?#\\]/.test(value)) return null;
    try {
        return new URL(`http://${value}`).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** The hostname of an Origin header, or null for "null" and anything that is not an http(s) origin. */
function originHostname(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : null;
    } catch {
        return null;
    }
}

function list(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

/** The same JSON-RPC error body the SDK's own Host and Origin checks send. */
function forbidden(message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
    });
}
