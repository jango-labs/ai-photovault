import { z } from 'zod';

const conf = z.number().min(0).max(1);

export const WildlifeSubject = z.object({
  commonName: z.string(),
  scientificName: z.string().nullable(),
  count: z.number().int().nonnegative().nullable(),
  behavior: z.string().nullable(),
  habitat: z.string().nullable(),
  confidence: conf,
});

/** Output contract of VisionAnalysisService. Uncertain inferences must carry confidence. */
export const AiAnalysis = z.object({
  primarySubject: z.string(),
  secondarySubjects: z.array(z.string()),
  objects: z.array(z.string()),
  scenes: z.array(z.string()),
  environment: z.string().nullable(),
  categories: z.array(z.string()),
  tags: z.array(z.string()),
  description: z.string(),
  suggestedTitle: z.string(),
  style: z.string().nullable(),
  lighting: z.string().nullable(),
  locationClues: z.string().nullable(),
  dominantColorNames: z.array(z.string()),
  wildlife: z.array(WildlifeSubject),
  scores: z.object({
    composition: conf, subjectIsolation: conf, lighting: conf, impact: conf,
    /** not measurable without a vision model: null = "not assessed" (never a made-up number) */
    storytelling: conf.nullable(), uniqueness: conf.nullable(), overall: conf,
    /** measured image quality (local analysis); optional for model-based providers */
    sharpness: conf.optional(), exposure: conf.optional(),
  }),
  confidence: z.record(z.string(), conf),
});
export type AiAnalysis = z.infer<typeof AiAnalysis>;

export type ProviderMode = 'mock' | 'live';
