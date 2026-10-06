# {{title}}

<!-- Badge: once {{title}} is listed on mcp.tc, run `npx mcp-tc badge <slug>` and paste the Markdown line it prints here. -->

{{title}} is an MCP server built with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) v2.
{{#express}}
It runs on Node.js with Express and answers Streamable HTTP on one endpoint, `/mcp`.
{{/express}}
{{#workers}}
It runs on Cloudflare Workers and answers Streamable HTTP on one endpoint, `/mcp`.
{{/workers}}
{{#stdio}}
It runs on the user's computer: an MCP client starts it as a program and talks to it over stdin and stdout.
{{/stdio}}
{{#bearer}}
Every request needs an OAuth access token.
{{/bearer}}

It comes with one example tool, `http_status`, which explains an HTTP status code. Replace it with your own tools in
`src/server.ts`.

## Requirements

{{#workers}}
- Node.js 22 or later (Wrangler 4 needs it).
- A Cloudflare account, to deploy.
{{/workers}}
{{^workers}}
- Node.js 20 or later.
{{/workers}}

## Run it

```bash
npm install
{{#bearer}}
export DEV_ACCESS_TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
{{#workers}}
printf 'DEV_MODE=1\nDEV_ACCESS_TOKEN=%s\n' "$DEV_ACCESS_TOKEN" > .dev.vars
{{/workers}}
{{/bearer}}
npm run dev
```
{{#bearer}}

On Windows, in PowerShell:

```powershell
npm install
$env:DEV_ACCESS_TOKEN = node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
{{#workers}}
"DEV_MODE=1", "DEV_ACCESS_TOKEN=$env:DEV_ACCESS_TOKEN" | Out-File -Encoding ascii .dev.vars
{{/workers}}
npm run dev
```
{{/bearer}}

{{#express}}
The server listens on {{localUrl}} and restarts when you change a file. In production, build it once and run the
compiled code: `npm run build`, then `npm start`.
{{/express}}
{{#workers}}
Wrangler serves the worker on {{localUrl}} and reloads it when you change a file.
{{/workers}}
{{#stdio}}
`npm run dev` starts the server, which then waits for a client on stdin (Ctrl+C stops it). To try the tool, build the
server and open it in the MCP Inspector, which starts it for you:

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

Click **Connect**, open **Tools**, and run `http_status` with a code such as 404.
{{/stdio}}
{{#bearer}}
{{#express}}

`DEV_ACCESS_TOKEN` lets you try the server before you connect an identity provider. The server accepts it only while
nothing but this machine can reach it: it listens on localhost (the default `HOST`), `ALLOWED_HOSTS` is empty and
`MCP_SERVER_URL` points at this machine. Anywhere else the server refuses to start while `DEV_ACCESS_TOKEN` is set.
See [Sign-in](#sign-in).
{{/express}}
{{#workers}}

`DEV_ACCESS_TOKEN` lets you try the worker before you connect an identity provider. It works only together with
`DEV_MODE=1`, and only for requests to localhost, which a deployed worker never gets. Keep both in `.dev.vars`: git
ignores that file and `wrangler deploy` doesn't upload it. Never put them on Cloudflare: don't run
`npx wrangler secret put` for them, or `npx wrangler secret bulk .dev.vars`. See [Sign-in](#sign-in).
{{/workers}}
{{/bearer}}
{{#remote}}

## Try it with curl

These examples are for a POSIX shell: macOS, Linux, or Git Bash or WSL on Windows. In a second terminal, ask for the
list of tools:

```bash
curl -s -X POST {{localUrl}} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
{{#bearer}}
  -H "Authorization: Bearer $DEV_ACCESS_TOKEN" \
{{/bearer}}
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

This request has no protocol version headers, so the server answers it the way it answers older clients: as one
Server-Sent Events message, with the JSON on the `data:` line.

```text
event: message
data: {"result":{"tools":[{"name":"http_status", ...}]},"jsonrpc":"2.0","id":1}
```

To print only the JSON, pipe the reply through `sed -n 's/^data: //p'`. Here is a tool call that way:

```bash
curl -s -X POST {{localUrl}} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
{{#bearer}}
  -H "Authorization: Bearer $DEV_ACCESS_TOKEN" \
{{/bearer}}
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"http_status","arguments":{"code":404}}}' \
  | sed -n 's/^data: //p'
```

A client that speaks the current protocol revision, 2026-07-28, repeats the method in headers and sends the version
and its capabilities in `_meta`. The server then answers with plain JSON:

```bash
curl -s -X POST {{localUrl}} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
{{#bearer}}
  -H "Authorization: Bearer $DEV_ACCESS_TOKEN" \
{{/bearer}}
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

A web page on a site you allow (`ALLOWED_ORIGINS`) gets CORS headers, so it can call the server from a browser. A
request from a page on any other site is refused. This one prints `403`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST {{localUrl}} \
  -H 'Origin: https://example.org' -H 'Content-Type: application/json' -d '{}'
```
{{#bearer}}

Without a token, the answer is `401` with the challenge that starts a client's sign-in:

```bash
curl -s -i -X POST {{localUrl}} -H 'Content-Type: application/json' -d '{}' | grep -i '^www-authenticate'
```

```text
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", scope="mcp", resource_metadata="http://127.0.0.1:{{port}}/.well-known/oauth-protected-resource/mcp"
```
{{/bearer}}

To click through the tools instead, run `npx @modelcontextprotocol/inspector` and connect it to {{localUrl}} with the
Streamable HTTP transport.
{{/remote}}
{{#express}}

## Settings

The server reads these environment variables. The defaults suit running it on your own machine.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | The port to listen on. |
| `HOST` | `127.0.0.1` | The address to listen on. Use `0.0.0.0` in a container; `ALLOWED_HOSTS` is then required. |
| `ALLOWED_HOSTS` | localhost only | Hostnames clients use, comma separated, for example `mcp.example.com`. Any other `Host` header gets 403. |
| `ALLOWED_ORIGINS` | same as `ALLOWED_HOSTS` | Hostnames of web pages that may call the server from a browser; their requests get CORS headers. Requests without an `Origin` header always pass. |
{{#bearer}}
| `MCP_SERVER_URL` | `{{localUrl}}` | The public URL of the endpoint. Tokens must be issued for this URL. Required once `HOST` is not localhost or `ALLOWED_HOSTS` is set. |
| `OAUTH_ISSUER` | `https://auth.example.com` | Your authorization server (identity provider). |
| `DEV_ACCESS_TOKEN` | none | Development only: a token the server accepts while only this machine can reach it. Set anywhere else, the server refuses to start. |
{{/bearer}}

## Put it online

- Serve it over HTTPS. Your hosting service, or a web server such as nginx in front of the app, usually handles that.
- Set `ALLOWED_HOSTS` to the hostname clients will use. If another server forwards requests to this one, make sure it
  passes the original `Host` header on.
- The server keeps no sessions, so you can run several copies behind any load balancer.
- SIGINT and SIGTERM close open requests and stop the server.
{{#bearer}}
- Set `MCP_SERVER_URL` and `OAUTH_ISSUER`, fill in `src/auth.ts` (see [Sign-in](#sign-in)), and leave
  `DEV_ACCESS_TOKEN` unset.
{{/bearer}}
{{/express}}
{{#workers}}

## Settings

Settings live in `wrangler.jsonc` under `vars`, each with a comment: `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` (web pages
on these hostnames may call the worker from a browser and get CORS headers){{#bearer}}, `MCP_SERVER_URL` and
`OAUTH_ISSUER`. Secrets don't belong in that file: locally they go in `.dev.vars` (git ignores it), and on Cloudflare
you set them with `npx wrangler secret put NAME`. `DEV_ACCESS_TOKEN` and `DEV_MODE` are for `.dev.vars` only{{/bearer}}.

## Deploy

1. Sign in to Cloudflare once: `npx wrangler login`.
2. In `wrangler.jsonc`, set `ALLOWED_HOSTS` to the worker's hostname, `{{workerName}}.<your-subdomain>.workers.dev`, or
   to your custom domain.{{#bearer}} Set `MCP_SERVER_URL` to the public endpoint,
   `https://{{workerName}}.<your-subdomain>.workers.dev/mcp` (until it is set, the deployed worker answers 500), and
   `OAUTH_ISSUER` there too, and fill in `src/auth.ts`.{{/bearer}}
3. Run `npm run deploy`.

Your MCP endpoint is then `https://{{workerName}}.<your-subdomain>.workers.dev/mcp`.
{{/workers}}
{{#bearer}}

## Sign-in

This server is an OAuth resource server. It checks an access token on every request to `/mcp` and never issues
tokens: your identity provider (the authorization server) signs users in. The SDK handles the protocol:

- `/.well-known/oauth-protected-resource/mcp` publishes the Protected Resource Metadata (RFC 9728), which names your
  authorization server.
- A request without a valid token gets `401` with a `WWW-Authenticate: Bearer` challenge that points to that
  document. A client that supports MCP sign-in follows it, sends the user to your provider, and retries with a token.
- `expectedResource` compares each token's audience with `MCP_SERVER_URL` and refuses tokens issued for anything else
  (RFC 8707).
- A token without the `mcp` scope gets `403 insufficient_scope`.

Before you go live:

1. Register this server with your provider as an API (a resource), with `MCP_SERVER_URL` as its identifier, and give
   it a scope named `mcp`, or change `REQUIRED_SCOPES` in `src/auth.ts`.
2. Set `MCP_SERVER_URL` and `OAUTH_ISSUER`, and copy the authorization and token endpoints from your provider's
   metadata into `src/auth.ts`.
3. Replace the part of `verifyAccessToken` marked "Fill in" with real checks: a JWT signature check, or a call to
   your provider's introspection endpoint.
4. Keep the development token out of production: {{#express}}leave `DEV_ACCESS_TOKEN` unset there{{/express}}{{#workers}}`DEV_ACCESS_TOKEN` and
   `DEV_MODE` stay in `.dev.vars`{{/workers}}.

Inside a tool, the verified caller is `ctx.http?.authInfo`. Never pass the client's token on to another API (the MCP
specification forbids it): get a separate token for calls your server makes.
{{/bearer}}

## Add it to a client

{{#remote}}
Claude Code:

```bash
claude mcp add --transport http {{serverName}} https://mcp.example.com/mcp
```

{{#bearer}}
If the server asks for sign-in, run `/mcp` inside Claude Code and finish the sign-in in the browser. To test with the
development token, add `--header "Authorization: Bearer $DEV_ACCESS_TOKEN"` to the command.

{{/bearer}}
In claude.ai, add the same URL as a custom connector under **Customize → Connectors**. For Cursor, VS Code and other
clients, see [how to add an MCP server](https://mcp.tc/blog/add-mcp-server-claude-code-cursor-vscode).
{{/remote}}
{{#stdio}}
Before you publish, point the client at your build. In Claude Code:

```bash
npm run build
claude mcp add {{serverName}} -- node /absolute/path/to/{{dirName}}/dist/index.js
```

Once it is on npm, anyone can run it with npx:

```bash
claude mcp add {{serverName}} -- npx -y {{name}}
```

In a JSON config such as Claude Desktop's or Cursor's:

```json
{ "mcpServers": { "{{serverName}}": { "command": "npx", "args": ["-y", "{{name}}"] } } }
```
{{/stdio}}

Once the server is listed on mcp.tc, `npx mcp-tc add <slug> --client <client>` sets it up in a client for you.
{{#stdio}}

## Publish to npm

1. Pick a license: add a LICENSE file and a `license` field to `package.json`.
2. Fill in `description`, `repository` and `homepage` in `package.json`. npm shows them, and so does mcp.tc.
3. Run `npm publish{{#scoped}} --access public{{/scoped}}`. It builds `dist/` first; only `dist/`, this README and
   `package.json` are published.
4. To list it in the [official MCP Registry](https://github.com/modelcontextprotocol/registry) as well, add
   `"mcpName": "io.github.<your-github-user>/{{serverName}}"` to `package.json`: the registry checks that it matches
   the name in `server.json`, which `npx mcp-tc card --server-json server.json` drafts.
{{/stdio}}

## Get listed on mcp.tc

[mcp.tc](https://mcp.tc) is a directory of MCP servers. Each listing has a page with what the server does, its tools,
whether it needs sign-in, and setup steps for each client.
{{#remote}}
Clients connect straight to your server's own URL.
{{/remote}}
{{#stdio}}
Clients run your server from its own package.
{{/stdio}}

{{#remote}}
1. Check that mcp.tc can read it. While it runs locally, run `npx mcp-tc check . --url {{localUrl}}` in this
   folder: it reads `package.json` and talks to the running server. Once the server is online, run
   `npx mcp-tc check https://mcp.example.com/mcp`.
{{/remote}}
{{#stdio}}
1. Check that mcp.tc can read it: run `npm run build`, then `npx mcp-tc check . --stdio` in this folder.
   `--stdio` starts the server from the `bin` entry in `package.json` (`dist/index.js`) and talks to it over stdio,
   so it runs your code on this computer. Without it, the check reads only the project files.
{{/stdio}}
   The check runs the handshake the way mcp.tc does, lists the tools, and points out missing descriptions or
   annotations. It tells you whether the server can be read, not whether it will be listed: suggestions are reviewed
   on the site, by an AI model and, when needed, by a person.
{{#bearer}}
   With sign-in on, mcp.tc can't read the tool list, and the listing says why it is empty.
{{/bearer}}
2. Fill in `description` and `websiteUrl` in `src/server.ts`. mcp.tc reads the name, title,
   description, website and icon from the handshake, and each tool's `readOnlyHint` and `destructiveHint`.
{{#remote}}
3. Once the server is online, write its server card. In the project folder:

   ```bash
   npx mcp-tc card --url https://mcp.example.com/mcp --name io.github.<your-github-user>/{{serverName}} \
     --out .well-known/mcp/server-card.json --server-json server.json
   ```

   The command reads the server's handshake and writes a server card{{#express}}, which this server then serves at
   `/mcp/server-card` and `/.well-known/mcp/server-card.json`{{/express}}{{#workers}}; to serve it from the worker,
   return that file's contents for `/mcp/server-card` in `src/index.ts`{{/workers}}, and a `server.json` for the official
   MCP Registry.
{{/remote}}
{{#stdio}}
3. With `mcpName` in `package.json` (see [Publish to npm](#publish-to-npm)),
   `npx mcp-tc card --server-json server.json` writes a `server.json` for the official MCP Registry, which mcp.tc also
   reads.
{{/stdio}}
{{#remote}}
4. Suggest it to mcp.tc: run `npx mcp-tc submit https://mcp.example.com/mcp` with your public endpoint, or paste that
   URL at https://mcp.tc/submit.
{{/remote}}
{{#stdio}}
4. Once it is on npm, suggest it to mcp.tc: run `npx mcp-tc submit npm:{{name}}`, or
   `npx mcp-tc submit <url>` with the GitHub repository, or paste either URL at https://mcp.tc/submit.
{{/stdio}}
   There is no account to create. `submit` shows what it will send, asks before sending, then follows the check
   and prints the link once the listing is ready (`--wait` sets how long it waits, 10 minutes by default). Sending a
   suggestion doesn't mean it will be listed.
5. Once it is listed, `npx mcp-tc badge <slug>` prints the Markdown for a badge; paste it at the top
   of this README. `--format html`, `js` or `iframe` gives you a card for your website.
6. To get the checkmark, which shows who runs a server (it is not a security review), add the TXT record that
   https://mcp.tc/verify shows you (`mcp-tc-verification=...`) under `_mcp-tc.<your-domain>`, test it with
   `npx mcp-tc dns-check <your-domain>`, then request the checkmark on that page.

## Icon

`assets/icon.svg` is a placeholder, and `assets/icon.png` is the same drawing as a 128 x 128 PNG. `src/icon.ts` puts
that PNG into serverInfo. To use your own icon, replace `assets/icon.png` and run `npm run icon`, or point the script
at another file: `npm run icon -- path/to/icon.webp`. Use PNG, WebP or JPEG: many clients and directories skip SVG
icons.

## Files

| Path | What it is |
|---|---|
| `src/server.ts` | The server: its name, description, icon and tools. Start here. |
{{#express}}
| `src/index.ts` | The HTTP side: Express, Host and Origin checks, the `/mcp` route{{#bearer}}, sign-in{{/bearer}}. |
| `src/config.ts` | Settings from environment variables. |
{{/express}}
{{#workers}}
| `src/index.ts` | The worker's `fetch` handler and the `/mcp` route. |
| `src/guard.ts` | Host and Origin checks, written out by hand. |
| `wrangler.jsonc` | Cloudflare Workers settings. |
{{/workers}}
{{#bearer}}
| `src/auth.ts` | Sign-in: the token check and the metadata clients read. |
{{/bearer}}
{{#stdio}}
| `src/index.ts` | Starts the server on stdin and stdout. |
{{/stdio}}
| `src/icon.ts` | The icon as a data URI, written by `npm run icon`. |
| `assets/` | The icon files. |
| `scripts/icon.mjs` | Writes `src/icon.ts` from `assets/icon.png`. |

## Learn more

- [MCP TypeScript SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP specification, revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
{{#remote}}
- [How to build a remote MCP server with Streamable HTTP](https://mcp.tc/blog/build-remote-mcp-server-typescript)
{{/remote}}
- [mcp.tc docs for server owners](https://mcp.tc/docs/server-owners)

Made with `npx mcp-tc create` on `@modelcontextprotocol/server` {{sdkVersion}}.
