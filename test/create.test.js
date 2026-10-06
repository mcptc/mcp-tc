// Tests for `mcp-tc create` and its templates.
//
// The default run is offline: it generates every template and sign-in mode into temporary folders and checks the
// files. With MCPTC_SLOW=1 it also installs the pinned SDK versions from the npm registry into each generated project,
// builds it, starts it, and talks to it with the official MCP client (@modelcontextprotocol/client) and with the curl
// commands from the generated README.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as netServer, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runCli } from './helpers/fake-directory.js';
import { internalWords } from './helpers/internal-words.js';
import { loadCommand, main } from '../src/cli.js';
import { GLOBAL_OPTIONS } from '../src/lib/args.js';
import { buildProject, deriveNames, packageJson, packageNameProblems, removeWritten, renderTemplate, templateFiles } from '../src/commands/create.js';
import { TEST_CLIENT_VERSION, VERSIONS, WORKERS_COMPATIBILITY_DATE } from '../src/lib/versions.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = join(ROOT, 'templates');
const NO_TTY = { isTTY: false };
const COMBOS = /** @type {const} */ ([
  ['express', 'none'],
  ['express', 'bearer'],
  ['workers', 'none'],
  ['workers', 'bearer'],
  ['stdio', 'none'],
]);
const EXPECTED_FILES = {
  express: ['.gitignore', 'README.md', 'assets/icon.png', 'assets/icon.svg', 'package.json', 'scripts/icon.mjs', 'src/config.ts', 'src/icon.ts', 'src/index.ts', 'src/server.ts', 'tsconfig.json'],
  workers: ['.gitignore', 'README.md', 'assets/icon.png', 'assets/icon.svg', 'package.json', 'scripts/icon.mjs', 'src/guard.ts', 'src/icon.ts', 'src/index.ts', 'src/server.ts', 'tsconfig.json', 'wrangler.jsonc'],
  stdio: ['.gitignore', 'README.md', 'assets/icon.png', 'assets/icon.svg', 'package.json', 'scripts/icon.mjs', 'src/icon.ts', 'src/index.ts', 'src/server.ts', 'tsconfig.json'],
};

const scratch = mkdtempSync(join(tmpdir(), 'mcptc-create-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run `mcp-tc create ...` in this process, with no terminal. */
function create(args, cwd = scratch) {
  return runCli(['create', ...args], { cwd, stdin: NO_TTY });
}

/** Every file under a folder, relative, with forward slashes. */
function listFiles(dir, sub = '') {
  const out = [];
  for (const name of readdirSync(join(dir, sub))) {
    const rel = sub ? `${sub}/${name}` : name;
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(join(dir, rel)).isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** JSONC as wrangler reads it: full-line // comments allowed. */
function parseJsonc(text) {
  return JSON.parse(text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'));
}

// The package's wording rules, applied to every template file and every generated file.
const FORBIDDEN = [
  [/short[\s-]?link/i, 'short link'],
  [/short\s+(url|address)/i, 'short URL / short address'],
  [/popular/i, '"popular"'],
  [/relay/i, 'relay'],
  [/proxy/i, 'proxy'],
  [/tunnel/i, 'tunnel'],
  [/sits between/i, '"sits between"'],
  [/connects via mcp\.tc/i, '"connects via mcp.tc"'],
  [/the link connects/i, '"the link connects"'],
  [/mcp\.tc\/i\//i, 'a listing link (mcp.tc/i/...)'],
  [/anthropic/i, 'the AI vendor'],
  [/\b(seamless(ly)?|unlock|powerful|revolutionary|effortless(ly)?|supercharge[sd]?|game-changing)\b/i, 'hype word'],
  [/[\u2013\u2014]/, 'em or en dash'],
  [/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/, 'invisible or bidi character'],
  // site internals: the private list in the git-ignored .internal-words file, when it is there (see below)
  ...(internalWords(ROOT) || []).map((re) => /** @type {[RegExp, string]} */ ([re, 'site internal (.internal-words)'])),
  [/Bearer\s+(?!\$|error=|\.\.\.|<|token|challenge)[A-Za-z0-9._~+/-]{8,}/, 'a literal bearer token'],
  [/sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}/, 'something that looks like a key'],
];

/** @param {string} text @param {string} where */
function wordingHits(text, where) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of FORBIDDEN) if (re.test(line)) hits.push(`${where}:${i + 1}: ${what}: ${line.trim().slice(0, 100)}`);
  });
  return hits;
}

describe('create: versions', () => {
  it('pins exact versions, one per package, with express at 2.0.2 or later', () => {
    for (const [pkg, v] of Object.entries(VERSIONS)) assert.match(v, /^\d+\.\d+\.\d+$/, `${pkg} must be an exact version`);
    for (const pkg of ['@modelcontextprotocol/server', '@modelcontextprotocol/node', '@modelcontextprotocol/express', 'zod', 'express', 'typescript', 'tsx', 'wrangler']) {
      assert.ok(VERSIONS[pkg], `${pkg} is pinned`);
    }
    const [maj, min, pat] = VERSIONS['@modelcontextprotocol/express'].split('.').map(Number);
    assert.ok(maj > 2 || (maj === 2 && (min > 0 || pat >= 2)), 'expectedResource needs @modelcontextprotocol/express 2.0.2 or later');
    assert.match(TEST_CLIENT_VERSION, /^\d+\.\d+\.\d+$/);
    assert.match(WORKERS_COMPATIBILITY_DATE, /^\d{4}-\d{2}-\d{2}$/);
  });
  it('versions.js keeps one version per line', () => {
    const src = readFileSync(join(ROOT, 'src/lib/versions.js'), 'utf8');
    for (const [pkg, v] of Object.entries(VERSIONS)) {
      const lines = src.split('\n').filter((l) => l.includes(`'${v}'`) && l.includes(pkg.includes('/') || pkg.includes('-') ? `'${pkg}'` : `${pkg}:`));
      assert.equal(lines.length, 1, `${pkg} on exactly one line`);
    }
  });
});

describe('create: package names', () => {
  it('accepts valid npm names', () => {
    for (const n of ['weather-mcp', '@acme/notes-mcp', 'a', 'mcp.server_2', '9lives', '@a1/b2']) assert.deepEqual(packageNameProblems(n), [], n);
  });
  it('refuses names npm would refuse, with a reason', () => {
    for (const n of ['', 'Weather', '.hidden', '_private', 'two words', '@acme', '@acme/', '@/x', 'http', 'fs', 'node_modules', 'favicon.ico', 'x'.repeat(215), '-dash', 'a~b', "it's", '@Acme/x', ' lead', 'a/b']) {
      const p = packageNameProblems(n);
      assert.ok(p.length > 0, `"${n}" should be refused`);
      for (const msg of p) assert.match(msg, /\.$/);
    }
  });
  it('derives the server, folder, title and worker names', () => {
    assert.deepEqual(deriveNames('@acme/notes-mcp'), {
      name: '@acme/notes-mcp', scoped: true, serverName: 'notes-mcp', binName: 'notes-mcp', dirName: 'notes-mcp', title: 'Notes MCP', workerName: 'notes-mcp',
    });
    assert.equal(deriveNames('my_http.api-server').title, 'My HTTP API Server');
    assert.equal(deriveNames('my_http.api-server').workerName, 'my-http-api-server');
    assert.equal(deriveNames(`a${'b'.repeat(80)}`).workerName.length, 63);
  });
});

describe('create: template rendering', () => {
  const vars = { name: 'x', title: 'X' };
  const flags = { a: true, b: false };
  it('fills placeholders and sections', () => {
    assert.equal(renderTemplate('{{name}}-{{title}}', vars, flags), 'x-X');
    assert.equal(renderTemplate('[{{#a}}yes{{/a}}{{^a}}no{{/a}}][{{#b}}yes{{/b}}{{^b}}no{{/b}}]', vars, flags), '[yes][no]');
    assert.equal(renderTemplate('{{#a}}A{{#b}}B{{/b}}{{^b}}c{{/b}}{{/a}}', vars, flags), 'Ac');
  });
  it('drops the line of a tag that stands alone', () => {
    assert.equal(renderTemplate('one\n{{#b}}\ntwo\n{{/b}}\nthree\n', vars, flags), 'one\nthree\n');
    assert.equal(renderTemplate('one\n  {{#a}}\ntwo\n  {{/a}}\nthree\n', vars, flags), 'one\ntwo\nthree\n');
  });
  it('fails loudly on unknown names and broken sections', () => {
    assert.throws(() => renderTemplate('{{nope}}', vars, flags), /nope/);
    assert.throws(() => renderTemplate('{{#zz}}x{{/zz}}', vars, flags), /zz/);
    assert.throws(() => renderTemplate('{{#a}}x', vars, flags), /not closed/);
    assert.throws(() => renderTemplate('x{{/a}}', vars, flags), /closes nothing/);
  });
  it('leaves other braces alone', () => {
    assert.equal(renderTemplate('{"a":{"b":1}} ${x} { {name} }', vars, flags), '{"a":{"b":1}} ${x} { {name} }');
  });
});

describe('create: template files', () => {
  it('gives src/auth.ts only with bearer, and the workers tsconfig to workers', () => {
    const t = (template, auth) => templateFiles({ template, auth }).map((f) => f.target);
    assert.ok(!t('express', 'none').includes('src/auth.ts'));
    assert.ok(t('express', 'bearer').includes('src/auth.ts'));
    assert.ok(t('workers', 'bearer').includes('src/auth.ts'));
    assert.ok(t('stdio', 'none').includes('.gitignore'));
    const ws = templateFiles({ template: 'workers', auth: 'none' }).find((f) => f.target === 'tsconfig.json');
    assert.ok(ws && ws.source.includes(`${join('templates', 'workers')}`));
  });
  it('every template file follows the wording rules', () => {
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (!/\.png$/.test(name)) hits.push(...wordingHits(readFileSync(p, 'utf8'), relative(ROOT, p)));
      }
    };
    walk(TEMPLATES);
    assert.deepEqual(hits, []);
  });
  it('no template file name is one npm leaves out of a package', () => {
    const bad = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (['.gitignore', '.npmignore', '.npmrc', 'package-lock.json', 'node_modules'].includes(name)) bad.push(relative(ROOT, p));
      }
    };
    walk(TEMPLATES);
    assert.deepEqual(bad, []);
  });
});

