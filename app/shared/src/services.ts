import type { AiAnalysis } from './ai.js';

/** Where an image can be read from. Providers receive bytes/paths; they never see library roots. */
export interface ImageRef {
  photoVersionId: string;
  /** Absolute path of a local derivative (preview 1600 px), never of an original. */
  previewPath: string;
}

export interface VisionAnalysisService {
  analyze(image: ImageRef, context: { folderLocation?: string; year?: number }): Promise<AiAnalysis>;
}

export interface EmbeddingService {
  readonly model: string;
  readonly dimensions: number;
  embedImage(image: ImageRef): Promise<Float32Array>;
  embedText(text: string): Promise<Float32Array>;
}

export interface CaptionService {
  generate(input: { photoVersionId: string; style: 'STORYTELLING' | 'EDUCATIONAL' | 'SHORT'; brief?: string }): Promise<string[]>;
}

export interface SpeciesSuggestion {
  commonName: string;
  scientificName: string | null;
  confidence: number;
}
export interface SpeciesIdentificationService {
  suggest(image: ImageRef): Promise<SpeciesSuggestion[]>;
}

/** Neutral social-platform boundary; Meta quirks stay inside InstagramService. */
export type PlatformErrorCode =
  | 'AUTH_EXPIRED' | 'MEDIA_REJECTED' | 'RATE_LIMITED' | 'TRANSIENT' | 'NETWORK_DOWN' | 'UNKNOWN_OUTCOME';
export interface RemoteMedia {
  platformMediaId: string;
  permalink?: string;
  postedAt: Date;
  caption: string;
  mediaType: string;
  mediaUrl?: string;
}
export interface SocialPlatformService {
  listMedia(opts: { since?: Date; cursor?: string }): Promise<{ items: RemoteMedia[]; nextCursor?: string }>;
  createPublishContainer(input: { imageUrl: string; caption: string; altText?: string }): Promise<{ containerId: string }>;
  containerStatus(containerId: string): Promise<'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED'>;
  publishContainer(containerId: string): Promise<{ platformPostId: string }>;
  verifyPublished(platformPostId: string): Promise<{ permalink: string; postedAt: Date; caption: string } | null>;
  getQuota(): Promise<{ used: number; total: number }>;
}

/** Makes a locally stored temporary JPEG fetchable by Meta for a short time. */
export interface DeliveredImage {
  url: string;
  expiresAt: Date;
  revoke(): Promise<void>;
}
export interface ImageDeliveryProvider {
  readonly name: 'mock' | 'tunnel' | 'object-store';
  deliver(input: { localPath: string; publicationId: string; ttlSeconds: number }): Promise<DeliveredImage>;
}
