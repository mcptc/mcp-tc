// Writes src/icon.ts from an image file, so the server can list its icon in serverInfo without another request.
//
//   npm run icon                      reads assets/icon.png
//   npm run icon -- path/to/logo.webp
//
// Use PNG, WebP or JPEG: many clients and directories skip SVG icons. A square image of 128 x 128 pixels or more works
// well. The image goes into the server as a data: URI, so keep it small (a few kilobytes).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_BYTES = 100 * 1024;

/** @typedef {object} ImageInfo
 * @property {string} mimeType
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * The image type and, for PNG, its size, from the file's first bytes.
 * @param {Uint8Array} bytes
 * @returns {ImageInfo | null}
 */
export function imageInfo(bytes) {
  const b = Buffer.from(bytes);
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mimeType: 'image/jpeg' };
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mimeType: 'image/webp' };
  return null;
}

/**
 * The source of src/icon.ts for an image.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function iconModule(bytes) {
  const info = imageInfo(bytes);
  if (!info) throw new Error('The icon must be a PNG, WebP or JPEG file.');
  if (bytes.length > MAX_BYTES) throw new Error(`The icon is ${Math.round(bytes.length / 1024)} KB. Keep it under ${MAX_BYTES / 1024} KB: it travels inside every handshake.`);
  const sizes = info.width && info.height ? `, sizes: ['${info.width}x${info.height}']` : '';
  return [
    '// Written by `npm run icon` from your icon file. Run it again after you change the image; do not edit by hand.',
    '// A data: URI keeps the icon inside the server, so clients and directories can show it without fetching anything.',
    `export const ICON = { src: 'data:${info.mimeType};base64,${Buffer.from(bytes).toString('base64')}', mimeType: '${info.mimeType}'${sizes} };`,
    '',
  ].join('\n');
}

function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const input = resolve(root, process.argv[2] || 'assets/icon.png');
  const out = resolve(root, 'src/icon.ts');
  writeFileSync(out, iconModule(readFileSync(input)));
  console.log(`Wrote ${out} from ${input}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
