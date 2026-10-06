// The MCP server itself: what it is called, what it tells clients, and its tools.
//
// buildServer() runs for every connection{{#remote}} (with Streamable HTTP, for every request){{/remote}}. Keep it cheap and
// keep state that must outlive a request (a database pool, a cache) outside of it.
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { ICON } from './icon.js';

/** Keep in step with "version" in package.json. Clients and directories show it. */
export const VERSION = '0.1.0';

/** A few HTTP status codes and what they mean. Replace this with your own data or API calls. */
const STATUS_CODES: Record<number, { name: string; meaning: string }> = {
    200: { name: 'OK', meaning: 'The request succeeded.' },
    201: { name: 'Created', meaning: 'The request succeeded and created a new resource.' },
    204: { name: 'No Content', meaning: 'The request succeeded and there is no body to send back.' },
    301: { name: 'Moved Permanently', meaning: 'The resource has a new permanent URL, given in the Location header.' },
    302: { name: 'Found', meaning: 'The resource is temporarily at another URL, given in the Location header.' },
    304: { name: 'Not Modified', meaning: 'The cached copy the client already has is still valid.' },
    400: { name: 'Bad Request', meaning: 'The server cannot process the request because it is malformed.' },
    401: { name: 'Unauthorized', meaning: 'The request needs valid credentials, usually a sign-in or a token.' },
    403: { name: 'Forbidden', meaning: 'The server understood the request but refuses to allow it.' },
    404: { name: 'Not Found', meaning: 'The server cannot find the requested resource.' },
    405: { name: 'Method Not Allowed', meaning: 'The resource does not support this HTTP method.' },
    409: { name: 'Conflict', meaning: 'The request conflicts with the current state of the resource.' },
    410: { name: 'Gone', meaning: 'The resource was removed on purpose and will not come back.' },
    413: { name: 'Content Too Large', meaning: 'The request body is larger than the server accepts.' },
    422: { name: 'Unprocessable Content', meaning: 'The request is well formed but its content is not valid.' },
    429: { name: 'Too Many Requests', meaning: 'The client sent too many requests; wait for the time in Retry-After.' },
    500: { name: 'Internal Server Error', meaning: 'The server hit an unexpected error.' },
    502: { name: 'Bad Gateway', meaning: 'A server in front of the application got an invalid answer from it.' },
    503: { name: 'Service Unavailable', meaning: 'The server is overloaded or down for maintenance; try again later.' },
    504: { name: 'Gateway Timeout', meaning: 'A server in front of the application did not get an answer in time.' }
};

export function buildServer(): McpServer {
    const server = new McpServer(
        {
            // serverInfo: the first thing a client (and a directory such as mcp.tc) reads in the handshake.
            name: '{{serverName}}',
            title: '{{title}}',
            version: VERSION,
            description: 'Looks up the name and meaning of HTTP status codes. Replace this with one sentence about your server.',
            // websiteUrl: 'https://example.com',
            icons: [ICON]
        },
        {
            // Read by the model that uses your tools: say when and how to use them.
            instructions: 'Use http_status when someone asks what an HTTP status code means.'
        }
    );

    server.registerTool(
        'http_status',
        {
            title: 'Look up an HTTP status code',
            // Write the description for the model that decides when to call the tool: what it does, what it needs, what it returns.
            description:
                'Look up the standard name and meaning of an HTTP status code, such as 404 or 503. ' +
                'Returns the name and a one-sentence explanation, or an error for a code it does not know.',
            inputSchema: z.object({
                code: z.number().int().min(100).max(599).describe('The HTTP status code, a whole number from 100 to 599')
            }),
            outputSchema: z.object({
                code: z.number().int(),
                name: z.string(),
                meaning: z.string()
            }),
            // Hints for clients. They are not a security boundary, so keep them true to what the tool does.
            annotations: {
                readOnlyHint: true, // it only reads: nothing is created, changed or deleted
                destructiveHint: false, // it never deletes or overwrites anything
                idempotentHint: true, // the same arguments always give the same answer
                openWorldHint: false // it uses its own table, not the internet or another outside system
            }
        },
        async ({ code }) => {
            const entry = STATUS_CODES[code];
            if (!entry) {
                // isError: the model sees the message and can react to it.
                return { content: [{ type: 'text', text: `No entry for status code ${code}.` }], isError: true };
            }
            const result = { code, name: entry.name, meaning: entry.meaning };
            return {
                content: [{ type: 'text', text: `${code} ${entry.name}: ${entry.meaning}` }],
                structuredContent: result
            };
        }
    );

    return server;
}
