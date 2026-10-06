#!/usr/bin/env node
// Entry point for the mcp-tc and mcptc commands.
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  process.stderr.write(`mcp-tc needs Node.js 20 or newer; this is ${process.versions.node}.\n`);
  process.exitCode = 1;
} else {
  import('../src/lib/output.js')
    .then((o) => {
      // output piped into a program that stops reading (| head) ends mcp-tc quietly instead of crashing
      o.exitOnClosedPipe(process.stdout);
      o.exitOnClosedPipe(process.stderr);
      return import('../src/cli.js');
    })
    .then((m) => m.main(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
      if (process.env.MCPTC_DEBUG === '1' && err && err.stack) process.stderr.write(`${err.stack}\n`);
      process.exitCode = 1;
    });
}
