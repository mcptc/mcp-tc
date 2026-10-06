// Questions to the person at the terminal. Prompts go to stderr, so stdout stays clean for --json and pipes.
// Without a terminal there is nobody to ask: confirm() needs --yes, and ask() refuses.
// Ctrl+C at a question stops the command with code "cancelled" and exit 130 (the shell's code for an interrupt);
// Ctrl+D (end of input) stops it with exit 1. Either way nothing that the question guarded happens.
import { createInterface } from 'node:readline/promises';
import { CliError, EXIT, UsageError } from './errors.js';

/** Exit code after Ctrl+C at a question, as shells report a command stopped by an interrupt. */
export const INTERRUPTED = EXIT.INTERRUPTED;

/**
 * @typedef {object} PromptIO
 * @property {NodeJS.ReadableStream & {isTTY?: boolean, setRawMode?: (on: boolean) => void}} [stdin]
 * @property {NodeJS.WritableStream} [stderr]
 */

/**
 * Ask a yes/no question; the default answer is no.
 * @param {string} question without the "[y/N]" suffix
 * @param {PromptIO & {yes?: boolean}} [opts] yes: --yes was given, so don't ask
 * @returns {Promise<boolean>}
 */
export async function confirm(question, opts = {}) {
  if (opts.yes) return true;
  const stdin = opts.stdin || process.stdin;
  const stderr = opts.stderr || process.stderr;
  if (!stdin.isTTY) {
    throw new UsageError('This step needs your confirmation, but there is no terminal to ask in. Run it in a terminal, or pass --yes.', {}, 'needs_confirmation');
  }
  const answer = await readLine(`${question} [y/N] `, stdin, stderr);
  return /^\s*y(es)?\s*$/i.test(answer);
}

/**
 * One line from readline. Ctrl+C and Ctrl+D close the interface without answering; they become a CliError here, so
 * the command ends with an exit code and, with --json, its JSON document (instead of exiting 0 with nothing).
 * @param {string} text
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<string>}
 */
async function readLine(text, stdin, stderr) {
  const rl = createInterface({ input: stdin, output: stderr, terminal: true });
  const ac = new AbortController();
  /** @type {'interrupt'|'eof'|null} */
  let why = null;
  rl.once('SIGINT', () => {
    why = why || 'interrupt';
    ac.abort();
  });
  rl.once('close', () => {
    why = why || 'eof';
    ac.abort();
  });
  try {
    return await rl.question(text, { signal: ac.signal });
  } catch (err) {
    // readline ends the question's line itself when it closes
    if (ac.signal.aborted || (err && /** @type {any} */ (err).name === 'AbortError')) throw cancelled(why === 'interrupt');
    throw err;
  } finally {
    rl.close();
  }
}

/**
 * @param {boolean} interrupted Ctrl+C (exit 130) rather than Ctrl+D (exit 1)
 */
function cancelled(interrupted) {
  return new CliError('cancelled', 'Cancelled.', interrupted ? INTERRUPTED : 1);
}

/**
 * Ask for a line of text. With `secret`, what the person types is not echoed (for API keys); the value is returned
 * to the caller only, never logged.
 * @param {string} prompt
 * @param {PromptIO & {secret?: boolean}} [opts]
 * @returns {Promise<string>}
 */
export async function ask(prompt, opts = {}) {
  const stdin = opts.stdin || process.stdin;
  const stderr = opts.stderr || process.stderr;
  if (!stdin.isTTY) {
    throw new UsageError('This step needs an answer typed in a terminal, and there is none.', {}, 'needs_terminal');
  }
  if (!opts.secret || typeof stdin.setRawMode !== 'function') {
    return (await readLine(`${prompt} `, stdin, stderr)).trim();
  }
  return readSecret(prompt, /** @type {any} */ (stdin), stderr);
}

/**
 * Read one line in raw mode without echo. Ctrl+C cancels (exit 130); Ctrl+D on an empty line too (exit 1).
 * @param {string} question
 * @param {NodeJS.ReadStream} stdin
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<string>}
 */
function readSecret(question, stdin, stderr) {
  stderr.write(`${question} `);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const done = (/** @type {Error|null} */ err) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stderr.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (/** @type {Buffer|string} */ chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0004' && !value) return done(cancelled(false));
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(null);
        if (ch === '\u0003') return done(cancelled(true));
        if (ch === '\u007F' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
