import sharp from 'sharp';
import type { EmbeddingService, ImageRef } from '@photovault/shared';

/**
 * LOCAL visual embedding: a 256-number description of how a picture LOOKS — its coarse layout of colour (8×8×3 = 192 values) and
 * its colour histogram (4×4×4 = 64 bins) — compared with cosine similarity. It finds photographs that look alike (same scene, same
 * light, same composition, re-exports, crops of the same frame). It does not know what is IN the picture, so it cannot match a
 * text description to an image; text search uses full-text search instead (and a real embedding model, if you approve one later).
 */
export const LOCAL_EMBEDDING_MODEL = 'local-visual-v1';
export const LOCAL_EMBEDDING_DIMS = 256;

export class TextEmbeddingNotSupported extends Error {
  constructor() { super('The local visual model cannot embed text. Text search uses full-text search; matching words to pictures needs an embedding model that you would have to approve.'); }
}

export function layoutAndHistogram(rgb8x8: Uint8Array, rgb32: Uint8Array): Float32Array {
  const out = new Float32Array(LOCAL_EMBEDDING_DIMS);
  // layout: the 8×8 colour grid with its overall mean removed (so brightness shifts matter less than structure)
  let mean = 0; for (let i = 0; i < 192; i++) mean += rgb8x8[i]!; mean /= 192;
  let n1 = 0; for (let i = 0; i < 192; i++) { const v = (rgb8x8[i]! - mean) / 255; out[i] = v; n1 += v * v; }
  const s1 = n1 > 0 ? 0.8 / Math.sqrt(n1) : 0; for (let i = 0; i < 192; i++) out[i]! *= s1;
  // colour histogram on a 32×32 version, 4 levels per channel, square-rooted (so a few dominant colours do not drown the rest)
  const hist = new Float32Array(64);
  for (let i = 0; i < rgb32.length; i += 3) hist[((rgb32[i]! >> 6) << 4) | ((rgb32[i + 1]! >> 6) << 2) | (rgb32[i + 2]! >> 6)]! += 1;
  let n2 = 0; for (let i = 0; i < 64; i++) { const v = Math.sqrt(hist[i]! / (rgb32.length / 3)); hist[i] = v; n2 += v * v; }
  const s2 = n2 > 0 ? 0.6 / Math.sqrt(n2) : 0; for (let i = 0; i < 64; i++) out[192 + i] = hist[i]! * s2;
  const norm = Math.hypot(...out) || 1; for (let i = 0; i < out.length; i++) out[i]! /= norm;
  return out;
}

export async function embedFile(path: string): Promise<Float32Array> {
  const base = () => sharp(path, { failOn: 'error' }).rotate().removeAlpha();
  const [a, b] = await Promise.all([base().resize(8, 8, { fit: 'fill' }).raw().toBuffer(), base().resize(32, 32, { fit: 'fill' }).raw().toBuffer()]);
  return layoutAndHistogram(new Uint8Array(a), new Uint8Array(b));
}

export const cosine = (a: Float32Array, b: Float32Array): number => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!; return d; };
/** pgvector text form, e.g. "[0.1,0.2]" (rounded: the column is half precision anyway) */
export const toVectorLiteral = (v: Float32Array): string => `[${Array.from(v, (x) => x.toFixed(5)).join(',')}]`;

export const localEmbedding: EmbeddingService = {
  model: LOCAL_EMBEDDING_MODEL, dimensions: LOCAL_EMBEDDING_DIMS,
  async embedImage(image: ImageRef) { return embedFile(image.previewPath); },
  async embedText() { throw new TextEmbeddingNotSupported(); },
};
