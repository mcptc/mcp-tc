// Errors and exit codes shared by every command. The README documents the EXIT table: change them together.

/** Exit codes. Commands throw a CliError with one of these, or call ctx.setExitCode() for a non-zero outcome that is not an error. */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1, // network, server error, unexpected
  USAGE: 2, // bad flags or arguments; needs confirmation but no TTY and no --yes
  NOT_FOUND: 3, // unknown listing, nothing at that address
  RATE_LIMITED: 4, // mcp.tc kept answering 429 after the retries
  UNREACHABLE: 5, // doctor/check: the server could not be reached or did not speak MCP
  PROBLEMS: 6, // check: problems found
  WAITING: 10, // submit: waiting for review
  NOT_ACCEPTED: 11, // submit: not accepted
  WAIT_TIMEOUT: 12, // submit: --wait ran out while the server was still being checked
  INTERRUPTED: 130, // Ctrl+C at a question (the shell's code for an interrupt)
});

/**
 * An error the CLI reports cleanly: no stack trace (unless MCPTC_DEBUG=1), a snake_case code for --json,
 * an English sentence for people, and an exit code.
 */
export class CliError extends Error {
  /**
   * @param {string} code snake_case identifier, stable for scripts (e.g. "not_found")
   * @param {string} message one or two English sentences
   * @param {number} [exit] process exit code (EXIT.*)
   * @param {Record<string, unknown>} [details] extra fields for the JSON error object (never secrets)
   */
  constructor(code, message, exit = EXIT.ERROR, details = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exit = exit;
    this.details = details;
  }
}

/** Bad flags or arguments: exit 2. */
export class UsageError extends CliError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   * @param {string} [code]
   */
  constructor(message, details = {}, code = 'usage') {
    super(code, message, EXIT.USAGE, details);
    this.name = 'UsageError';
  }
}

/**
 * The JSON error object for the envelope: {code, message, ...details}.
 * @param {unknown} err
 * @returns {{code: string, message: string} & Record<string, unknown>}
 */
export function errorObject(err) {
  if (err instanceof CliError) {
    return { ...err.details, code: err.code, message: err.message };
  }
  const message = err instanceof Error && err.message ? err.message : String(err);
  return { code: 'unexpected', message: `Unexpected error: ${message}` };
}

/**
 * Exit code for any thrown value.
 * @param {unknown} err
 */
export function exitCodeOf(err) {
  return err instanceof CliError ? err.exit : EXIT.ERROR;
}
