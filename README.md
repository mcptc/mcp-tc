# mcp-tc

mcp-tc is the command-line tool for [mcp.tc](https://mcp.tc), a directory of MCP servers. It finds servers in the
directory and adds them to your MCP clients with each vendor's own URL or package, and it helps you build an MCP server
and check it the way mcp.tc reads it.

```console
$ npx mcp-tc search github
$ npx mcp-tc add deepwiki --client cursor
```

- [Install](#install)
- [Commands](#commands)
- [Examples](#examples)
- [Adding servers to your clients](#adding-servers-to-your-clients)
- [Privacy: what the CLI sends](#privacy-what-the-cli-sends)
- [Scripts and agents: --json and exit codes](#scripts-and-agents---json-and-exit-codes)
- [For server authors](#for-server-authors)
- [Contributing and development](#contributing-and-development)
- [License](#license)
- [About mcp.tc](#about-mcptc)

## Install

You need Node.js 20 or later. Run any command without installing:

```bash
npx mcp-tc <command>
```

Or install it once and use `mcp-tc` (or the shorter alias `mcptc`):

```bash
npm i -g mcp-tc
mcp-tc --version
```

The package has no runtime dependencies and no build step.

## Commands

| Command | What it does |
|---|---|
| `search [query]` | Search the directory for MCP servers |
| `info <slug\|name\|link>` | Show one listing: what it does, how to connect, its tools |
| `categories` | List the directory categories and how many servers each has |
| `open <slug>` | Open a listing page in your browser |
| `add <slug> --client <id>` | Add a server to an MCP client with mcp.tc's setup steps |
| `scan` | Find the servers in your MCP client configs on mcp.tc |
| `doctor <slug\|url>` | Connect to a server directly and report what it answers |
| `badge <slug>` | Print badge, website card and iframe snippets for a listing |
| `dns-check <domain>` | Look for mcp.tc verification TXT records in a domain's DNS |
| `submit <url>` | Suggest a server to mcp.tc and wait for the result |
| `create <name>` | Start a new MCP server project (TypeScript SDK v2) |
| `check <url\|dir>` | Check a server or project the way mcp.tc reads it |
| `card [dir]` | Make a server card and a server.json for the MCP Registry |

Every command takes `--json`, `--no-color` (colors are also off when `NO_COLOR` is set or the output is not a
terminal), `-h`/`--help` and `-v`/`--version`. `mcp-tc help <command>` shows a command's options, examples and exit
codes.

## Examples

The outputs below are from real runs of mcp-tc. The examples that would change something on mcp.tc, or that need a
particular kind of server, ran against the local copies of mcp.tc and of an MCP server that come with the test suite.
Lines with directory totals are cut (`…`) because those numbers change every day.

### search

```console
$ mcp-tc search github --limit 5
… servers match "github", featured first. Showing 5.

Name              Slug             Access      Tagline
DeepWiki ✓        deepwiki         No sign-in  Ask questions about any public GitHub repository and read its…
GitHub ✓          github           Sign-in     Work with GitHub repos, issues, pull requests, Actions workflo…
GitMCP            gitmcp           No sign-in  Read documentation and search code of any GitHub repository, s…
Grep by Vercel ✓  grep             No sign-in  Search real code across a million public GitHub repositories w…
Awesome Copilot   awesome-copilot  Local       Retrieve GitHub Copilot customization files from the Awesome C…

✓ Verified: the checkmark says who runs the server, not that it is safe.
More results on mcp.tc: https://mcp.tc/directory?q=github&…
Details and setup: mcp-tc info <slug>
```

Results come in the directory's default order, Featured first. Every word must appear in a server's name, vendor,
tagline or tags. `--category <slug>` limits the search to one category, `--auth none|sign-in|local` to one kind of
access, and `--limit` takes 1 to 25 (default 10). The Access column describes the server: No sign-in, Sign-in, API key,
Sign-in optional, Unconfirmed (a remote server whose sign-in mcp.tc hasn't confirmed) or Local.

### info

```console
$ mcp-tc info deepwiki
DeepWiki ✓
Ask questions about any public GitHub repository and read its AI-generated DeepWiki documentation.

Vendor      Cognition
Category    Docs & Knowledge (docs-knowledge)
Access      No sign-in: add the server URL to any client that supports remote MCP servers.
Server URL  https://mcp.deepwiki.com/mcp
Transport   streamable-http
Checkmark   Verified by mcp.tc: official server from Cognition
Last check  2026-10-05 22:43 UTC, answered
Listing     https://mcp.tc/i/deepwiki
…

Tools (3)
  Tool                 Hints  What it does
  ask_wiki_question           Ask a question about a GitHub repository and get an answer grounded in its Deep…
  read_wiki_contents          View documentation about a GitHub repository.
  read_wiki_structure         Get a list of documentation topics for a GitHub repository.
  Hints come from the server's own tool annotations; blank means the server doesn't say.
…
Add it to a client: mcp-tc add deepwiki --client <id>
Clients: claude-code, claude-desktop, claude-ai, chatgpt, cursor, vscode, devin, codex, gemini, json
```

`info` takes a slug (`notion`), a name (`"Hugging Face"`) or a listing link (`https://mcp.tc/i/notion`). It also shows
the description, capabilities, example prompts and, when mcp.tc tracks them, the listing's recent changes.

### categories

```console
$ mcp-tc categories
Slug                Name                       Servers  About
developer-tools     Developer Tools            …        MCP servers for everyday coding work: repositories, c…
docs-knowledge      Docs & Knowledge           …        Servers that put current documentation and knowledge…
search-web          Search & Web Data          …        Web search, crawling, scraping and extraction servers…
…
Search one: mcp-tc search --category <slug> [words]
```

### open

```console
$ mcp-tc open notion
Opened https://mcp.tc/i/notion

$ mcp-tc open deepwiki --lang de --print
https://mcp.tc/de/i/deepwiki
```

`--lang it|fr|de|es` opens the page in that language. Without a display, or with `--json` or `--print`, `open` prints
the link instead of starting a browser.

### add

```console
$ mcp-tc add deepwiki --client claude-code --dry-run
Claude Code: this command adds DeepWiki:
  $ claude mcp add --transport http deepwiki https://mcp.deepwiki.com/mcp
Dry run: nothing was run.

$ mcp-tc add deepwiki --client cursor --dry-run
Cursor: add "deepwiki" to ~/.cursor/mcp.json

--- ~/.cursor/mcp.json
+++ ~/.cursor/mcp.json
@@ -9,6 +9,9 @@
       "env": {
         "WEATHER_API_KEY": "<hidden>"
       }
+    },
+    "deepwiki": {
+      "url": "https://mcp.deepwiki.com/mcp"
     }
   }
 }

Dry run: nothing was written.
```

The diff hides the values of the servers already in the file. Without `--dry-run`, `add` asks before it runs or writes
anything. See [Adding servers to your clients](#adding-servers-to-your-clients) for what it does in each client.

### scan

```console
$ mcp-tc scan
Found 4 MCP servers in 2 config files.

Claude Code: ~/.claude.json
  example  https://example.com/mcp?...
           Not on mcp.tc. Suggest it: mcp-tc submit https://example.com/mcp

Cursor: ~/.cursor/mcp.json
  deepwiki       https://mcp.deepwiki.com/mcp
                 On mcp.tc: DeepWiki ✓, No sign-in: https://mcp.tc/i/deepwiki
  weather        npx @example/weather-mcp
                 Not on mcp.tc. Suggest it: mcp-tc submit https://www.npmjs.com/package/@example/weather-mcp
  my-dev-server  http://localhost:3000/...
                 not looked up: an address on this computer or a private network

On mcp.tc: 1 listed, 2 not listed, 1 not looked up.
Suggest a missing server with: mcp-tc submit <url>, or at https://mcp.tc/submit
```

Here scan sent `https://example.com/mcp` (without its `?key=…`), `https://mcp.deepwiki.com/mcp` and
`@example/weather-mcp`, then made one request for the directory index. The localhost server, the header in the Claude Code
entry and the environment value in the Cursor entry were not sent. `mcp-tc scan --offline` lists the same servers and
sends nothing. `--client <id>` reads one client's files only.

`scan` reads these files, in your home folder and in the current folder:

| Client | Files |
|---|---|
| Claude Code | `~/.claude.json` (your servers, and this folder's), `.mcp.json` |
| Claude Desktop | `claude_desktop_config.json` (macOS and Windows) |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` |
| VS Code | the user `mcp.json` (Stable, Insiders and their profiles), `~/.copilot/mcp-config.json`, `.vscode/mcp.json`, `.mcp.json` |
| Devin Desktop | `mcp_config.json`, and the older `~/.codeium/mcp_config.json` and `~/.codeium/windsurf/mcp_config.json` |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`), `.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json`, `.gemini/settings.json` |

An entry that points at an mcp.tc listing page (`https://mcp.tc/i/…`) instead of the server is reported, with the `add`
command that sets the server's own URL: a listing page is a web page, and MCP clients can't connect to it.

### doctor

```console
$ mcp-tc doctor https://mcp.tc/mcp
Connecting to https://mcp.tc/mcp ...
Server URL  https://mcp.tc/mcp
Answer      HTTP 200 in 161 ms
Protocol    2026-07-28 (server/discover)
Transport   Streamable HTTP, JSON replies
Session     none (stateless)
Access      No sign-in
Server      mcp.tc 1.1.0 (mcp.tc directory)
Tools       3 (3 read-only)
Requests    2 in 231 ms

The server answers MCP without sign-in.
```

`doctor` connects the way an MCP client would: the 2026-07-28 style (`server/discover`) first, then the `initialize`
handshake, then the older HTTP+SSE transport. It reads JSON and SSE replies. It reads a server's OAuth metadata but never
signs in, and it never calls a tool. For a server that asks for sign-in:

```console
$ mcp-tc doctor http://localhost:3000/mcp
Connecting to http://localhost:3000/mcp ...
Server URL   http://localhost:3000/mcp
Answer       HTTP 401
Access       Sign-in (OAuth): the client opens a sign-in page the first time it connects
Metadata     http://localhost:3000/.well-known/oauth-protected-resource/mcp
Scopes       docs:read
Auth server  http://localhost:3000 (client registration: yes; PKCE S256: yes)
Requests     3 in 48 ms

The server asks for OAuth sign-in. Clients open the sign-in page the first time they connect; its tools show after that.
```

Give `doctor` a slug, a name or a listing link and it asks mcp.tc for the server's URL first, then connects to that URL.
To test your own server with a token, pass `--header "Authorization: Bearer YOUR_TOKEN"` (repeatable). `--timeout`
sets the seconds to wait for each answer (default 15).

### badge

```console
$ mcp-tc badge deepwiki
README badge (Markdown)
[![DeepWiki on mcp.tc](https://mcp.tc/i/deepwiki/badge.svg)](https://mcp.tc/i/deepwiki)

Badge (HTML)
<a href="https://mcp.tc/i/deepwiki"><img src="https://mcp.tc/i/deepwiki/badge.svg" alt="DeepWiki on mcp.tc" height="20"></a>

Website card (script tag)
<script src="https://mcp.tc/w/deepwiki.js" async></script>

Compact card (iframe)
<iframe src="https://mcp.tc/embed/deepwiki" title="DeepWiki on mcp.tc" width="420" height="200" loading="lazy" allow="clipboard-write" style="border:0;border-radius:8px;max-width:100%"></iframe>

Options (themes, sizes, languages): https://mcp.tc/embed
```

`--format md|html|js|iframe` prints only that snippet, ready to append to a file:
`mcp-tc badge my-server --format md >> README.md`.

### dns-check

```console
$ mcp-tc dns-check example.com
TXT records starting with mcp-tc-verification= (system resolver):

  example.com          2 TXT records, none for mcp.tc
  _mcp-tc.example.com  no TXT records

No mcp-tc-verification= record found at example.com or _mcp-tc.example.com.
Note: mcp.tc also asks the domain's authoritative name servers, so a record you just added can reach mcp.tc before your resolver shows it.
```

It also takes a URL (`mcp-tc dns-check https://mcp.example.com/mcp`). Exit code 0 means a record was found, 3 means
none, 1 means the lookups failed.

### submit

```console
$ mcp-tc submit https://mcp.example.com/mcp --note "The official server of Example."
mcp-tc will send this suggestion to mcp.tc:
  URL   https://mcp.example.com/mcp
  Note  The official server of Example.
mcp.tc checks the URL and the note automatically, including with an AI model, and a person may review them.
Sending a suggestion doesn't mean the server will be listed. Leave personal data out of the note.
Send this suggestion to mcp.tc? [y/N] y
Sent to mcp.tc: https://mcp.example.com/mcp
Status page: https://mcp.tc/s/<token>
Waiting up to 10m for the result. Ctrl+C stops waiting; the check goes on, and the status page keeps updating.
[0:10] Checking the server: Connecting to it and reading what it says about itself.
[0:15] Writing the listing: Summarizing what it does and running a few checks.
Listed: https://mcp.tc/i/weather-mcp
Details and setup: mcp-tc info weather-mcp
```

See [Suggest it to mcp.tc](#suggest-it-to-mcptc) for the addresses `submit` takes and the states it reports.

### create

```console
$ mcp-tc create weather-mcp --yes
Created weather-mcp in ./weather-mcp
  Template  express (Streamable HTTP on Express)
  Sign-in   none
  SDK       @modelcontextprotocol/server 2.3.1, @modelcontextprotocol/node 2.1.1,
            @modelcontextprotocol/express 2.0.2

Files:
  .gitignore
  assets/icon.png
  assets/icon.svg
  package.json
  README.md
  scripts/icon.mjs
  src/config.ts
  src/icon.ts
  src/index.ts
  src/server.ts
  tsconfig.json

Next steps:
  cd weather-mcp
  npm install
  npm run dev

The server then answers on http://127.0.0.1:3000/mcp. In another terminal, check it the way mcp.tc reads servers:
  npx mcp-tc check http://127.0.0.1:3000/mcp

README.md has curl tests, settings, and the steps to get listed on mcp.tc.
```

### check

```console
$ mcp-tc check https://mcp.tc/mcp
Checking https://mcp.tc/mcp ...
Checked https://mcp.tc/mcp
  Server URL  https://mcp.tc/mcp
  Answer      HTTP 200 in 164 ms
  Protocol    2026-07-28 (server/discover)
  Transport   Streamable HTTP, JSON replies
  Session     none (stateless)
  Access      No sign-in
  Server      mcp.tc 1.1.0 (mcp.tc directory)
  Tools       3 (3 read-only)
  Requests    6 in 384 ms

  ok    Answers without sign-in.
  ok    Answers server/discover (protocol 2026-07-28).
  ok    Answers initialize (protocol 2025-11-25).
  ok    serverInfo: mcp.tc 1.1.0.
  ok    Lists 3 tools.
  ok    Every tool has a description and the readOnlyHint and destructiveHint annotations it needs.
  ok    Server card at https://mcp.tc/mcp/server-card.
  ok    Server card at https://mcp.tc/.well-known/mcp/server-card.json.

0 errors, 0 warnings, 0 suggestions.
check reads your server the way mcp.tc reads it and points out what would stop clients or the listing from reading it well. On mcp.tc an AI model checks each suggestion and a person may review it; check doesn't predict whether the server will be listed.
```

### card

```console
$ mcp-tc card --url https://weather.example.com/mcp --offline --name com.example/weather
Server card (serve it at <your endpoint>/server-card):
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "com.example/weather",
  "description": "A remote MCP server on Streamable HTTP, built with the MCP TypeScript SDK.",
  "version": "0.1.0",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://weather.example.com/mcp"
    }
  ]
}

server.json (for the official MCP Registry, schema 2025-12-11):
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "com.example/weather",
  "description": "A remote MCP server on Streamable HTTP, built with the MCP TypeScript SDK.",
  "version": "0.1.0",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://weather.example.com/mcp"
    }
  ]
}

Name: com.example/weather (from --name)
- package.json says "private": true, so server.json has no npm package.
Write them with --out <file> and --server-json <file>.
Publish server.json with the official mcp-publisher tool: https://github.com/modelcontextprotocol/registry
```

## Adding servers to your clients

`add` follows the setup steps that mcp.tc publishes for each client (the same steps as the listing page), so when
mcp.tc updates a client's syntax, `add` follows without a new release of mcp-tc. Every command, config entry and link it
writes uses the server's own URL or package. An mcp.tc listing link never goes into a client config: if a setup ever
contained one, `add` would stop before writing or running anything.

| `--client` | Client | What `add` does |
|---|---|---|
| `claude-code` | Claude Code | Shows `claude mcp add …` and runs it after you confirm |
| `gemini` | Gemini CLI | Shows `gemini mcp add …` and runs it after you confirm |
| `codex` | Codex | Shows `codex mcp add …` (and `codex mcp login` when the steps include it) and runs it after you confirm |
| `cursor` | Cursor | Merges the entry into your Cursor config file |
| `vscode` | VS Code | Merges the entry into your VS Code `mcp.json` |
| `claude-desktop` | Claude Desktop | Merges the entry into `claude_desktop_config.json` |
| `devin` | Devin Desktop (formerly Windsurf) | Merges the entry into `mcp_config.json` |
| `claude-ai` | claude.ai | Prints the steps and the link to the connector form |
| `chatgpt` | ChatGPT | Prints the steps and the link |
| `json` | Any other client | Prints the JSON entry |

Run with `--dry-run` first to see the command or the diff without changing anything.

### Clients with their own command: Claude Code, Gemini CLI, Codex

`add` prints the client's command and runs it after you answer yes. It starts the program directly, without a shell,
and it only ever runs `<client> mcp add` (and `codex mcp login`). A setup with shell steps (pipes, `&&`, variables) is
printed for you to run by hand.

- `--global` adds the server for all your projects: `--scope user` for Claude Code, `-s user` for Gemini CLI. Codex
  already adds servers for all projects.
- Gemini CLI saves a server in `.gemini/settings.json` in the current folder unless told `-s user`, and Claude Code's
  `--scope project` uses `.mcp.json` there. Both files can end up in a repository, so `add` refuses to put a key in them
  and asks you to use `--global`.
- A key passed with `claude mcp add --header` is visible to other users of the same computer in the process list
  (`ps`) while the command runs. When that matters, use the client's own prompt or edit its user file yourself.
- When a Codex server needs a key in a header other than `Authorization`, `codex mcp add` has no option for it. `add`
  then runs nothing and prints mcp.tc's `config.toml` steps, with the variable to set.
- On Windows, `add` looks for `claude.exe`, `codex.exe` or `gemini.exe` (or `.com`) in the absolute folders of your
  `PATH`, never in the current folder. It can't start the `.cmd` files that npm installs, because it never uses a
  shell; it then prints the command for you to run.

### Clients with a JSON file: Cursor, VS Code, Claude Desktop, Devin Desktop

By default `add` writes your user-level file:

| Client | macOS | Linux | Windows |
|---|---|---|---|
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` | `~/.config/Code/User/mcp.json` | `%APPDATA%\Code\User\mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | (none) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Devin Desktop | `~/.config/devin/mcp_config.json` | `~/.config/devin/mcp_config.json` | `%APPDATA%\devin\mcp_config.json` |

`$XDG_CONFIG_HOME` replaces `~/.config` where it applies. Claude Desktop has no Linux version, so on Linux `add` prints
the steps (`--file <path>` writes a file anyway). If Devin Desktop's file doesn't exist yet but an older
`~/.codeium/…/mcp_config.json` does, `add` warns and suggests `--file`. `--project` writes `.cursor/mcp.json` or
`.vscode/mcp.json` in the current folder instead, and `--file <path>` writes any file you name.

Then, in this order:

1. It merges the new entry into the file. Your other servers stay as they are.
2. It shows the change as a diff. Other servers' values show as `<hidden>`; only the new entry is shown in full.
3. It asks. With `--yes` it doesn't.
4. It copies the file to a backup folder of its own (never next to the file, where a copy of a project file could slip
   past its `.gitignore`), and prints where. The folder is created with mode 0700 and each backup with 0600:

   | System | Backup folder |
   |---|---|
   | Linux | `$XDG_STATE_HOME/mcp-tc/backups`, else `~/.local/state/mcp-tc/backups` |
   | macOS | `~/Library/Application Support/mcp-tc/backups` (or `$XDG_STATE_HOME/mcp-tc/backups` when set) |
   | Windows | `%LOCALAPPDATA%\mcp-tc\backups` |

5. It writes the file in one step (a temporary file, then a rename). A new file gets mode 0600.

Some cases stop it:

- A file with comments or trailing commas (JSONC) is never rewritten, because rewriting would drop them. `add` prints the
  entry for you to paste.
- An entry with the same name and other settings is left alone unless you pass `--yes`, which replaces it after the
  backup. An identical entry is reported as already there.
- If the file changes while `add` waits for your answer, nothing is written.
- With `--project`, a file or folder that links outside the project folder is refused.
- When `add` has to change the file's layout (indentation, line breaks), it says so first. The backup keeps the original.

### API keys and other values to fill in

mcp.tc's steps mark the values you supply with placeholders such as `<YOUR_API_KEY>`, `YOUR_X`, `/path/to/…` or
`{name}`. When you run `add` in a terminal, it asks for each one; keys are not echoed. A key goes only into the client's
own config on this computer, and never to mcp.tc, the screen, the diff or the `--json` output.

- VS Code asks for keys itself: `add` writes an `inputs` entry with `"password": true`, and VS Code prompts for the value
  and stores it. No key is written to the file, so `.vscode/mcp.json` works too.
- For the other clients a key goes only into a user-level file. A key for a project file is refused
  (`key_in_project_file`): run `add` without `--project`.
- A user file that sits inside a git repository (for example a dotfiles repository, links followed) keeps the
  placeholder, with a warning.
- If the file you add a key to can be read by other users on your computer, `add` suggests `chmod 600`.
- A command is never run while a placeholder is left in it. With `--yes`, or without a terminal, the CLI clients stop
  with `needs_values` and run nothing. The JSON clients with `--yes` write the placeholder and tell you to replace it
  (in `--json`, `"complete": false`).

```console
$ mcp-tc add ref-tools --client claude-code --dry-run
Claude Code: this command adds Ref:
  $ claude mcp add --transport http ref-tools https://api.ref.tools/mcp --header 'X-Ref-Api-Key: <YOUR_API_KEY>'
Dry run: nothing was run. It needs <YOUR_API_KEY>: add asks for it when you run it in a terminal without --yes, and runs nothing without it.
```

### claude.ai and ChatGPT

There is nothing to write on your computer, so `add` prints the steps and the link that opens the connector form. In
claude.ai custom connectors live under **Customize → Connectors**, and an API key goes under **Request headers** in that
form:

```console
$ mcp-tc add ref-tools --client claude-ai
claude.ai: Ref
   1. Open the connector form on claude.ai. This button fills in the name and URL for you:
   2. Add to claude.ai:
     https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Ref&connectorUrl=https%3A%2F%2Fapi.ref.tools%2Fmcp
   3. Check that the URL reads https://api.ref.tools/mcp. Under Request headers, add X-Ref-Api-Key:
     <YOUR_API_KEY> with your key from Ref, then click Add.
   4. Turn it on in a chat from the tools menu.
  Note: Free plans allow one custom connector. On Team and Enterprise plans an owner adds it under
  Organization settings → Connectors.
  There is nothing to install on this computer for this client.
```

### Local servers

A local server runs on your computer from a package (for example `npx -y @modelcontextprotocol/server-memory`).
mcp-tc itself never runs `npx`, `uvx` or `docker`: `add` registers the command with your client, which starts it later.
Registering it needs your confirmation too. The client's command runs only after you say yes, and a config entry is
written only after you have seen the diff and agreed. When mcp.tc has no install command for a server (its own
instructions use shell steps), `add` stops with `no_setup` and points you to the vendor's instructions.

## Privacy: what the CLI sends

mcp-tc has no telemetry, no analytics and no crash reports, and it sends no cookies. Every request it makes carries the
User-Agent `mcp-tc-cli/<version> (+https://github.com/mcptc/mcp-tc)`, and servers you connect to see the client name
`mcp-tc-cli`. Requests to mcp.tc go one at a time. When mcp.tc answers 429, mcp-tc waits as `Retry-After` says (10
seconds when it says nothing, then longer), tries at most 4 times and waits at most 60 seconds in all, then stops with
exit code 4. If Cloudflare refuses a request, mcp-tc reports it (`blocked`) and does not try to get around it.

What each command sends:

| Command | Sent to mcp.tc | Other network use |
|---|---|---|
| `search` | Your search words and the `--category`, `--auth` and `--limit` values, in one call to mcp.tc's MCP server (`POST https://mcp.tc/mcp`, tool `search_servers`) | none |
| `info` | The slug, name or listing link (tool `get_server`). Text that looks like a URL, a credential or a key is refused before any request. | none |
| `categories` | One `list_categories` call | none |
| `open` | One `HEAD /i/{slug}.json`, to check that the listing exists | your browser then opens the page |
| `badge` | One `GET /i/{slug}.json` (with `?lang=` when you pass `--lang`) | none |
| `add` | One `get_server` call with the slug and the client id, plus a second one with the slug alone when mcp.tc has no steps for that client | runs the client's own command, after you confirm |
| `scan` | See below | none |
| `doctor` | For a slug, name or listing link: one `get_server` call to learn the server's URL. A URL is never sent to mcp.tc. | connects to the server you name |
| `check` | For an mcp.tc listing link: one `get_server` call. Nothing for a URL or a folder. | connects to the server you name |
| `card` | nothing | with `--url`: a handshake with your server (none with `--offline`) |
| `dns-check` | nothing | DNS queries through your system resolver |
| `create` | nothing | none: it installs nothing |
| `submit` | The URL and the note, after you have seen them and said yes | none |

### What scan sends

For each different server in your configs, scan sends one `GET /directory?q=<address>`, one at a time. The
address is one of these:

- for a remote server, its https URL without user name, password, query string or fragment. When part of the path looks
  like a key (a long random token, a UUID, a `name=value` part), only the scheme and host are sent;
- for a local server, its npm package name (for an unscoped name, its npmjs.com page URL), its PyPI project page URL, or
  its GitHub, GitLab, Bitbucket or Codeberg repository URL;
- for an `mcp-remote` bridge, the remote URL it connects to, reduced the same way.

When at least one server is listed, scan also reads `GET /api/index.json` once for the listings' names, access and
checkmarks. It never sends headers, environment values, keys, the other command arguments, file paths, the names you
gave your servers, or which clients you use. It looks nothing up for addresses on your computer or a private network
(localhost, private, shared and reserved IP ranges, single-label names, `.local`, `.internal`, `.lan`, `.home.arpa`,
Kubernetes `.svc` and similar names, tailnet `.ts.net` names), plain `http://` URLs, URLs with variables, container
images or mcp.tc listing links. `--offline` sends nothing at all.

### What add sends

`add` sends mcp.tc only the slug and the client id. Keys you type stay on your computer: they go only into the client's
config file or into the client's own command, never to mcp.tc, the screen or the `--json` output.

### What doctor and check send

`doctor` and `check` connect directly to the server you name, the way an MCP client would, and also read the documents
that server points to: its OAuth metadata and its server card (`<endpoint>/server-card` and
`/.well-known/mcp/server-card.json`). For a server on your own computer, `check` also sends two requests with a made-up
Host and Origin to test its DNS rebinding protection. Values you pass with `--header` go only on MCP requests to the
server's own origin: they are dropped on a redirect to another origin, never sent to metadata or card hosts, and never
printed. With a folder, `check` reads the project files; `--stdio` and `--command` start the project's server on your
computer.

### What submit sends

`submit` sends `POST https://mcp.tc/submit` with `{"url": "…", "note": "…"}` (the note only when you give one),
`Content-Type` and `Accept: application/json` and the User-Agent. No cookies, no `Origin` header, nothing from your
config files. Before sending, it removes a user name and password, the `#fragment` and every query parameter that looks
like a key or a token, and tells you what it removed. It refuses a URL whose path looks like it holds a key or an
account ID, a private address, and an mcp.tc link. The note is cut to 500 characters, the most mcp.tc keeps. In a
terminal it shows exactly what it will send and asks first (`--yes` skips the question). Then it reads the suggestion's
status, `GET /s/{token}.json`, every 5 seconds for the first minute and every 10 seconds after that, until the
suggestion is finished or `--wait` runs out.

mcp.tc checks the URL and the note automatically, including with an AI model, and a person may review them. Leave
personal data out of the note.

## Scripts and agents: --json and exit codes

With `--json`, a command prints exactly one JSON document on stdout. Progress and warnings go to stderr, and there are
no colors or escape sequences.

```console
$ mcp-tc open deepwiki --json
{
  "ok": true,
  "command": "open",
  "url": "https://mcp.tc/i/deepwiki",
  "opened": false
}
```

A failure has `"ok": false` and an `error` object with a stable snake_case `code` and an English `message`, sometimes
with more fields:

```console
$ mcp-tc info no-such-server --json; echo "exit $?"
{
  "ok": false,
  "command": "info",
  "error": {
    "server_message": "No listing at mcp.tc/i/no-such-server. Use search_servers to find the right slug.",
    "code": "not_found",
    "message": "No listing for \"no-such-server\" on mcp.tc. Find the slug with: mcp-tc search <words>"
  }
}
exit 3
```

`ok` tells you whether the command did its job; the exit code tells you the outcome. Some outcomes are not failures but
still have their own exit code, and then the JSON keeps `"ok": true`:

- `dns-check` with no record: exit 3, `"found": false`.
- `doctor` with an unreachable server: exit 5, with a `verdict` (`ok`, `sign_in`, `api_key`, `blocked`, `not_mcp`,
  `unreachable`).
- `check` with errors: exit 6, with `findings` (`level`, `id`, `message`) and `counts`.
- `scan` when mcp.tc limited or refused the lookups part of the way: exit 4 (rate limited) or 1, with
  `"partial": {"code": "…", "message": "…"}` and everything it found locally.
- `submit` reports the suggestion's `state` (`queued`, `checking`, `reviewing`, `listed`, `duplicate`, `pending`,
  `rejected`, `error`), plus `timed_out`, `token`, `status_url`, `page` and `listing` (`slug`, `name`, `link`) once
  there is one. A URL that mcp.tc refuses outright is an error (`"ok": false`, exit 11).

```console
$ mcp-tc submit https://mcp.deepwiki.com/mcp --yes --json
{
  "ok": true,
  "command": "submit",
  "sent": {
    "url": "https://mcp.deepwiki.com/mcp",
    "kind": "url",
    "note": null
  },
  "changes": [],
  "state": "duplicate",
  "terminal": true,
  "timed_out": false,
  "waited_seconds": 0,
  "token": null,
  "status_url": null,
  "page": null,
  "existing_submission": false,
  "listing": {
    "slug": "deepwiki",
    "name": "DeepWiki",
    "link": "https://mcp.tc/i/deepwiki"
  },
  "status": null
}
```

A command that needs an answer (a confirmation, a value) and has no terminal to ask in stops with exit 2
(`needs_confirmation` or `needs_values`) instead of waiting. Pass `--yes` where the command supports it.
`mcp-tc help --json` lists the commands, and `mcp-tc help <command> --json` gives a command's options, examples and
exit codes.

### Exit codes

| Code | Meaning | Commands |
|---|---|---|
| 0 | Success. `submit`: listed or already listed (with `--no-wait`: queued). `doctor`: the server answered, or asked for sign-in. `dns-check`: a record was found. | all |
| 1 | Error: network, a server error, anything unexpected, or Ctrl+D at a question | all |
| 2 | Usage error: bad options or arguments, or a question with no terminal to ask in | all |
| 3 | Not found: no listing with that slug or name, or it was removed. `add`: mcp.tc has no steps for that client. `dns-check`: no record. | `info`, `open`, `add`, `badge`, `doctor`, `check`, `dns-check` |
| 4 | mcp.tc kept answering 429 (too many requests) after the retries | `search`, `info`, `categories`, `open`, `add`, `scan`, `badge`, `doctor`, `check`, `submit` |
| 5 | The server could not be reached or did not answer as an MCP server | `doctor`, `check`, `card --url` |
| 6 | `check` found errors | `check` |
| 10 | Waiting for a person's review | `submit` |
| 11 | Not accepted: the review said no, or mcp.tc refused the URL | `submit` |
| 12 | `--wait` ran out while the server was still being checked | `submit` |
| 130 | Ctrl+C at a question: nothing was sent or written | `add`, `submit`, `create`, `card` |

## For server authors

### Start a project: create

`mcp-tc create <name>` writes a new MCP server project on the MCP TypeScript SDK v2. `<name>` is the npm package name;
the folder must be new or empty. In a terminal, `create` asks for the template and sign-in mode you didn't pass. `--yes`
takes the defaults (express, no sign-in). Nothing is installed: run `npm install` in the new folder.

| `--template` | What you get |
|---|---|
| `express` (default) | A Streamable HTTP server on Express with one stateless `/mcp` endpoint. It checks the `Host` and `Origin` headers (localhost only until you set `ALLOWED_HOSTS`), sends CORS headers to the sites you allow, serves its server card and shuts down cleanly on SIGTERM. |
| `workers` | A Cloudflare Workers `fetch` handler on `/mcp`, with the `Host` and `Origin` checks written out by hand in `src/guard.ts`. Wrangler 4 needs Node.js 22 or later. |
| `stdio` | A local server that clients start as a program, ready to publish on npm with a `bin` entry. |

`--auth bearer` (express and workers) makes the server an OAuth resource server. It publishes the Protected Resource
Metadata (RFC 9728), answers 401 with a `WWW-Authenticate` challenge that points to it, and checks that each token was
issued for this server (`expectedResource`, RFC 8707). You bring the identity provider: `src/auth.ts` marks the places
to fill in. Until then, you can try the server with a development token, which works on localhost only.

Every project has one read-only example tool, `http_status`, with its annotations and an output schema, a placeholder
icon (a PNG, since many clients and directories skip SVG icons), and a README with the steps to try it: curl tests for
express and workers, the MCP Inspector for stdio. The README also has the steps to get listed on mcp.tc and a spot for
the badge. The SDK versions are pinned exactly, in one file of this package (`src/lib/versions.js`), and tested
together.

### Check it: check

`check` reads your server the way mcp.tc reads it and lists errors, warnings and suggestions. For a URL it checks:

- the handshake in both protocol styles: `server/discover` (2026-07-28) and `initialize` (2025-11-25, 2025-06-18,
  2025-03-26), and the older HTTP+SSE transport; JSON and SSE replies; sessions;
- `serverInfo`: name, version, title, description, website and icon;
- `tools/list`: every tool's name, input schema, description (missing or very short descriptions are flagged) and its
  `readOnlyHint` and `destructiveHint` annotations;
- sign-in: the 401 and its `WWW-Authenticate` header, the Protected Resource Metadata and the authorization server's
  metadata (PKCE S256, client registration);
- the server card at `<endpoint>/server-card` and `/.well-known/mcp/server-card.json`;
- keys in the URL;
- for a server on your own computer, that a foreign `Host` and `Origin` are refused (DNS rebinding protection, which
  the MCP specification requires).

```console
$ mcp-tc check http://localhost:3000/mcp
Checking http://localhost:3000/mcp ...
Checked http://localhost:3000/mcp
  Server URL  http://localhost:3000/mcp
  Answer      HTTP 200 in 5 ms
  Protocol    2025-11-25 (initialize)
  Transport   Streamable HTTP, replies as SSE streams
  Session     Mcp-Session-Id issued, ended with DELETE
  Access      No sign-in
  Server      weather-mcp 0.1.0 (Weather)
  Tools       2 (2 without hints)
  Requests    7 in 54 ms

  error The server accepted a request with a foreign Origin (http://mcp-tc-check.invalid). A web page could
        reach it through DNS rebinding: refuse unknown Origins with HTTP 403, as the MCP specification
        requires.
  warn  Very short tool descriptions (under 20 characters): get_forecast. Say what the tool does, what it
        returns and when to use it.
  warn  Tools without readOnlyHint: get_forecast, delete_alert. Without it, mcp.tc can't say which tools only
        read, and clients can't either.
  warn  Tools that may change things but have no destructiveHint: get_forecast, delete_alert. Set it so
        clients can warn before a delete or overwrite.
  warn  The server accepted a request with a foreign Host header. Check Host as well (for example allowedHosts
        in the MCP TypeScript SDK), so DNS rebinding fails even when a request has no Origin.
  tip   No answer to server/discover, the 2026-07-28 style. Clients fall back to initialize for now; add it
        when your SDK supports it.
  tip   Tools without a title: get_forecast, delete_alert. Clients show the title to people.
  tip   No server card at http://localhost:3000/mcp/server-card. Make one with: mcp-tc card --url
        http://localhost:3000/mcp
  ok    Answers without sign-in.
  ok    Answers initialize (protocol 2025-11-25).
  ok    Replies come as SSE streams, which clients read fine.
  ok    serverInfo: weather-mcp 0.1.0.
  ok    Lists 2 tools.

1 error, 4 warnings, 3 suggestions.
check reads your server the way mcp.tc reads it and points out what would stop clients or the listing from reading it well. On mcp.tc an AI model checks each suggestion and a person may review it; check doesn't predict whether the server will be listed.
```

For a folder, `check` reads `package.json`, `server.json` and a server card file. Add `--url <endpoint>` to check the
running server too, or `--stdio` (the `bin` from `package.json`, started with node) or `--command "<command>"` to start
a local server and check it over stdio; both run the project's code on your computer. `--header` passes a token for a
server that needs one.

`check` tells you whether clients and mcp.tc can read your server. It does not tell you whether mcp.tc will list it: on
mcp.tc an AI model checks each suggestion, and a person may review it. It exits 0 with no errors (there may be warnings),
6 with errors and 5 when the server can't be read at all.

### Server card and server.json: card

`card` builds two documents from `package.json`, plus a handshake with your running server when you give `--url`:

- a server card (the MCP server card extension, SEP-2127): name, title, description, version, links, icons and remote
  URLs, never tools or capabilities. Serve it at `<your endpoint>/server-card`, the location the extension recommends;
  some scanners also look at `/.well-known/mcp/server-card.json`.
- a `server.json` for the [official MCP Registry](https://github.com/modelcontextprotocol/registry) (schema
  2025-12-11), with an npm package when `package.json` has a `bin` entry and isn't private, and a remote for `--url`.
  Publish it with the registry's `mcp-publisher` tool. mcp.tc reads registry entries too.

The registry name comes from `--name`, else `mcpName` in `package.json`, else your repository or homepage. Descriptions
must be 100 characters or less: `card` stops instead of cutting yours. It prints both documents unless you name files
with `--out` and `--server-json`, and it overwrites an existing file only after asking (or with `--yes`). `--offline`
uses the `--url` without connecting. `--header` values are used for the handshake and never written to the files.

### Suggest it to mcp.tc

`submit` sends a server's address to mcp.tc, like the [Submit page](https://mcp.tc/submit), with the same checks and
the same limits as the form. There is no account to create. It takes:

- a remote MCP endpoint (`https://mcp.example.com/mcp`),
- a GitHub or GitLab repository,
- an npm or PyPI package page, or `npm:<package>` and `pypi:<package>` for short,
- an official MCP Registry name (`io.github.you/weather`).

Then it follows the suggestion's status and prints what happens:

| State | What it means | Exit |
|---|---|---|
| `queued`, `checking`, `reviewing` | Still being checked (with `--no-wait`, `submit` stops at `queued`) | 0 with `--no-wait`, else it keeps waiting |
| `listed` | The listing is live; `submit` prints its link | 0 |
| `duplicate` | The server is already listed; `submit` prints the existing listing | 0 |
| `pending` | Waiting for a person's review; the status page shows the decision | 10 |
| `rejected` | Not accepted | 11 |
| `error` | The check could not finish | 1 |
| (timeout) | `--wait` ran out; the check goes on and the status page keeps updating | 12 |

`--wait` takes `30s`, `5m`, `1h` or a number of seconds (default 10 minutes, at most 1 hour). Ctrl+C while waiting only
stops `submit` from following: the check goes on, and the status page keeps updating. When mcp.tc's daily limits are
reached, `submit` reports the wait and exits 4 without trying again. Sending a suggestion doesn't mean the server will
be listed.

### Badge and website card

Once your server is listed, `mcp-tc badge <slug>` prints the README badge in Markdown and HTML, the website card (one
`<script>` tag, rendered in a closed shadow root, with no cookies) and a compact iframe card for pages that don't allow
scripts. The addresses come from the listing's own JSON on mcp.tc. `--lang it|fr|de|es` sets the language of the card,
the iframe and the link (once the listing is translated); the badge itself has no language. Themes, sizes and the
Content Security Policy you need are on [mcp.tc/embed](https://mcp.tc/embed).

### The verified checkmark

The checkmark next to a server's name says who runs the server. It is not a security review: mcp.tc doesn't audit code,
test tools or check how a server handles your data. A listing gets it in one of two ways:

- "Verified by mcp.tc": for well-known servers, mcp.tc checked that the URL is on the vendor's own domain or that the
  code is in the vendor's own repository.
- "Verified with DNS": whoever controls the server's domain adds a TXT record, and a person at mcp.tc approves the
  request.

To get it for your listing:

1. Open [mcp.tc/verify](https://mcp.tc/verify), find your listing and open its page there. It names the domain: the
   domain of the server's own URL, or of its homepage for a server that runs locally.
2. Add the TXT record it shows, `mcp-tc-verification=…`, under `_mcp-tc.<your-domain>` or on the domain itself.
3. Test it: `mcp-tc dns-check <your-domain>`. mcp.tc asks your domain's authoritative name servers, so it may see a new
   record before your resolver does.
4. Press **Request the checkmark** on that page. A person reviews the request, and the decision shows on the same page.
5. Keep the record: mcp.tc checks it again every day.

## Contributing and development

Issues and pull requests are welcome at [github.com/mcptc/mcp-tc](https://github.com/mcptc/mcp-tc).

The code is plain JavaScript (ES modules, with JSDoc types) with no build step and no runtime dependencies; please keep
it that way. Each command is one file in `src/commands/` that exports `meta` (usage, options, examples, exit codes) and
`run`.

```bash
git clone https://github.com/mcptc/mcp-tc.git
cd mcp-tc
npm install                      # dev dependencies only (schema validation in the tests)
node bin/mcp-tc.js search github # run your working copy
npm test                         # the offline suite
```

- `npm test` runs every `test/*.test.js` file with `node --test` and needs no network: it starts a local copy of mcp.tc
  with recorded answers and a fake MCP server. Options after `--` go to `node --test`, for example
  `npm test -- --test-name-pattern=doctor`.
- `MCPTC_LIVE=1 npm test` adds a few read-only checks against https://mcp.tc, one request at a time. They never submit
  anything.
- `MCPTC_SLOW=1 npm test` also installs the pinned SDK versions from npm into each `create` template, builds them and
  runs real MCP handshakes against them. It needs the npm registry. Run it after changing `src/lib/versions.js`.
- `MCPTC_BASE_URL` points the CLI at another copy of mcp.tc, such as a local test server (default
  `https://mcp.tc`).
- `MCPTC_DEBUG=1` prints stack traces for errors.

The tests also check the wording of the source, the templates and this README (for example: no em or en dashes, no
invisible characters). Maintainers can keep an optional, git-ignored `.internal-words` file at the package root with one
regular expression per line (lines starting with `#` are comments). When it exists, a test fails if any file of the
repository matches one of them; without it, that test is skipped.

## License

MIT. See [LICENSE](LICENSE).

## About mcp.tc

mcp-tc is maintained by [mcp.tc](https://mcp.tc), a free, independent directory of MCP servers. Every server has a page
at a link you can guess, like `mcp.tc/i/notion`, with what it does, its tools, whether it needs sign-in, and one-click
setup for Claude, Cursor, VS Code and other clients. Your client connects straight to each server's own URL, so tool
calls, sign-in tokens and API keys never pass through mcp.tc.

mcp.tc is not affiliated with Anthropic or the Model Context Protocol project. Questions: support@mcp.tc.
