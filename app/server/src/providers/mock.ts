import { createHash } from 'node:crypto';
import type { AiAnalysis, EmbeddingService, ImageRef, VisionAnalysisService } from '@photovault/shared';
import type { ProviderSet } from '../ai/gateway.js';

function seed(s: string): () => number {
  let h = createHash('sha256').update(s).digest().readUInt32LE(0) || 1;
  return () => ((h = (Math.imul(h, 1664525) + 1013904223) >>> 0) / 0xffffffff);
}

const SUBJECTS = ['African elephant', 'leopard', 'lion', 'bald eagle', 'giraffe', 'zebra'];

/** Deterministic fake analysis: lets the whole pipeline and UI run at zero cost. Clearly labelled as mock. */
export const mockVision: VisionAnalysisService = {
  async analyze(image: ImageRef): Promise<AiAnalysis> {
    const r = seed(image.photoVersionId);
    const subject = SUBJECTS[Math.floor(r() * SUBJECTS.length)] ?? 'animal';
    const s = () => Math.round(r() * 100) / 100;
    return {
      primarySubject: subject, secondarySubjects: [], objects: [subject], scenes: ['savanna'], environment: 'savanna',
      categories: ['wildlife'], tags: [subject, 'wildlife', 'mock'], description: `[MOCK] ${subject} photographed in the wild.`,
      suggestedTitle: `[MOCK] ${subject}`, style: null, lighting: null, locationClues: null, dominantColorNames: ['amber'],
      wildlife: [{ commonName: subject, scientificName: null, count: 1, behavior: null, habitat: null, confidence: 0.5 }],
      scores: { composition: s(), subjectIsolation: s(), lighting: s(), impact: s(), storytelling: s(), uniqueness: s(), overall: s() },
      confidence: { primarySubject: 0.5 },
    };
  },
};

export function makeMockEmbedding(dimensions = 1024): EmbeddingService {
  const embed = (key: string) => {
    const r = seed(key);
    const v = Float32Array.from({ length: dimensions }, () => r() - 0.5);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  return {
    model: 'mock-embedding', dimensions,
    async embedImage(image) { return embed(`img:${image.photoVersionId}`); },
    async embedText(text) { return embed(`txt:${text}`); },
  };
}

export const mockProvider: ProviderSet = {
  name: 'mock', model: 'mock', vision: mockVision, embedding: makeMockEmbedding(),
  estimate: { visionUsd: 0, embeddingUsd: 0 },
};
