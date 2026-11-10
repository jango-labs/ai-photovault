import type { InstagramState } from './status';
import type { ProcessingKind } from './feedback';

/** View-model of one photograph in grids/viewer. (The real one is built from API data in later phases.) */
export interface PhotoItem {
  id: string;
  src: string;
  /** larger rendition for the viewer; falls back to src */
  full?: string;
  width: number;
  height: number;
  title: string;
  /** accessible description; never empty for a shown photograph */
  alt: string;
  rating: number;
  favorite: boolean;
  portfolio: boolean;
  hidden?: boolean;
  ig: { state: InstagramState; count?: number };
  /** a high-scoring unconfirmed match with an Instagram post exists (review before posting again) */
  possibleDuplicate?: boolean;
  /** unresolved near-duplicate pair in the library (perceptual hash) */
  duplicateCandidate?: boolean;
  /** dominant colour of the photograph: shown while the image loads (no layout shift, no flash) */
  dominant?: string | null;
  aiScore?: number;
  processing?: ProcessingKind;
  species?: string;
  place?: string;
  capturedAt?: string;
}
