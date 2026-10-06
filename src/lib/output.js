// Human output: width-aware tables and key/value blocks, colors only on a terminal, and cleaning of untrusted text.
// Listing text comes from each server's own metadata, so every value printed for people goes through clean():
// no escape sequences, control characters or bidi marks can reach the terminal.

// C0/C1 controls (except tab and newline, handled per use), DEL, zero-width and bidi marks, BOM, tag characters.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*m/g;

/**
 * Untrusted text made safe for a terminal. Newlines and tabs are kept unless `oneLine`.
 * @param {unknown} value
 * @param {{oneLine?: boolean}} [opts]
 */
export function clean(value, opts = {}) {
  if (value === null || value === undefined) return '';
  // a carriage return moves the cursor back to the start of the line, so text after it could print over what came
  // before: CRLF becomes a newline, and a lone CR goes
  let s = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '').replace(UNSAFE, '');
  if (opts.oneLine) s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * When the program reading our output goes away (`mcp-tc categories | head -1`), writing fails with EPIPE. Without a
 * listener that is an unhandled 'error' event and a crash with a stack trace; with this one, mcp-tc exits quietly with
 * code 0, as command-line tools do when their output is cut short. Other stream errors are rethrown.
 * @param {NodeJS.WritableStream} stream process.stdout or process.stderr
 * @param {(code: number) => void} [exit]
 */
export function exitOnClosedPipe(stream, exit = (code) => process.exit(code)) {
  stream.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
    if (err && err.code === 'EPIPE') {
      exit(0);
      return;
    }
    throw err;
  });
}

/**
 * Columns a string takes in a terminal: wide East Asian characters and most emoji count 2, combining marks 0.
 * @param {string} s
 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (/\p{M}/u.test(ch)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** @param {number} cp */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Cut a plain (uncolored) string to `width` columns, ending with an ellipsis when it was longer.
 * @param {string} s
 * @param {number} width
 */