describe('create: each template and sign-in mode', () => {
  for (const [template, auth] of COMBOS) {
    describe(`${template}, auth ${auth}`, () => {
      const dir = join(scratch, `${template}-${auth}`);
      let res;
      let doc;
      const read = (rel) => readFileSync(join(dir, rel), 'utf8');
      before(async () => {
        res = await create(['weather-mcp', '--template', template, '--auth', auth, '--dir', dir, '--yes', '--json']);
        doc = res.json();
      });
      it('succeeds with one JSON document', () => {
        assert.equal(res.code, 0, res.stderr);
        assert.equal(doc.ok, true);
        assert.equal(doc.command, 'create');
        assert.equal(doc.template, template);
        assert.equal(doc.auth, auth);
        assert.equal(doc.directory, dir);
        assert.equal(res.stderr, '');
      });
      it('writes exactly the expected files', () => {
        const want = [...EXPECTED_FILES[template], ...(auth === 'bearer' ? ['src/auth.ts'] : [])].sort((a, b) => a.localeCompare(b));
        assert.deepEqual(listFiles(dir), want);
        assert.deepEqual([...doc.files].sort((a, b) => a.localeCompare(b)), want);
      });
      it('leaves no placeholder behind', () => {
        for (const f of listFiles(dir)) {
          if (f.endsWith('.png')) continue;
          const text = read(f);
          assert.doesNotMatch(text, /\{\{[#^/]?[A-Za-z]+\}\}/, f);
        }
      });
      it('follows the wording rules and carries no secrets', () => {
        const hits = listFiles(dir).filter((f) => !f.endsWith('.png') && f !== 'src/icon.ts').flatMap((f) => wordingHits(read(f), f));
        assert.deepEqual(hits, []);
      });
      it('writes package.json with exact pinned versions', () => {
        const pkg = JSON.parse(read('package.json'));
        assert.equal(pkg.name, 'weather-mcp');
        assert.equal(pkg.version, '0.1.0');
        assert.equal(pkg.type, 'module');
        const all = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [name, v] of Object.entries(all)) assert.equal(v, VERSIONS[name], `${name} pinned`);
        assert.equal(pkg.dependencies['@modelcontextprotocol/server'], VERSIONS['@modelcontextprotocol/server']);
        assert.equal(pkg.dependencies.zod, VERSIONS.zod);
        if (template === 'express') {
          for (const d of ['@modelcontextprotocol/express', '@modelcontextprotocol/node', 'express']) assert.ok(pkg.dependencies[d], d);
          assert.equal(pkg.private, true);
          assert.equal(pkg.engines.node, '>=20');
          assert.equal(pkg.scripts.start, 'node dist/index.js');
        }
        if (template === 'workers') {
          assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@modelcontextprotocol/server', 'zod']);
          assert.ok(pkg.devDependencies.wrangler);
          assert.equal(pkg.engines.node, '>=22');
          assert.equal(pkg.scripts.deploy, 'wrangler deploy');
        }
        if (template === 'stdio') {
          assert.deepEqual(pkg.bin, { 'weather-mcp': 'dist/index.js' });
          assert.deepEqual(pkg.files, ['dist']);
          assert.equal(pkg.private, undefined);
          assert.equal(pkg.scripts.prepublishOnly, 'npm run build');
          assert.equal(pkg.license, undefined, 'the author picks the license');
        }
        assert.equal(pkg.scripts.icon, 'node scripts/icon.mjs');
      });
      it('writes valid tsconfig.json (and wrangler.jsonc for workers)', () => {
        const ts = JSON.parse(read('tsconfig.json'));
        assert.equal(ts.compilerOptions.strict, true);
        if (template === 'workers') {
          assert.equal(ts.compilerOptions.noEmit, true);
          const w = parseJsonc(read('wrangler.jsonc'));
          assert.equal(w.name, 'weather-mcp');
          assert.equal(w.main, 'src/index.ts');
          assert.equal(w.compatibility_date, WORKERS_COMPATIBILITY_DATE);
          assert.deepEqual(w.dev, { ip: '127.0.0.1', port: 8787 });
          assert.equal(w.vars.ALLOWED_HOSTS, '');
          assert.equal('MCP_SERVER_URL' in w.vars, auth === 'bearer');
          assert.equal('DEV_ACCESS_TOKEN' in w.vars, false, 'secrets stay out of wrangler.jsonc');
        } else {
          assert.deepEqual(ts.compilerOptions.types, ['node']);
          assert.equal(ts.compilerOptions.outDir, 'dist');
        }
      });
      it('fills serverInfo and one read-only example tool with all four annotations', () => {
        const s = read('src/server.ts');
        assert.match(s, /name: 'weather-mcp'/);
        assert.match(s, /title: 'Weather MCP'/);
        assert.match(s, /icons: \[ICON\]/);
        assert.match(s, /registerTool\(\s*'http_status'/);
        assert.match(s, /readOnlyHint: true/);
        assert.match(s, /destructiveHint: false/);
        assert.match(s, /idempotentHint: true/);
        assert.match(s, /openWorldHint: false/);
        assert.match(s, /outputSchema/);
        assert.match(s, /description:\s*\n?\s*'Look up/);
      });
      it('embeds the PNG icon as a data URI', () => {
        const icon = read('src/icon.ts');
        const m = /src: 'data:image\/png;base64,([A-Za-z0-9+/=]+)'/.exec(icon);
        assert.ok(m, 'data URI');
        assert.deepEqual(Buffer.from(m[1], 'base64'), readFileSync(join(dir, 'assets/icon.png')));
        assert.match(icon, /sizes: \['128x128'\]/);
        assert.match(read('assets/icon.svg'), /<title>Weather MCP<\/title>/);
      });
      it('writes the entry point for its kind', () => {
        const idx = read('src/index.ts');
        if (template === 'express') {
          assert.match(idx, /createMcpHandler\(buildServer\)/);
          assert.match(idx, /createMcpExpressApp\(\{\s*host: HOST,[\s\S]*allowedHosts: ALLOWED_HOSTS/);
          assert.match(idx, /app\.all\('\/mcp'/);
          assert.doesNotMatch(idx, /sessionIdGenerator|Mcp-Session-Id/);
        }
        if (template === 'workers') {
          assert.match(idx, /export default \{/);
          assert.match(idx, /checkHostAndOrigin\(request, env\)/);
          assert.match(idx, /handler\.fetch\(request/);
          const guard = read('src/guard.ts');
          assert.match(guard, /headers\.get\('host'\)/);
          assert.match(guard, /headers\.get\('origin'\)/);
          assert.match(guard, /status: 403/);
          assert.doesNotMatch(guard, /hostHeaderValidationResponse|originValidationResponse/, 'written by hand');
        }
        if (template === 'stdio') {
          assert.ok(idx.startsWith('#!/usr/bin/env node\n'));
          assert.match(idx, /serveStdio\(buildServer\)/);
          assert.doesNotMatch(read('src/server.ts'), /console\.log/);
        }
      });
      if (auth === 'bearer') {
        it('adds the bearer gate with expectedResource and RFC 9728 metadata', () => {
          const all = read('src/index.ts') + read('src/auth.ts');
          assert.match(all, /requireBearerAuth\(\{[\s\S]*expectedResource:/);
          assert.match(all, /getOAuthProtectedResourceMetadataUrl/);
          assert.match(all, template === 'express' ? /mcpAuthMetadataRouter\(authMetadata\)/ : /oauthMetadataResponse\(request, auth\.metadata\)/);
          assert.match(all, /RFC 9728/);
          assert.match(all, /RFC 8707/);
          assert.match(all, /OAuthErrorCode\.InvalidToken/);
          assert.match(all, /Fill in/);
          assert.doesNotMatch(all, /authorize\(|issueToken|mcpAuthRouter|ProxyOAuth/i, 'no authorization server');
        });
      }
      it('writes a README with how to run, test and get listed', () => {
        const md = read('README.md');
        assert.match(md, /^# Weather MCP\n/);
        assert.match(md, /<!-- Badge: .*npx mcp-tc badge <slug>/);
        for (const want of ['npm install', 'npx mcp-tc check', 'npx mcp-tc submit', 'https://mcp.tc/submit', 'npx mcp-tc badge', 'npx mcp-tc card', 'https://mcp.tc/verify', 'npx mcp-tc dns-check', 'an AI model', 'not a security review', 'npm run icon']) {
          assert.ok(md.includes(want), `README mentions ${want}`);
        }
        if (template !== 'stdio') {
          assert.match(md, /`npx mcp-tc check \. --url http:\/\/127\.0\.0\.1:(3000|8787)\/mcp`/);
          assert.match(md, /`npx mcp-tc check https:\/\/mcp\.example\.com\/mcp`/);
          assert.match(md, /`npx mcp-tc submit https:\/\/mcp\.example\.com\/mcp`/);
          assert.match(md, /curl -s -X POST http:\/\/127\.0\.0\.1:(3000|8787)\/mcp/);
          assert.match(md, /sed -n 's\/\^data: \/\/p'/);
          assert.match(md, /event: message/);
          assert.match(md, /MCP-Protocol-Version: 2026-07-28/);
          assert.match(md, /Customize → Connectors/);
        } else {
          assert.match(md, /`npm run build`, then `npx mcp-tc check \. --stdio`/);
          assert.match(md, /`npx mcp-tc submit npm:weather-mcp`/);
          assert.match(md, /npx -y weather-mcp/);
          assert.match(md, /mcpName/);
          assert.match(md, /inspector node dist\/index\.js/);
        }
        assert.equal(/Authorization: Bearer \$DEV_ACCESS_TOKEN/.test(md), auth === 'bearer');
        assert.equal(/## Sign-in/.test(md), auth === 'bearer');
        assert.equal(/Wrangler|wrangler/.test(md), template === 'workers');
      });
      it('uses only commands and options that mcp-tc has', async () => {
        const uses = [...read('README.md').matchAll(/npx mcp-tc ([a-z-]+)((?: (?:[^`\n\\]|\\\n)*)?)/g)];
        assert.ok(uses.length >= 5);
        for (const [line, name, rest] of uses) {
          const mod = await loadCommand(name);
          assert.ok(mod, `${line}: no command "${name}"`);
          const known = new Set([...Object.keys(mod.meta.options || {}), ...Object.keys(GLOBAL_OPTIONS)]);
          for (const [, flag] of rest.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)) assert.ok(known.has(flag), `${line}: ${name} has no --${flag}`);
        }
      });
      it('ignores build output, secrets and dependencies in git', () => {
        const gi = read('.gitignore').split('\n');
        for (const want of ['node_modules/', 'dist/', '.env']) assert.ok(gi.includes(want), want);
        assert.equal(gi.includes('.dev.vars'), template === 'workers');
      });
    });
  }
});

describe('create: arguments and folders', () => {
  it('defaults to express without sign-in, in a folder named after the package', async () => {
    const cwd = mkdtempSync(join(scratch, 'cwd-'));
    const res = await create(['@acme/notes-mcp', '--yes', '--json'], cwd);
    assert.equal(res.code, 0, res.stderr);
    const doc = res.json();
    assert.equal(doc.template, 'express');
    assert.equal(doc.auth, 'none');
    assert.equal(doc.directory, join(cwd, 'notes-mcp'));
    assert.equal(JSON.parse(readFileSync(join(cwd, 'notes-mcp', 'package.json'), 'utf8')).name, '@acme/notes-mcp');
    assert.deepEqual(doc.next_steps.slice(0, 3), ['cd notes-mcp', 'npm install', 'npm run dev']);
    assert.equal(doc.local_url, 'http://127.0.0.1:3000/mcp');
    assert.deepEqual(Object.keys(doc.sdk).sort(), ['@modelcontextprotocol/express', '@modelcontextprotocol/node', '@modelcontextprotocol/server']);
  });
  it('uses an existing empty folder, and "." for the current one', async () => {
    const cwd = mkdtempSync(join(scratch, 'empty-'));
    const res = await create(['here-mcp', '--template', 'stdio', '--dir', '.', '--yes', '--json'], cwd);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(existsSync(join(cwd, 'package.json')));
    assert.equal(res.json().next_steps[0], 'npm install');
    assert.equal(res.json().check_command, 'npx mcp-tc check . --stdio');
  });
  it('refuses a folder that is not empty and writes nothing', async () => {
    const cwd = mkdtempSync(join(scratch, 'full-'));
    writeFileSync(join(cwd, 'keep.txt'), 'mine');
    const res = await create(['x-mcp', '--dir', '.', '--yes', '--json'], cwd);
    assert.equal(res.code, 2);
    assert.equal(res.json().error.code, 'directory_not_empty');
    assert.deepEqual(readdirSync(cwd), ['keep.txt']);
  });
  it('refuses a path that is a file', async () => {
    const cwd = mkdtempSync(join(scratch, 'file-'));
    writeFileSync(join(cwd, 'taken'), '');
    const res = await create(['x-mcp', '--dir', 'taken', '--yes', '--json'], cwd);
    assert.equal(res.code, 2);
    assert.equal(res.json().error.code, 'not_a_directory');
  });
  it('reports a folder it cannot create, and leaves nothing behind', async () => {
    const cwd = mkdtempSync(join(scratch, 'blocked-'));
    writeFileSync(join(cwd, 'file'), '');
    const res = await create(['x-mcp', '--dir', 'file/x', '--yes', '--json'], cwd);
    assert.equal(res.code, 1);
    assert.equal(res.json().error.code, 'write_failed');
    assert.deepEqual(readdirSync(cwd), ['file']);
    // a project under new parent folders creates them all
    const deep = await create(['y-mcp', '--dir', 'a/b/c', '--yes', '--json'], cwd);
    assert.equal(deep.code, 0, deep.stderr);
    assert.ok(existsSync(join(cwd, 'a/b/c/package.json')));
  });
  it('after a failure in a folder that existed, removes only what it wrote', () => {
    const dir = mkdtempSync(join(scratch, 'undo-'));
    mkdirSync(join(dir, 'src/deep'), { recursive: true });
    mkdirSync(join(dir, 'keep'));
    writeFileSync(join(dir, 'src/deep/a.ts'), '');
    writeFileSync(join(dir, 'src/b.ts'), '');
    writeFileSync(join(dir, 'keep/mine.txt'), '');
    removeWritten(dir, ['src/deep/a.ts', 'src/b.ts', 'keep/never-written.txt']);
    assert.deepEqual(listFiles(dir), ['keep/mine.txt']);
    assert.ok(!existsSync(join(dir, 'src')));
  });
  it('refuses an invalid package name with the reasons', async () => {
    const res = await create(['My Server', '--yes', '--json']);
    assert.equal(res.code, 2);
    const err = res.json().error;
    assert.equal(err.code, 'invalid_name');
    assert.ok(err.problems.length >= 2);
  });
  it('refuses --auth bearer for stdio', async () => {
    const res = await create(['x-mcp', '--template', 'stdio', '--auth', 'bearer', '--dir', join(scratch, 'never'), '--yes', '--json']);
    assert.equal(res.code, 2);
    assert.equal(res.json().error.code, 'auth_not_supported');
    assert.ok(!existsSync(join(scratch, 'never')));
  });
  it('refuses an unknown template or auth', async () => {
    assert.equal((await create(['x-mcp', '--template', 'deno', '--yes'])).code, 2);
    assert.equal((await create(['x-mcp', '--auth', 'oauth', '--yes'])).code, 2);
    assert.equal((await create(['--yes'])).code, 2);
  });
  it('without a terminal and without --yes, uses the defaults instead of asking', async () => {
    const dir = join(scratch, 'quiet');
    const res = await create(['quiet-mcp', '--dir', dir, '--json']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json().template, 'express');
  });
  it('prints files and next steps for people, without colors', async () => {
    const dir = join(scratch, 'human');
    const res = await create(['human-mcp', '--template', 'workers', '--auth', 'bearer', '--dir', dir]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^Created human-mcp in /);
    assert.match(res.stdout, /Template\s+workers \(Streamable HTTP on Cloudflare Workers\)/);
    assert.match(res.stdout, /Files:\n {2}\.gitignore\n/);
    assert.match(res.stdout, /Next steps:\n[\s\S]*npm install[\s\S]*\.dev\.vars[\s\S]*npm run dev/);
    assert.match(res.stdout, /npx mcp-tc check http:\/\/127\.0\.0\.1:8787\/mcp/);
    assert.doesNotMatch(res.stdout, /\u001b\[/);
  });
  it('has help', async () => {
    const res = await runCli(['help', 'create']);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Usage: mcp-tc create <name>/);
    assert.match(res.stdout, /--template <kind>/);
    assert.match(res.stdout, /--auth <mode>/);
  });
});

describe('create: questions in a terminal', () => {
  const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false });
  /** Run main() with a fake terminal that answers each question as it appears. */
  async function answering(argv, answers) {
    const stdin = tty();
    const stderr = Object.assign(new PassThrough(), { isTTY: false });
    let seen = '';
    const queue = [...answers];
    stderr.on('data', (d) => {
      seen += d;
      if (queue.length && seen.includes(queue[0][0])) {
        const [prompt, answer] = queue.shift();
        seen = seen.slice(seen.indexOf(prompt) + prompt.length);
        setImmediate(() => stdin.write(answer));
      }
    });
    let stdout = '';
    const code = await main(argv, { stdin, stderr, stdout: { isTTY: false, write: (s) => ((stdout += s), true) }, env: { PATH: process.env.PATH }, cwd: scratch });
    return { code, stdout, seen };
  }
  it('asks for the template and sign-in that were not given', async () => {
    const dir = join(scratch, 'asked');
    const res = await answering(['create', 'asked-mcp', '--dir', dir], [['Template', 'workers\n'], ['Sign-in', 'bearer\n']]);
    assert.equal(res.code, 0);
    assert.ok(existsSync(join(dir, 'wrangler.jsonc')));
    assert.ok(existsSync(join(dir, 'src/auth.ts')));
  });
  it('takes the default on an empty answer and does not ask about sign-in for stdio', async () => {
    const dir = join(scratch, 'asked-stdio');
    const res = await answering(['create', 'asked2-mcp', '--dir', dir], [['Template', 'stdio\n']]);
    assert.equal(res.code, 0);
    assert.ok(!res.seen.includes('Sign-in'));
    const dir2 = join(scratch, 'asked-default');
    const res2 = await answering(['create', 'asked3-mcp', '--dir', dir2], [['Template', '\n'], ['Sign-in', '\n']]);
    assert.equal(res2.code, 0);
    assert.ok(existsSync(join(dir2, 'src/config.ts')));
    assert.ok(!existsSync(join(dir2, 'src/auth.ts')));
  });
  it('gives up after three answers it cannot use', async () => {
    const res = await answering(['create', 'asked4-mcp', '--dir', join(scratch, 'asked-bad')], [['Template', 'x\n'], ['Template', 'y\n'], ['Template', 'z\n']]);
    assert.equal(res.code, 2);
    assert.ok(!existsSync(join(scratch, 'asked-bad')));
  });
});

describe('create: review fixes', () => {
  const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, isRaw: false });
  /** main() with a fake terminal; `keys` is written once the first question appears (null: never). */
  async function inTerminal(argv, keys, cwd = scratch) {
    const stdin = tty();
    const stderr = Object.assign(new PassThrough(), { isTTY: false });
    let seen = '';
    let sent = false;
    stderr.on('data', (d) => {
      seen += d;
      if (keys !== null && !sent && /\]:\s*$/.test(seen)) {
        sent = true;
        setImmediate(() => stdin.write(keys));
      }
    });
    let stdout = '';
    const code = await main(argv, { stdin, stderr, stdout: { isTTY: false, write: (t) => ((stdout += t), true) }, env: { PATH: process.env.PATH }, cwd });
    return { code, stdout, seen };
  }

  it('ux-create-prompts-before-folder-check: a folder that is not empty is refused before any question', async () => {
    const cwd = mkdtempSync(join(scratch, 'ask-full-'));
    writeFileSync(join(cwd, 'keep.txt'), 'mine');
    const r = await inTerminal(['create', 'x-mcp', '--dir', '.'], null, cwd);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.seen, /Template|Sign-in/);
    assert.match(r.seen, /is not empty/);
    const file = mkdtempSync(join(scratch, 'ask-file-'));
    writeFileSync(join(file, 'taken'), '');
    const f = await inTerminal(['create', 'x-mcp', '--dir', 'taken'], null, file);
    assert.equal(f.code, 2);
    assert.doesNotMatch(f.seen, /Template/);
  });

  it('ux-prompt-ctrl-c-exit-0: Ctrl+C at a question ends with exit 130, Ctrl+D with exit 1, and nothing is written', async () => {
    const c = await inTerminal(['create', 'cc-mcp', '--dir', join(scratch, 'ctrl-c')], '\u0003');
    assert.equal(c.code, 130);
    assert.match(c.seen, /Error: Cancelled\./);
    assert.ok(!existsSync(join(scratch, 'ctrl-c')));
    const d = await inTerminal(['create', 'cd-mcp', '--dir', join(scratch, 'ctrl-d')], '\u0004');
    assert.equal(d.code, 1);
    assert.ok(!existsSync(join(scratch, 'ctrl-d')));
  });

  it('ux-create-posix-only-steps: PowerShell steps on Windows, POSIX ones elsewhere, no openssl anywhere', async () => {
    const win = await runCli(['create', 'win-mcp', '--template', 'workers', '--auth', 'bearer', '--dir', join(scratch, 'win dir'), '--yes', '--json'], { cwd: scratch, platform: 'win32', stdin: NO_TTY });
    assert.equal(win.code, 0, win.stderr);
    const w = win.json();
    assert.equal(w.shell, 'powershell');
    assert.deepEqual(w.next_steps, [
      "cd 'win dir'",
      'npm install',
      `$env:DEV_ACCESS_TOKEN = node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`,
      '"DEV_MODE=1", "DEV_ACCESS_TOKEN=$env:DEV_ACCESS_TOKEN" | Out-File -Encoding ascii .dev.vars',
      'npm run dev',
    ]);
    const human = await runCli(['create', 'win2-mcp', '--template', 'express', '--auth', 'bearer', '--dir', join(scratch, 'win2'), '--yes'], { cwd: scratch, platform: 'win32', stdin: NO_TTY });
    assert.match(human.stdout, /Next steps \(PowerShell\):\n {2}cd win2\n {2}npm install\n {2}\$env:DEV_ACCESS_TOKEN = node -e/);
    assert.doesNotMatch(human.stdout, /export |openssl/);
    const posix = await runCli(['create', 'nix-mcp', '--template', 'workers', '--auth', 'bearer', '--dir', join(scratch, 'nix'), '--yes', '--json'], { cwd: scratch, platform: 'linux', stdin: NO_TTY });
    const p = posix.json();
    assert.equal(p.shell, 'posix');
    assert.deepEqual(p.next_steps.slice(2, 4), [
      `export DEV_ACCESS_TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")`,
      `printf 'DEV_MODE=1\\nDEV_ACCESS_TOKEN=%s\\n' "$DEV_ACCESS_TOKEN" > .dev.vars`,
    ]);
    for (const [template, auth] of COMBOS) {
      const files = await buildProject('weather-mcp', { template, auth });
      for (const [name, text] of files) if (typeof text === 'string') assert.doesNotMatch(text, /openssl/, `${template}-${auth} ${name}`);
      const md = String(files.get('README.md'));
      assert.equal(md.includes('```powershell'), auth === 'bearer', `${template}-${auth}: a PowerShell block for the token`);
      if (template !== 'stdio') assert.match(md, /These examples are for a POSIX shell: macOS, Linux, or Git Bash or WSL on Windows\./);
    }
  });

  it('create-5: the closing line names what the README of that template has', async () => {
    const stdio = await create(['closing-stdio', '--template', 'stdio', '--dir', join(scratch, 'closing-stdio'), '--yes']);
    assert.equal(stdio.code, 0, stdio.stderr);
    assert.match(stdio.stdout, /README\.md has the Inspector steps, client setup, publishing to npm, and the steps to get listed on mcp\.tc\.\n$/);
    assert.doesNotMatch(stdio.stdout, /curl/);
    const md = readFileSync(join(scratch, 'closing-stdio', 'README.md'), 'utf8');
    assert.doesNotMatch(md, /curl|## Settings/);
    const remote = await create(['closing-express', '--dir', join(scratch, 'closing-express'), '--yes']);
    assert.match(remote.stdout, /README\.md has curl tests, settings, and the steps to get listed on mcp\.tc\.\n$/);
  });

  it('create-1: the express development token works only on a server that only this machine can reach', async () => {
    const files = await buildProject('weather-mcp', { template: 'express', auth: 'bearer' });
    const config = String(files.get('src/config.ts'));
    const index = String(files.get('src/index.ts'));
    const auth = String(files.get('src/auth.ts'));
    assert.match(config, /export const DEV_TOKEN_ACTIVE =\s*DEV_ACCESS_TOKEN !== '' && LISTENS_LOCALLY && ALLOWED_HOSTS\.length === 0 && LOCAL_HOSTS\.includes\(MCP_SERVER_URL\.hostname\);/);
    assert.match(config, /export const MCP_SERVER_URL_SET = /);
    assert.match(auth, /if \(DEV_TOKEN_ACTIVE && sameText\(token, DEV_ACCESS_TOKEN\)\)/);
    assert.match(index, /if \(\(!LISTENS_LOCALLY \|\| ALLOWED_HOSTS\.length > 0\) && !MCP_SERVER_URL_SET\) \{[\s\S]*?process\.exit\(1\);/);
    assert.match(index, /if \(DEV_ACCESS_TOKEN && !DEV_TOKEN_ACTIVE\) \{[\s\S]*?process\.exit\(1\);/);
  });

  it('create-2: the workers development token needs DEV_MODE=1 and a request to localhost; no deployed localhost default', async () => {
    const files = await buildProject('weather-mcp', { template: 'workers', auth: 'bearer' });
    const wrangler = parseJsonc(String(files.get('wrangler.jsonc')));
    assert.equal(wrangler.vars.MCP_SERVER_URL, '', 'wrangler.jsonc ships no MCP_SERVER_URL that a deploy would upload');
    const auth = String(files.get('src/auth.ts'));
    assert.match(auth, /const devToken = local && settings\.DEV_MODE === '1' && settings\.DEV_ACCESS_TOKEN \? settings\.DEV_ACCESS_TOKEN : '';/);
    assert.match(auth, /if \(!local && LOCAL_HOSTS\.includes\(serverUrl\.hostname\)\) \{\s*return misconfigured\(/);
    assert.match(String(files.get('src/index.ts')), /authFor\(env, isLocalRequest\(request\)\)/);
    assert.match(String(files.get('src/guard.ts')), /export function isLocalRequest\(request: Request\): boolean/);
    const md = String(files.get('README.md'));
    assert.match(md, /Never put them on Cloudflare: don't run\s+`npx wrangler secret put` for them, or `npx wrangler secret bulk \.dev\.vars`\./);
    assert.match(md, /until it is set, the deployed worker answers 500/);
  });

  it('create-3: both remote templates answer a browser preflight before sign-in and add CORS headers for allowed origins', async () => {
    for (const auth of ['none', 'bearer']) {
      const ex = await buildProject('weather-mcp', { template: 'express', auth });
      const idx = String(ex.get('src/index.ts'));
      const corsAt = idx.indexOf("app.use('/mcp', (req: Request, res: Response, next: NextFunction)");
      assert.ok(corsAt > 0, 'express: a CORS middleware on /mcp');
      assert.ok(corsAt < idx.indexOf("app.all('/mcp'"), 'express: before the /mcp route and its sign-in check');
      assert.match(idx, /'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': EXPOSE_HEADERS/);
      assert.match(idx, /if \(req\.method === 'OPTIONS'\) \{\s*res\.status\(204\)\.end\(\);/);
      assert.match(idx, /const EXPOSE_HEADERS = 'WWW-Authenticate, MCP-Protocol-Version';/);
      assert.match(String(ex.get('src/config.ts')), /export const BROWSER_ORIGINS =/);
      const wk = await buildProject('weather-mcp', { template: 'workers', auth });
      const widx = String(wk.get('src/index.ts'));
      assert.match(widx, /if \(request\.method === 'OPTIONS'\) return preflight\(request\);\s*return withCors\(request, await route\(request, env\)\);/);
      assert.ok(widx.indexOf('preflight(request)') < (widx.indexOf('auth.gate') === -1 ? Infinity : widx.indexOf('auth.gate')));
      for (const md of [String(ex.get('README.md')), String(wk.get('README.md'))]) assert.match(md, /CORS headers/);
    }
  });
});

describe('create: the icon script in the generated project', () => {
  it('rewrites src/icon.ts from assets/icon.png, and refuses what is not an image', async () => {
    const dir = join(scratch, 'icon-run');
    assert.equal((await create(['icon-mcp', '--template', 'stdio', '--dir', dir, '--yes', '--json'])).code, 0);
    const before = readFileSync(join(dir, 'src/icon.ts'), 'utf8');
    writeFileSync(join(dir, 'src/icon.ts'), '// changed\n');
    const ok = await run(process.execPath, ['scripts/icon.mjs'], { cwd: dir });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(readFileSync(join(dir, 'src/icon.ts'), 'utf8'), before);
    writeFileSync(join(dir, 'assets/not.png'), 'hello');
    const bad = await run(process.execPath, ['scripts/icon.mjs', 'assets/not.png'], { cwd: dir });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /PNG, WebP or JPEG/);
  });
  it('reads PNG sizes and knows JPEG and WebP', async () => {
    const { imageInfo, iconModule } = await import(new URL('../templates/shared/scripts/icon.mjs', import.meta.url).href);
    assert.deepEqual(imageInfo(readFileSync(join(TEMPLATES, 'shared/assets/icon.png'))), { mimeType: 'image/png', width: 128, height: 128 });
    assert.deepEqual(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), { mimeType: 'image/jpeg' });
    assert.deepEqual(imageInfo(Buffer.from('RIFF0000WEBPVP8 ', 'latin1')), { mimeType: 'image/webp' });
    assert.equal(imageInfo(Buffer.from('<svg/>')), null);
    assert.throws(() => iconModule(Buffer.concat([readFileSync(join(TEMPLATES, 'shared/assets/icon.png')), Buffer.alloc(200 * 1024)])), /Keep it under/);
  });
  it('buildProject and packageJson agree with what create writes', async () => {
    const files = await buildProject('agree-mcp', { template: 'express', auth: 'bearer' });
    assert.ok(files.has('src/auth.ts'));
    assert.equal(files.get('package.json'), packageJson({ template: 'express', auth: 'bearer' }, deriveNames('agree-mcp')));
  });
});

/** Run a program; never throws. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout || 300_000, ...opts, env: { ...process.env, ...(opts.env || {}) } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Slow: real installs from the npm registry, real servers, the official client. MCPTC_SLOW=1 npm test

const SLOW = process.env.MCPTC_SLOW === '1';

/** A free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

/** Resolves once something listens on the port, or rejects after `ms`. */
function waitForPort(port, ms = 20_000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = netConnect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve(undefined);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > until) reject(new Error(`nothing listens on ${port}`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

/** Start a long-running process in its own process group, so stop() ends its children too. */
function startProcess(cmd, args, opts) {
  const proc = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    proc,
    exited,
    output: () => output,
    async stop(signal = 'SIGTERM') {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          process.kill(-proc.pid, signal);
        } catch {
          // already gone
        }
      }
      const t = setTimeout(() => {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, 5000);
      const r = await exited;
      clearTimeout(t);
      return r;
    },
  };
}

/**
 * One HTTP request with full control of the headers (Host included). A fresh connection each time, and the body with
 * a Content-Length: a server that refuses a request before reading a chunked body can leave the connection unusable.
 */
function http(port, { method = 'POST', path = '/mcp', headers = {}, body } = {}) {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const length = data === undefined ? {} : { 'content-length': String(Buffer.byteLength(data)) };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, agent: false, headers: { connection: 'close', ...length, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

/** The JSON-RPC message in a reply that is either JSON or one SSE message event. */
function rpc(body) {
  const data = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : body);
}

const DRIVER = `// Talks to a server with the official MCP client, in each protocol mode, and prints what it saw as JSON.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const spec = JSON.parse(process.argv[2]);
const out = [];
for (const mode of spec.modes) {
  const client = new Client({ name: 'mcp-tc-create-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = spec.url
    ? new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers || {} } })
    : new StdioClientTransport({ command: spec.command, args: spec.args, stderr: 'ignore' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const call = await client.callTool({ name: 'http_status', arguments: { code: 404 } });
  const unknown = await client.callTool({ name: 'http_status', arguments: { code: 299 } });
  out.push({ mode, protocol: client.getNegotiatedProtocolVersion(), server: client.getServerVersion(), instructions: client.getInstructions(), tools, call, unknown });
  await client.close();
}
console.log(JSON.stringify(out));
`;

const WORKER_RUNNER = `// Serves a Workers template's default export on node:http, the way workerd would call it.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { tsImport } from 'tsx/esm/api';
const [entry, envJson, port] = process.argv.slice(2);
const mod = await tsImport(pathToFileURL(entry).href, import.meta.url);
const env = JSON.parse(envJson);
createServer(toNodeHandler({ fetch: (request) => mod.default.fetch(request, env) })).listen(Number(port), '127.0.0.1', () => console.error('ready'));
`;

const AUDIENCE_CHECK = `// Does the installed @modelcontextprotocol/express pass expectedResource on? (2.0.1 did not.)
import { requireBearerAuth } from '@modelcontextprotocol/express';
const want = new URL('https://mcp.example.com/mcp');
async function attempt(resource) {
  const mw = requireBearerAuth({
    verifier: { async verifyAccessToken(token) { return { token, clientId: 'c', scopes: ['mcp'], expiresAt: Math.floor(Date.now() / 1000) + 60, resource }; } },
    requiredScopes: ['mcp'],
    expectedResource: want,
  });
  return new Promise((resolve) => {
    const res = { set() { return res; }, status(code) { res.code = code; return res; }, json() { resolve(res.code); } };
    mw({ headers: { authorization: 'Bearer abc' } }, res, () => resolve('next'));
  });
}
console.log(JSON.stringify({ other: await attempt(new URL('https://other.example/mcp')), same: await attempt(want), none: await attempt(undefined) }));
`;

/** Check what the official client saw. */
function assertClientRun(runs, { modern = true } = {}) {
  assert.ok(runs.length >= 2);
  for (const r of runs) {
    assert.equal(r.server.name, 'weather-mcp');
    assert.equal(r.server.title, 'Weather MCP');
    assert.equal(r.server.version, '0.1.0');
    assert.match(r.server.description, /HTTP status codes/);
    assert.match(r.server.icons[0].src, /^data:image\/png;base64,/);
    assert.match(r.instructions, /http_status/);
    assert.equal(r.tools.length, 1);
    const t = r.tools[0];
    assert.equal(t.name, 'http_status');
    assert.match(t.description, /^Look up the standard name and meaning of an HTTP status code/);
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(t.inputSchema.properties.code.type, 'integer');
    assert.deepEqual(t.inputSchema.required, ['code']);
    assert.ok(t.outputSchema);
    assert.deepEqual(r.call.structuredContent, { code: 404, name: 'Not Found', meaning: 'The server cannot find the requested resource.' });
    assert.equal(r.unknown.isError, true);
  }
  assert.equal(runs.find((r) => r.mode === 'legacy').protocol, '2025-11-25');
  if (modern) assert.equal(runs.find((r) => typeof r.mode === 'object').protocol, '2026-07-28');
}

/** The ```bash blocks of a README that POST to the local endpoint. */
function readmeCurls(md) {
  return [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter((b) => b.startsWith('curl') && b.includes('http://127.0.0.1:'));
}

describe('create: install the pinned SDK and talk to each template (MCPTC_SLOW=1)', { skip: SLOW ? false : 'set MCPTC_SLOW=1 to run it (it installs from the npm registry)', timeout: 900_000 }, () => {
  const base = mkdtempSync(join(tmpdir(), 'mcptc-create-slow-'));
  const tools = join(base, 'tools');
  const proj = (k) => join(base, k);
  const npmEnv = { npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false', npm_config_loglevel: 'error' };
  const npm = (args, cwd) => run('npm', args, { cwd, env: npmEnv, timeout: 300_000 });
  const running = [];
  let hasCurl = false;

  before(async () => {
    mkdirSync(tools);
    writeFileSync(join(tools, 'package.json'), JSON.stringify({ name: 'tools', private: true, type: 'module', dependencies: { '@modelcontextprotocol/client': TEST_CLIENT_VERSION } }));
    writeFileSync(join(tools, 'drive.mjs'), DRIVER);
    const r = await npm(['install'], tools);
    assert.equal(r.code, 0, r.stderr);
    for (const [template, auth] of COMBOS) {
      const res = await create(['weather-mcp', '--template', template, '--auth', auth, '--dir', proj(`${template}-${auth}`), '--yes', '--json'], base);
      assert.equal(res.code, 0, res.stderr);
    }
    hasCurl = (await run('curl', ['--version'])).code === 0;
  });
  after(async () => {
    for (const p of running) await p.stop();
    rmSync(base, { recursive: true, force: true });
  });

  /** Run the official client against a server. */
  async function drive(spec) {
    const r = await run(process.execPath, [join(tools, 'drive.mjs'), JSON.stringify(spec)], { cwd: tools, timeout: 60_000 });
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  }

  /** Run the README's curl blocks against a port; returns their outputs in order. */
  async function curls(dir, port, env = {}) {
    if (!hasCurl) return null;
    const outs = [];
    for (const block of readmeCurls(readFileSync(join(dir, 'README.md'), 'utf8'))) {
      const cmd = block.replace(/http:\/\/127\.0\.0\.1:\d+\//g, `http://127.0.0.1:${port}/`);
      const r = await run('bash', ['-c', cmd], { env, timeout: 30_000 });
      assert.equal(r.code, 0, `${cmd}\n${r.stderr}`);
      outs.push(r.stdout);
    }
    return outs;
  }

  /** Start a Node server for a project and wait until it listens. */
  async function startNode(dir, entry, env) {
    const port = await freePort();
    const p = startProcess(process.execPath, [entry], { cwd: dir, env: { PORT: String(port), ...env } });
    running.push(p);
    try {
      await waitForPort(port);
    } catch (err) {
      throw new Error(`${err.message}\n${p.output()}`);
    }
    return { port, p };
  }

  describe('express, no sign-in', () => {
    const dir = proj('express-none');
    let port;
    it('installs the pinned versions and builds with tsc', async () => {
      const i = await npm(['install'], dir);
      assert.equal(i.code, 0, i.stderr);
      const installed = JSON.parse(readFileSync(join(dir, 'node_modules/@modelcontextprotocol/express/package.json'), 'utf8')).version;
      assert.equal(installed, VERSIONS['@modelcontextprotocol/express']);
      const b = await npm(['run', 'build'], dir);
      assert.equal(b.code, 0, b.stdout + b.stderr);
      assert.ok(existsSync(join(dir, 'dist/index.js')));
    });
    it('serves both protocol eras to the official client', async () => {
      ({ port } = await startNode(dir, 'dist/index.js', {}));
      assertClientRun(await drive({ url: `http://127.0.0.1:${port}/mcp`, modes: ['legacy', { pin: '2026-07-28' }, 'auto'] }));
    });
    it('answers the README curl commands as the README says', async (t) => {
      const outs = await curls(dir, port);
      if (!outs) return t.skip('curl is not installed');
      assert.equal(outs.length, 4);
      assert.match(outs[0], /^event: message\ndata: \{"result":\{"tools":\[\{"name":"http_status"/);
      assert.equal(JSON.parse(outs[1]).result.structuredContent.name, 'Not Found');
      assert.equal(JSON.parse(outs[2]).result.tools[0].name, 'http_status');
      assert.equal(outs[3].trim(), '403');
    });
    it('refuses a foreign Host or Origin, and GET', async () => {
      assert.equal((await http(port, { headers: { ...MCP_HEADERS, host: 'evil.example' }, body: LIST })).status, 403);
      assert.equal((await http(port, { headers: { ...MCP_HEADERS, origin: 'https://evil.example' }, body: LIST })).status, 403);
      assert.equal((await http(port, { headers: { ...MCP_HEADERS, origin: 'http://localhost:5173' }, body: LIST })).status, 200);
      assert.equal((await http(port, { method: 'GET', headers: { accept: 'text/event-stream' } })).status, 405);
    });
    it('create-3: answers a browser preflight from an allowed origin and adds CORS headers; others get 403', async () => {
      const origin = 'http://localhost:5173';
      const pre = await http(port, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,mcp-protocol-version' },
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers['access-control-allow-origin'], origin);
      assert.match(pre.headers['access-control-allow-methods'], /POST/);
      assert.equal(pre.headers['access-control-allow-headers'], 'content-type,mcp-protocol-version');
      const post = await http(port, { headers: { ...MCP_HEADERS, origin }, body: LIST });
      assert.equal(post.status, 200);
      assert.equal(post.headers['access-control-allow-origin'], origin);
      assert.match(post.headers['access-control-expose-headers'], /WWW-Authenticate/);
      assert.match(String(post.headers.vary), /Origin/);
      const evil = await http(port, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
      assert.equal(evil.status, 403);
      assert.equal(evil.headers['access-control-allow-origin'], undefined);
      assert.equal((await http(port, { headers: MCP_HEADERS, body: LIST })).headers['access-control-allow-origin'], undefined, 'no Origin, no CORS headers');
    });
    it('serves the server card once the file exists', async () => {
      const missing = await http(port, { method: 'GET', path: '/mcp/server-card' });
      assert.equal(missing.status, 404);
      mkdirSync(join(dir, '.well-known/mcp'), { recursive: true });
      writeFileSync(join(dir, '.well-known/mcp/server-card.json'), JSON.stringify({ name: 'io.github.example/weather-mcp' }));
      for (const path of ['/mcp/server-card', '/.well-known/mcp/server-card.json']) {
        const r = await http(port, { method: 'GET', path });
        assert.equal(r.status, 200);
        assert.equal(JSON.parse(r.body).name, 'io.github.example/weather-mcp');
        assert.equal(r.headers['access-control-allow-origin'], '*', 'a public card any page may read');
      }
    });
    it('stops on SIGTERM', async () => {
      const p = running.find((x) => x.output().includes(`:${port}/mcp`));
      const r = await p.stop('SIGTERM');
      assert.ok(r.code === 0 || r.signal === 'SIGTERM', JSON.stringify(r));
    });
    it('with ALLOWED_HOSTS, allows exactly those hostnames', async () => {
      const { port: p2 } = await startNode(dir, 'dist/index.js', { ALLOWED_HOSTS: 'mcp.example.com' });
      assert.equal((await http(p2, { headers: { ...MCP_HEADERS, host: 'mcp.example.com' }, body: LIST })).status, 200);
      assert.equal((await http(p2, { headers: { ...MCP_HEADERS, host: `127.0.0.1:${p2}` }, body: LIST })).status, 403);
      assert.equal((await http(p2, { headers: { ...MCP_HEADERS, host: 'mcp.example.com', origin: 'https://mcp.example.com' }, body: LIST })).status, 200);
      assert.equal((await http(p2, { headers: { ...MCP_HEADERS, host: 'mcp.example.com', origin: 'https://other.example' }, body: LIST })).status, 403);
    });
    it('refuses to listen on all interfaces without ALLOWED_HOSTS', async () => {
      const p = startProcess(process.execPath, ['dist/index.js'], { cwd: dir, env: { HOST: '0.0.0.0', PORT: String(await freePort()) } });
      running.push(p);
      const r = await p.exited;
      assert.equal(r.code, 1);
      assert.match(p.output(), /set ALLOWED_HOSTS/);
    });
    it('runs from source with tsx (npm run dev without watching)', async () => {
      const port3 = await freePort();
      const p = startProcess(join(dir, 'node_modules/.bin/tsx'), ['src/index.ts'], { cwd: dir, env: { PORT: String(port3) } });
      running.push(p);
      await waitForPort(port3);
      assert.equal(rpc((await http(port3, { headers: MCP_HEADERS, body: LIST })).body).result.tools[0].name, 'http_status');
      await p.stop();
    });
  });

  describe('express, bearer', () => {
    const dir = proj('express-bearer');
    const token = 'test-only-dev-token-0123456789';
    let port;
    it('installs and builds', async () => {
      assert.equal((await npm(['install'], dir)).code, 0);
      const b = await npm(['run', 'build'], dir);
      assert.equal(b.code, 0, b.stdout + b.stderr);
    });
    it('the installed express adapter passes expectedResource on (audience check)', async () => {
      writeFileSync(join(dir, 'audience.mjs'), AUDIENCE_CHECK);
      const r = await run(process.execPath, ['audience.mjs'], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { other: 401, same: 'next', none: 401 });
    });
    it('answers 401 with a WWW-Authenticate challenge and publishes RFC 9728 metadata', async () => {
      port = await freePort();
      const url = `http://127.0.0.1:${port}/mcp`;
      const p = startProcess(process.execPath, ['dist/index.js'], { cwd: dir, env: { PORT: String(port), MCP_SERVER_URL: url, DEV_ACCESS_TOKEN: token } });
      running.push(p);
      await waitForPort(port);
      const r = await http(port, { headers: MCP_HEADERS, body: LIST });
      assert.equal(r.status, 401);
      assert.match(r.headers['www-authenticate'], new RegExp(`^Bearer .*resource_metadata="http://127\\.0\\.0\\.1:${port}/\\.well-known/oauth-protected-resource/mcp"`));
      const prm = await http(port, { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' });
      assert.equal(prm.status, 200);
      const doc = JSON.parse(prm.body);
      assert.equal(doc.resource, url);
      assert.ok(doc.authorization_servers.length === 1);
      assert.deepEqual(doc.scopes_supported, ['mcp']);
      const as = await http(port, { method: 'GET', path: '/.well-known/oauth-authorization-server' });
      assert.equal(JSON.parse(as.body).issuer, 'https://auth.example.com');
      assert.equal((await http(port, { headers: { ...MCP_HEADERS, authorization: 'Bearer wrong' }, body: LIST })).status, 401);
      assert.match(p.output(), /OAUTH_ISSUER is not set/);
      assert.match(p.output(), /DEV_ACCESS_TOKEN is set/);
    });
    it('serves the official client with the development token', async () => {
      assertClientRun(await drive({ url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` }, modes: ['legacy', { pin: '2026-07-28' }] }));
    });
    it('answers the README curl commands', async (t) => {
      const outs = await curls(dir, port, { DEV_ACCESS_TOKEN: token });
      if (!outs) return t.skip('curl is not installed');
      assert.equal(outs.length, 5);
      assert.match(outs[0], /"name":"http_status"/);
      assert.equal(JSON.parse(outs[1]).result.structuredContent.code, 404);
      assert.equal(JSON.parse(outs[2]).result.tools.length, 1);
      assert.equal(outs[3].trim(), '403');
      assert.match(outs[4], /^WWW-Authenticate: Bearer error="invalid_token".*resource_metadata=/i);
    });
    it('create-1: refuses to start with DEV_ACCESS_TOKEN anywhere but a localhost-only server', async () => {
      const cases = [
        // the review's case: reachable from other machines, MCP_SERVER_URL forgotten, the dev token still set
        { HOST: '0.0.0.0', ALLOWED_HOSTS: 'mcp.example.com', DEV_ACCESS_TOKEN: token },
        { HOST: '0.0.0.0', ALLOWED_HOSTS: 'mcp.example.com', MCP_SERVER_URL: 'https://mcp.example.com/mcp', DEV_ACCESS_TOKEN: token },
        { ALLOWED_HOSTS: 'mcp.example.com', MCP_SERVER_URL: 'https://mcp.example.com/mcp', DEV_ACCESS_TOKEN: token },
        { MCP_SERVER_URL: 'https://mcp.example.com/mcp', DEV_ACCESS_TOKEN: token },
      ];
      for (const env of cases) {
        const p = startProcess(process.execPath, ['dist/index.js'], { cwd: dir, env: { PORT: String(await freePort()), ...env } });
        running.push(p);
        const r = await p.exited;
        assert.equal(r.code, 1, JSON.stringify(env));
        assert.match(p.output(), /set MCP_SERVER_URL|Remove DEV_ACCESS_TOKEN/, JSON.stringify(env));
      }
    });
    it('create-1: a public server needs MCP_SERVER_URL, and then never takes the development token', async () => {
      const missing = startProcess(process.execPath, ['dist/index.js'], { cwd: dir, env: { HOST: '0.0.0.0', ALLOWED_HOSTS: 'mcp.example.com', PORT: String(await freePort()) } });
      running.push(missing);
      assert.equal((await missing.exited).code, 1);
      assert.match(missing.output(), /set MCP_SERVER_URL to its public URL/);
      const port2 = await freePort();
      const p = startProcess(process.execPath, ['dist/index.js'], {
        cwd: dir,
        env: { HOST: '0.0.0.0', PORT: String(port2), ALLOWED_HOSTS: 'mcp.example.com', MCP_SERVER_URL: 'https://mcp.example.com/mcp' },
      });
      running.push(p);
      await waitForPort(port2);
      const r = await http(port2, { headers: { ...MCP_HEADERS, host: 'mcp.example.com', authorization: `Bearer ${token}` }, body: LIST });
      assert.equal(r.status, 401);
      assert.doesNotMatch(p.output(), /DEV_ACCESS_TOKEN is set/);
    });
    it('create-3: answers the preflight before the sign-in check', async () => {
      const origin = 'http://127.0.0.1:6274';
      const pre = await http(port, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers['access-control-allow-origin'], origin);
      const denied = await http(port, { headers: { ...MCP_HEADERS, origin }, body: LIST });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers['access-control-allow-origin'], origin, 'a browser client can read the 401 and its challenge');
      assert.match(denied.headers['access-control-expose-headers'], /WWW-Authenticate/);
    });
  });

  for (const auth of ['none', 'bearer']) {
    describe(`workers, ${auth}`, () => {
      const dir = proj(`workers-${auth}`);
      const runner = join(proj('express-none'), 'run-worker.mjs');
      const token = 'test-only-dev-token-abcdef0123';
      /** Serve the worker on node:http with these vars. */
      async function serve(env) {
        const port = await freePort();
        writeFileSync(runner, WORKER_RUNNER);
        const p = startProcess(process.execPath, [runner, join(dir, 'src/index.ts'), JSON.stringify(env), String(port)], { cwd: proj('express-none') });
        running.push(p);
        try {
          await waitForPort(port);
        } catch (err) {
          throw new Error(`${err.message}\n${p.output()}`);
        }
        return port;
      }
      it('writes a wrangler.jsonc that the pinned wrangler\'s own schema accepts', async () => {
        const tgz = join(tools, `wrangler-${VERSIONS.wrangler}.tgz`);
        if (!existsSync(join(tools, 'package/config-schema.json'))) {
          const packed = await npm(['pack', `wrangler@${VERSIONS.wrangler}`, '--pack-destination', tools], tools);
          assert.equal(packed.code, 0, packed.stderr);
          const untar = await run('tar', ['-xzf', tgz, 'package/config-schema.json'], { cwd: tools });
          assert.equal(untar.code, 0, untar.stderr);
        }
        const { default: Ajv } = await import('ajv');
        const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(join(tools, 'package/config-schema.json'), 'utf8')));
        const ok = validate(parseJsonc(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')));
        assert.ok(ok, JSON.stringify(validate.errors));
      });
      it('installs its runtime dependencies and passes the type check', async () => {
        // wrangler (a dev dependency) needs Node.js 22 and a large download: the type check uses the TypeScript
        // installed for the express project instead.
        const i = await npm(['install', '--omit=dev'], dir);
        assert.equal(i.code, 0, i.stderr);
        const tsc = join(proj('express-none'), 'node_modules/typescript/bin/tsc');
        const r = await run(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: dir });
        assert.equal(r.code, 0, r.stdout + r.stderr);
      });
      it('serves the official client through its fetch handler', async () => {
        const env = auth === 'bearer' ? { DEV_ACCESS_TOKEN: token, DEV_MODE: '1' } : {};
        const port = await serve(env);
        const headers = auth === 'bearer' ? { Authorization: `Bearer ${token}` } : {};
        assertClientRun(await drive({ url: `http://127.0.0.1:${port}/mcp`, headers, modes: ['legacy', { pin: '2026-07-28' }] }));
        const auth401 = await http(port, { headers: MCP_HEADERS, body: LIST });
        if (auth === 'bearer') {
          assert.equal(auth401.status, 401);
          assert.match(auth401.headers['www-authenticate'], /resource_metadata="http:\/\/127\.0\.0\.1:8787\/\.well-known\/oauth-protected-resource\/mcp"/);
          const prm = await http(port, { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' });
          assert.equal(prm.status, 200);
          assert.equal(JSON.parse(prm.body).resource, 'http://127.0.0.1:8787/mcp');
        } else {
          assert.equal(auth401.status, 200);
        }
      });
      it('checks Host and Origin by hand, and has one endpoint', async () => {
        const port = await serve({ ALLOWED_HOSTS: 'weather.example.workers.dev', ...(auth === 'bearer' ? { MCP_SERVER_URL: 'https://weather.example.workers.dev/mcp' } : {}) });
        const evil = await http(port, { headers: { ...MCP_HEADERS, host: 'evil.example' }, body: LIST });
        assert.equal(evil.status, 403);
        assert.match(JSON.parse(evil.body).error.message, /Host not allowed: evil\.example\. Add it to ALLOWED_HOSTS/);
        const badOrigin = await http(port, { headers: { ...MCP_HEADERS, origin: 'https://evil.example' }, body: LIST });
        assert.equal(badOrigin.status, 403);
        assert.equal((await http(port, { headers: { ...MCP_HEADERS, origin: 'null' }, body: LIST })).status, 403);
        const okStatus = auth === 'bearer' ? 401 : 200;
        assert.equal((await http(port, { headers: { ...MCP_HEADERS, host: 'weather.example.workers.dev' }, body: LIST })).status, okStatus);
        assert.equal((await http(port, { headers: { ...MCP_HEADERS, host: 'weather.example.workers.dev', origin: 'https://weather.example.workers.dev' }, body: LIST })).status, okStatus);
        assert.equal((await http(port, { method: 'GET', path: '/other' })).status, 404);
      });
      it('create-3: answers a browser preflight from an allowed origin and adds CORS headers', async () => {
        const port = await serve({ ALLOWED_HOSTS: 'weather.example.workers.dev', ALLOWED_ORIGINS: 'app.example.com', ...(auth === 'bearer' ? { MCP_SERVER_URL: 'https://weather.example.workers.dev/mcp' } : {}) });
        const host = 'weather.example.workers.dev';
        const origin = 'https://app.example.com';
        const pre = await http(port, { method: 'OPTIONS', headers: { host, origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' } });
        assert.equal(pre.status, 204);
        assert.equal(pre.headers['access-control-allow-origin'], origin);
        assert.equal(pre.headers['access-control-allow-headers'], 'content-type,authorization');
        const post = await http(port, { headers: { ...MCP_HEADERS, host, origin }, body: LIST });
        assert.equal(post.status, auth === 'bearer' ? 401 : 200);
        assert.equal(post.headers['access-control-allow-origin'], origin);
        assert.match(post.headers['access-control-expose-headers'], /WWW-Authenticate/);
        const evil = await http(port, { method: 'OPTIONS', headers: { host, origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
        assert.equal(evil.status, 403);
        assert.equal(evil.headers['access-control-allow-origin'], undefined);
      });
      if (auth === 'bearer') {
        it('create-2: the development token works only with DEV_MODE=1 on localhost; a deployed worker needs MCP_SERVER_URL', async () => {
          const host = 'wb.acme.workers.dev';
          const asDeployed = { headers: { ...MCP_HEADERS, host, authorization: `Bearer ${token}` }, body: LIST };
          // the review's case: deployed with the wrangler.jsonc default (no MCP_SERVER_URL) and the token uploaded
          const a = await serve({ ALLOWED_HOSTS: host, DEV_ACCESS_TOKEN: token, DEV_MODE: '1' });
          const unset = await http(a, asDeployed);
          assert.equal(unset.status, 500);
          assert.match(JSON.parse(unset.body).error.message, /Set MCP_SERVER_URL in wrangler\.jsonc/);
          const b = await serve({ ALLOWED_HOSTS: host, MCP_SERVER_URL: 'http://127.0.0.1:8787/mcp', DEV_ACCESS_TOKEN: token, DEV_MODE: '1' });
          assert.equal((await http(b, asDeployed)).status, 500, 'a localhost MCP_SERVER_URL on a public hostname');
          const c = await serve({ ALLOWED_HOSTS: host, MCP_SERVER_URL: `https://${host}/mcp`, DEV_ACCESS_TOKEN: token, DEV_MODE: '1' });
          assert.equal((await http(c, asDeployed)).status, 401, 'the token is refused on the public hostname');
          assert.equal((await http(c, { headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` }, body: LIST })).status, 200, 'and works on localhost');
          const d = await serve({ DEV_ACCESS_TOKEN: token });
          assert.equal((await http(d, { headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` }, body: LIST })).status, 401, 'without DEV_MODE=1 it is refused on localhost too');
        });
      }
    });
  }

  describe('stdio', () => {
    const dir = proj('stdio-none');
    it('installs, builds an executable entry point, and packs only dist', async () => {
      assert.equal((await npm(['install'], dir)).code, 0);
      const b = await npm(['run', 'build'], dir);
      assert.equal(b.code, 0, b.stdout + b.stderr);
      assert.ok(readFileSync(join(dir, 'dist/index.js'), 'utf8').startsWith('#!/usr/bin/env node\n'));
      const pack = await npm(['pack', '--dry-run', '--json', '--ignore-scripts'], dir);
      assert.equal(pack.code, 0, pack.stderr);
      const files = JSON.parse(pack.stdout)[0].files.map((f) => f.path).sort();
      assert.deepEqual(files, ['README.md', 'dist/icon.js', 'dist/index.js', 'dist/server.js', 'package.json']);
    });
    it('serves both protocol eras to the official client over stdio', async () => {
      assertClientRun(await drive({ command: process.execPath, args: [join(dir, 'dist/index.js')], modes: ['legacy', 'auto', { pin: '2026-07-28' }] }));
    });
    it('create-4: `mcp-tc check . --stdio` (the command create prints) finds no problem with the generated server', async () => {
      const r = await runCli(['check', '.', '--stdio', '--json'], { cwd: dir });
      const d = r.json();
      assert.equal(r.code, 0, JSON.stringify(d.findings));
      assert.equal(d.counts.error, 0, JSON.stringify(d.findings));
      assert.ok(!d.findings.some((x) => x.id === 'legacy_missing'), JSON.stringify(d.findings));
      assert.equal(d.stdio.eras.modern.ok, true);
      assert.equal(d.stdio.eras.legacy.ok, true);
    });
  });
});
