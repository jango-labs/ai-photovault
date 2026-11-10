import sharp from 'sharp';

/**
 * Perceptual fingerprints, computed from the decoded image (read-only):
 *  - pHash: 64 bits from the low-frequency DCT of a 32×32 greyscale thumbnail (robust to resizing, recompression, mild crops);
 *  - dHash: 64 bits from horizontal gradients of a 9×8 thumbnail (cheap second opinion);
 *  - dominant colour as #rrggbb (used as a loading placeholder).
 * Hashes are returned as signed 64-bit BigInts (the database stores bigint).
 */
const N = 32;
const COS: number[][] = Array.from({ length: 8 }, (_, u) => Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))));

function dct8(px: Uint8Array): number[] {
  const out: number[] = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let sum = 0;
    for (let y = 0; y < N; y++) { const cy = COS[v]![y]!; for (let x = 0; x < N; x++) sum += px[y * N + x]! * COS[u]![x]! * cy; }
    out.push(sum);
  }
  return out;
}

export interface Fingerprint { phash: bigint; dhash: bigint; dominant: string }

export async function fingerprint(input: string | Buffer): Promise<Fingerprint> {
  const base = () => sharp(input, { failOn: 'error' }).rotate();                      // honour EXIF orientation: the hash describes the picture as shown
  const [g, g2, stats] = await Promise.all([
    base().resize(N, N, { fit: 'fill' }).greyscale().raw().toBuffer(),
    base().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer(),
    base().resize(64, 64, { fit: 'inside' }).stats(),
  ]);
  const c = dct8(new Uint8Array(g));
  const ac = c.slice(1);                                                                // drop the DC term
  const sorted = [...ac].sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;
  let ph = 0n;
  for (let i = 0; i < 64; i++) ph = (ph << 1n) | (i < 63 ? (ac[i]! > median ? 1n : 0n) : (c[0]! > median ? 1n : 0n));
  let dh = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) dh = (dh << 1n) | (g2[y * 9 + x]! < g2[y * 9 + x + 1]! ? 1n : 0n);
  const d = stats.dominant;
  return { phash: BigInt.asIntN(64, ph), dhash: BigInt.asIntN(64, dh), dominant: `#${[d.r, d.g, d.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` };
}

export const hamming = (a: bigint, b: bigint): number => { let x = BigInt.asUintN(64, a ^ b), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