export function truncate(s, width) {
  if (width <= 0) return '';
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = /\p{M}/u.test(ch) ? 0 : isWide(/** @type {number} */ (ch.codePointAt(0))) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out.trimEnd()}\u2026`;
}

/**
 * Pad to `width` columns (ANSI-aware).
 * @param {string} s
 * @param {number} width
 */
export function pad(s, width) {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/**
 * Word-wrap plain text to `width` columns; long words are kept whole.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  /** @type {string[]} */
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && displayWidth(line) + 1 + displayWidth(word) > width) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * @typedef {object} Column
 * @property {string} key field of each row
 * @property {string} header
 * @property {number} [max] widest this column may get
 * @property {boolean} [flex] takes the remaining width (one column, usually the last)
 * @property {boolean} [keep] never cut: for values people type back (a slug, a tool name)
 * @property {(value: any, row: any) => string} [format] text for a cell (plain); the result is cleaned
 * @property {(row: any) => string} [suffix] text after the cell that a cut never removes (a checkmark)
 * @property {(text: string, row: any) => string} [style] coloring applied after padding and cutting
 */

/**
 * @typedef {ReturnType<typeof createOutput>} Output
 */

/**
 * @param {object} opts
 * @param {NodeJS.WritableStream & {isTTY?: boolean, columns?: number}} opts.stdout
 * @param {NodeJS.WritableStream & {isTTY?: boolean, columns?: number}} opts.stderr
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {boolean} [opts.json] --json: nothing but the JSON document on stdout
 * @param {boolean} [opts.noColor] --no-color
 */
export function createOutput({ stdout, stderr, env = process.env, json = false, noColor = false }) {
  // each stream decides for itself: `mcp-tc info x 2>err.log` keeps escape codes out of the log, and
  // `mcp-tc search x | less` still shows a colored error on the terminal
  const allowed = !noColor && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  const color = !json && allowed && Boolean(stdout.isTTY);
  const errColor = allowed && Boolean(stderr && stderr.isTTY);
  const fromEnv = Number.parseInt(env.COLUMNS || '', 10);
  const envCols = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
  /** @param {{isTTY?: boolean, columns?: number}|undefined} s */
  const columnsOf = (s) => (s && s.isTTY && s.columns ? s.columns : envCols);
  const known = columnsOf(stdout);
  // text wraps at the terminal's width (100 columns when there is none); tables are cut to fit a terminal only, so
  // output that goes to a file or a pipe keeps every character
  const width = Math.max(40, known ?? 100);
  const tableWidth = known === null ? Infinity : Math.max(40, known);
  const errWidth = Math.max(40, columnsOf(stderr) ?? 100);
  /** @param {boolean} on */
  const styles = (on) => {
    /** @param {string} open @param {string} close */
    const sgr = (open, close) => (/** @type {string} */ s) => (on ? `\u001B[${open}m${s}\u001B[${close}m` : s);
    return {
      bold: sgr('1', '22'),
      dim: sgr('2', '22'),
      green: sgr('32', '39'),
      yellow: sgr('33', '39'),
      red: sgr('31', '39'),
      cyan: sgr('36', '39'),
    };
  };
  const style = styles(color);
  const errStyle = styles(errColor);

  return {
    color,
    errColor,
    width,
    tableWidth,
    json,
    style,
    /** Styles for text written to stderr (errors, warnings, prompts). */
    errStyle,
    clean,
    truncate,
    /** One line (or several) on stdout. Never in --json mode. @param {string} [text] */
    print(text = '') {
      if (json) return;
      stdout.write(`${text}\n`);
    },
    /** A warning on stderr (also in --json mode). @param {string} text */
    warn(text) {
      stderr.write(`${errStyle.yellow('Warning:')} ${text}\n`);
    },
    /** Progress on stderr; silent in --json mode so agents get only the document. @param {string} text */
    info(text) {
      if (json) return;
      stderr.write(`${text}\n`);
    },
    /** The JSON document on stdout. @param {unknown} doc */
    writeJson(doc) {
      stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    },
    /**
     * Rows as an aligned table that fits the terminal. Cells are cleaned; on a terminal too narrow for them, the
     * widest columns are cut with an ellipsis, never a `keep` column or a `suffix`. Not on a terminal (a file, a
     * pipe), nothing is cut.
     * @param {any[]} rows
     * @param {Column[]} columns
     * @param {{indent?: number, header?: boolean}} [opts]
     */
    table(rows, columns, opts = {}) {
      const indent = ' '.repeat(opts.indent || 0);
      const gap = 2;
      const cells = rows.map((r) => columns.map((c) => clean(c.format ? c.format(r[c.key], r) : r[c.key], { oneLine: true })));
      const suffixes = rows.map((r) => columns.map((c) => (c.suffix ? clean(c.suffix(r), { oneLine: false }) : '')));
      const sw = columns.map((_, i) => Math.max(0, ...suffixes.map((row) => displayWidth(row[i]))));
      const natural = columns.map((c, i) =>
        Math.max(opts.header === false ? 0 : displayWidth(c.header), ...cells.map((row, r) => displayWidth(row[i]) + displayWidth(suffixes[r][i]))),
      );
      const widths = natural.map((w, i) => (columns[i].keep ? w : Math.min(w, columns[i].max || Infinity)));
      const least = widths.map((w, i) => (columns[i].keep ? w : Math.min(w, 6 + sw[i])));
      const flex = columns.findIndex((c) => c.flex);
      const total = () => widths.reduce((a, b) => a + b, 0) + gap * (columns.length - 1) + indent.length;
      if (flex >= 0 && Number.isFinite(tableWidth) && !columns[flex].keep) {
        const others = total() - widths[flex];
        widths[flex] = Math.max(Math.min(natural[flex], tableWidth - others), Math.min(natural[flex], 12, widths[flex]));
      }
      // still too wide: shrink the widest column that may shrink, until it fits or none can
      while (total() > tableWidth) {
        let pick = -1;
        widths.forEach((w, i) => {
          if (w > least[i] && (pick === -1 || w > widths[pick])) pick = i;
        });
        if (pick === -1) break;
        widths[pick] -= 1;
      }
      const line = (/** @type {string[]} */ row, /** @type {string[]|null} */ suf, /** @type {any} */ src, /** @type {boolean} */ head) =>
        indent +
        row
          .map((text, i) => {
            const tail = suf ? suf[i] : '';
            const cut = truncate(text, widths[i] - displayWidth(tail)) + tail;
            const padded = i === row.length - 1 ? cut : pad(cut, widths[i]);
            if (head) return style.dim(padded);
            const st = columns[i].style;
            return st ? st(padded, src) : padded;
          })
          .join(' '.repeat(gap))
          .trimEnd();
      const out = [];
      if (opts.header !== false) out.push(line(columns.map((c) => c.header), null, null, true));
      cells.forEach((row, i) => out.push(line(row, suffixes[i], rows[i], false)));
      return out.join('\n');
    },
    /**
     * Aligned "Label  value" lines; long values wrap under themselves. Values are cleaned; empty ones are skipped.
     * @param {[string, unknown][]} pairs
     * @param {{indent?: number, stderr?: boolean}} [opts] stderr: the text goes to stderr (its colors and width)
     */
    fields(pairs, opts = {}) {
      const indent = ' '.repeat(opts.indent || 0);
      const st = opts.stderr ? errStyle : style;
      const kept = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
      if (!kept.length) return '';
      const lw = Math.max(...kept.map(([k]) => displayWidth(k))) + 2;
      const vw = Math.max(20, (opts.stderr ? errWidth : width) - lw - indent.length);
      return kept
        .map(([k, v]) => {
          const lines = wrap(clean(v, { oneLine: true }), vw);
          return lines.map((l, i) => indent + (i === 0 ? st.dim(pad(k, lw)) : ' '.repeat(lw)) + l).join('\n');
        })
        .join('\n');
    },
    /**
     * A list item ("- text") wrapped to the width, with later lines under the text. Cleaned.
     * @param {unknown} text
     * @param {{indent?: number}} [opts]
     */
    bullet(text, opts = {}) {
      const indent = ' '.repeat(opts.indent || 0);
      return wrap(clean(text, { oneLine: true }), Math.max(20, width - indent.length - 2))
        .map((l, i) => `${indent}${i === 0 ? '- ' : '  '}${l}`)
        .join('\n');
    },
    /**
     * A paragraph wrapped to the width, cleaned.
     * @param {unknown} text
     * @param {{indent?: number}} [opts]
     */
    paragraph(text, opts = {}) {
      const indent = ' '.repeat(opts.indent || 0);
      return clean(text)
        .split(/\n{2,}/)
        .map((p) => wrap(p.replace(/\s+/g, ' ').trim(), width - indent.length).map((l) => indent + l).join('\n'))
        .join('\n\n');
    },
  };
}
