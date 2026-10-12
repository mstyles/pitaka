// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { brotliDecompressSync } from "node:zlib";

// Indexes into the WOFF2 spec's table of known tags.
const GLYF = 10;
const LOCA = 11;
const GSUB = 28;

/** The GSUB feature tags of a single-font WOFF2 file, e.g. ["liga", "onum"]. */
export function woff2Features(path: string): string[] {
  const file: Uint8Array = readFileSync(path);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const numTables = view.getUint16(12);
  const compressedSize = view.getUint32(20);
  let pos = 48;
  const base128 = () => {
    let n = 0;
    for (;;) {
      const b = file[pos++];
      n = n * 128 + (b & 0x7f);
      if (!(b & 0x80)) return n;
    }
  };
  // The tables sit one after another, unpadded, in one Brotli stream.
  let offset = 0;
  let gsub: { offset: number; length: number } | null = null;
  for (let i = 0; i < numTables; i++) {
    const flags = file[pos++];
    const known = flags & 0x3f;
    if (known === 0x3f) pos += 4;
    const origLength = base128();
    const version = flags >> 6;
    // glyf and loca are transformed unless version is 3; other tables only when it isn't 0.
    const transformed = known === GLYF || known === LOCA ? version !== 3 : version !== 0;
    const length = transformed ? base128() : origLength;
    if (known === GSUB) gsub = { offset, length };
    offset += length;
  }
  if (!gsub) return [];
  const data: Uint8Array = brotliDecompressSync(file.subarray(pos, pos + compressedSize));
  const table = new DataView(data.buffer, data.byteOffset + gsub.offset, gsub.length);
  const featureList = table.getUint16(6);
  const count = table.getUint16(featureList);
  const tags = new Set<string>();
  for (let i = 0; i < count; i++) {
    const at = featureList + 2 + i * 6;
    tags.add(String.fromCharCode(...[0, 1, 2, 3].map((k) => table.getUint8(at + k))));
  }
  return [...tags].sort();
}
