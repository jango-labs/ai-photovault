import path from 'node:path';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { withUser } from '../db/connect.js';
import { PermanentJobError, type Handler, type Job } from '../jobs/worker.js';
import { FiltersSchema, whereFor, type Filters } from '../library/query.js';
import { mockProvider } from '../providers/mock.js';
import { AiGateway, DEFAULT_POLICY, MemoryLedger, type BudgetPolicy, type ProviderSet } from './gateway.js';
import { OLLAMA_EMBED_DIMS, OLLAMA_PROMPT_VERSION, OllamaClient, documentText, ollamaTextEmbedding, ollamaVision } from './ollama.js';
import { toVectorLiteral } from '../search/embedding.js';
import { LOCAL_MODEL, LOCAL_PROMPT_VERSION, localVision } from './local-vision.js';
import { makeMockEmbedding } from '../providers/mock.js';

export const PROMPT_VERSION = LOCAL_PROMPT_VERSION;
export const PROVIDERS = ['local-image', 'ollama', 'mock'] as const;
export type ProviderChoice = (typeof PROVIDERS)[number];
/** the name an analysis is stored under, and the prompt version it was written with, for each provider choice */
export const providerName = (c: ProviderChoice): string => c;
export const promptVersionFor = (c: ProviderChoice): string => (c === 'ollama' ? OLLAMA_PROMPT_VERSION : LOCAL_PROMPT_VERSION);

/** The offline provider sets. There is deliberately no hosted set here: live AI needs your approval, a key and a budget row. */
export const localProvider: ProviderSet = { name: 'local-image', model: LOCAL_MODEL, vision: localVision, embedding: makeMockEmbedding(), estimate: { visionUsd: 0, embeddingUsd: 0 } };

export const SettingsSchema = z.object({ provider: z.enum(PROVIDERS).optional(), autoAnalyze: z.boolean().optional() }).strict().refine((s) => Object.keys(s).length > 0, 'nothing to change');
export const AnalyzeSchema = z.object({
  target: z.union([z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }).strict(), z.object({ query: FiltersSchema, exclude: z.array(z.string().uuid()).max(1000).default([]) }).strict()]),
  force: z.boolean().default(false),
}).strict();
export type AnalyzeTarget = z.infer<typeof AnalyzeSchema>['target'];

export interface AiSettings { provider: ProviderChoice; autoAnalyze: boolean }
const DEFAULT_SETTINGS: AiSettings = { provider: 'local-image', autoAnalyze: true };

export async function loadSettings(tx: Sql, userId: string): Promise<AiSettings> {
  const [r] = await tx<{ ai: Partial<AiSettings> | null }[]>`SELECT settings -> 'ai' AS ai FROM user_settings WHERE user_id = ${userId}`;
  const ai = r?.ai ?? {};
  return { provider: PROVIDERS.includes(ai.provider as ProviderChoice) ? (ai.provider as ProviderChoice) : DEFAULT_SETTINGS.provider, autoAnalyze: typeof ai.autoAnalyze === 'boolean' ? ai.autoAnalyze : DEFAULT_SETTINGS.autoAnalyze };
}

/** What the budget row allows. Live AI is off unless an explicit approval is recorded; this build also has no hosted provider to enable. */
export async function loadPolicy(tx: Sql, userId: string): Promise<BudgetPolicy> {
  const [b] = await tx<{ live_enabled: boolean; monthly_cap_usd: string; per_run_cap_usd: string; lifetime_photo_cap: number }[]>`SELECT live_enabled, monthly_cap_usd, per_run_cap_usd, lifetime_photo_cap FROM ai_budget WHERE user_id = ${userId}`;
  return b ? { liveEnabled: b.live_enabled, monthlyCapUsd: Number(b.monthly_cap_usd), perRunCapUsd: Number(b.per_run_cap_usd), lifetimePhotoCap: b.lifetime_photo_cap } : DEFAULT_POLICY;
}

/** The Ollama provider set: real local inference on this computer (loopback only, no cost). Constructing it contacts nothing. */
export const ollamaProvider = (client: OllamaClient): ProviderSet => ({ name: 'ollama', model: client.cfg.visionModel, vision: ollamaVision(client), embedding: { ...makeMockEmbedding(), embedText: (t: string) => ollamaTextEmbedding(client).embedText(t) }, estimate: { visionUsd: 0, embeddingUsd: 0 } });
export function makeGateway(client: OllamaClient = new OllamaClient()): AiGateway { return new AiGateway({ mock: mockProvider, local: localProvider, ollama: ollamaProvider(client), policy: () => DEFAULT_POLICY, ledger: new MemoryLedger() }); }

// ------------------------------------------------------------------------------------------------ the job
/** Worker job `ai.analyze` {photoId, versionId, force?}: analyse the preview of one version and store the result (analyses are immutable; a re-analysis is a new row). */
export function analyzeHandler(sql: Sql, derivativesDir: string, gateway: AiGateway = makeGateway()): Handler {                // `ollama` provider: real local model; any failure is retried, never silently replaced by another provider
  return async (job: Job) => {
    const versionId = String(job.payload.versionId ?? ''); const force = job.payload.force === true;
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new PermanentJobError('malformed job: no version id')
    const [v] = await sql<{ id: string; photo_id: string; deriv_status: string; state: string; location: string | null; year: number | null }[]>`
      SELECT v.id, v.photo_id, v.deriv_status, v.state, p.trip_location AS location, p.year FROM photo_versions v JOIN photos p ON p.id = v.photo_id WHERE v.id = ${versionId}::uuid AND v.user_id = ${job.user_id}`;
    if (!v) throw new PermanentJobError('the version no longer exists');
    if (v.deriv_status === 'FAILED') throw new PermanentJobError('no preview could be made for this photograph');
    if (v.deriv_status !== 'READY') throw new Error('the preview is not ready yet');                                       // retried with backoff
    const settings = await loadSettings(sql, job.user_id);
    const pname = providerName(settings.provider); const pver = promptVersionFor(settings.provider);
    if (!force) {
      const [have] = await sql`SELECT 1 FROM ai_analyses WHERE photo_version_id = ${versionId}::uuid AND provider = ${pname} AND prompt_version = ${pver} LIMIT 1`;
      if (have) return;
    }
    const { analysis: a, provenance } = await gateway.analyzeWithProvenance({ photoVersionId: versionId, previewPath: path.join(derivativesDir, versionId, 'view.jpg') },
      { ...(v.location ? { folderLocation: v.location } : {}), ...(v.year ? { year: v.year } : {}) }, { purpose: 'analysis', prefer: settings.provider === 'mock' ? 'mock' : settings.provider === 'ollama' ? 'ollama' : 'local' });
    await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO ai_analyses (user_id, photo_version_id, provider, model, prompt_version, mode, primary_subject, secondary_subjects, objects, scenes, environment, categories, tags, description, suggested_title,
                                 style, lighting, location_clues, dominant_color_names, wildlife, scores, overall_score, confidence)
        VALUES (${job.user_id}, ${versionId}::uuid, ${provenance.provider}, ${provenance.model}, ${pver}, ${provenance.mode}, ${a.primarySubject}, ${a.secondarySubjects}::text[], ${a.objects}::text[], ${a.scenes}::text[], ${a.environment},
                ${a.categories}::text[], ${a.tags}::text[], ${a.description}, ${a.suggestedTitle || null}, ${a.style}, ${a.lighting}, ${a.locationClues}, ${a.dominantColorNames}::text[], ${tx.json(a.wildlife as never)}, ${tx.json(a.scores as never)}, ${a.scores.overall}, ${tx.json(a.confidence as never)})
        RETURNING id`;
      for (const w of a.wildlife) {
        const [sp] = await tx<{ id: string }[]>`INSERT INTO species (user_id, common_name, scientific_name, taxon_rank) VALUES (${job.user_id}, ${w.commonName}, ${w.scientificName}, 'species')
          ON CONFLICT (user_id, lower(common_name)) DO UPDATE SET scientific_name = coalesce(species.scientific_name, excluded.scientific_name) RETURNING id`;
        // only SUGGESTED rows are refreshed: what you confirmed or rejected is never overwritten or proposed again
        await tx`INSERT INTO photo_species (user_id, photo_id, species_id, analysis_id, subject_count, behavior, habitat, confidence, source, status)
                 VALUES (${job.user_id}, ${v.photo_id}::uuid, ${sp!.id}::uuid, ${row!.id}::uuid, ${w.count}, ${w.behavior}, ${w.habitat}, ${w.confidence}, 'AI_INFERRED', 'SUGGESTED')
                 ON CONFLICT (photo_id, species_id) DO UPDATE SET analysis_id = excluded.analysis_id, subject_count = excluded.subject_count, behavior = excluded.behavior, habitat = excluded.habitat, confidence = excluded.confidence
                 WHERE photo_species.status = 'SUGGESTED' AND photo_species.source = 'AI_INFERRED'`;
      }
      // meaning-based search needs a text embedding of what the model wrote: queued here, written by `embed.text`
      if (settings.provider === 'ollama') await tx`INSERT INTO jobs (user_id, kind, payload, dedupe_key) VALUES (${job.user_id}, 'embed.text', ${tx.json({ versionId } as never)}, ${`embedtext:${row!.id}`}) ON CONFLICT DO NOTHING`;
    });
  };
}

/** Worker job `embed.text` {versionId}: embeds the newest local-model description of a photograph (with the facts the library knows) for meaning-based search. */
export function embedTextHandler(sql: Sql, client: OllamaClient = new OllamaClient()): Handler {
  const embedder = ollamaTextEmbedding(client);
  return async (job: Job) => {
    const versionId = String(job.payload.versionId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) throw new PermanentJobError('malformed job: no version id');
    const [r] = await sql<{ primary_subject: string | null; description: string | null; tags: string[]; scenes: string[]; environment: string | null; style: string | null; lighting: string | null; place: string | null; keywords: string[]; keywords_hier: string[]; city: string | null; state: string | null; country: string | null; sublocation: string | null; camera: string | null }[]>`
      SELECT a.primary_subject, a.description, a.tags, a.scenes, a.environment, a.style, a.lighting, p.trip_location AS place, v.keywords, v.keywords_hier, p.place_city AS city, p.place_state AS state, p.place_country AS country, p.place_sublocation AS sublocation, v.camera_model AS camera
        FROM ai_analyses a JOIN photo_versions v ON v.id = a.photo_version_id JOIN photos p ON p.id = v.photo_id
       WHERE a.photo_version_id = ${versionId}::uuid AND a.user_id = ${job.user_id} AND a.provider IN ('ollama', 'demo') ORDER BY a.created_at DESC LIMIT 1`;
    if (!r) throw new PermanentJobError('there is no local-model analysis to embed');
    const text = documentText({ primarySubject: r.primary_subject, description: r.description, tags: r.tags, scenes: r.scenes, environment: r.environment, style: r.style, lighting: r.lighting }, { place: r.place, placeNames: [r.sublocation, r.city, r.state, r.country].filter((x): x is string => !!x), keywords: [...r.keywords, ...r.keywords_hier.map((h) => h.replace(/\|/g, ' '))], camera: r.camera });
    const vec = await embedder.embedText(text);
    if (vec.length !== OLLAMA_EMBED_DIMS) throw new PermanentJobError(`the embedding model returned ${vec.length} numbers, expected ${OLLAMA_EMBED_DIMS}`);
    await sql`INSERT INTO photo_embeddings (user_id, photo_version_id, model, kind, dimensions, embedding)
              VALUES (${job.user_id}, ${versionId}::uuid, ${embedder.model}, 'text', ${OLLAMA_EMBED_DIMS}, ${toVectorLiteral(vec)}::halfvec)
              ON CONFLICT (photo_version_id, model, kind) DO UPDATE SET embedding = excluded.embedding, created_at = now()`;
  };
}

// ------------------------------------------------------------------------------------------------ queries used by the API
export class AiService {
  private probeCache: { at: number; value: Awaited<ReturnType<OllamaClient['status']>> } | null = null;
  constructor(private readonly sql: Sql, private readonly ollama: OllamaClient = new OllamaClient()) {}
  /** Is the local model service usable right now? (cached 15 s; read-only call to the Ollama installation) */
  async ollamaStatus() { if (this.probeCache && Date.now() - this.probeCache.at < 15_000) return this.probeCache.value; const value = await this.ollama.status(); this.probeCache = { at: Date.now(), value }; return value; }

  /** why the Ollama provider cannot be chosen right now, or null */
  async ollamaBlocker(): Promise<string | null> { const p = await this.ollamaStatus(); return p.reachable && p.visionReady ? null : (p.reason ?? 'Ollama is not reachable'); }
  getSettings(userId: string): Promise<AiSettings> { return withUser(this.sql, userId, (tx) => loadSettings(tx, userId)); }

  async setSettings(userId: string, patch: z.infer<typeof SettingsSchema>): Promise<AiSettings> {
    return withUser(this.sql, userId, async (tx) => {
      const cur = await loadSettings(tx, userId); const next = { ...cur, ...patch };
      await tx`INSERT INTO user_settings (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
      await tx`UPDATE user_settings SET settings = jsonb_set(settings, '{ai}', ${tx.json(next as never)}, true) WHERE user_id = ${userId}`;
      return next;
    });
  }

  async status(userId: string) {
    const probe = await this.ollamaStatus();
    return withUser(this.sql, userId, async (tx) => {
      const settings = await loadSettings(tx, userId); const PROMPT_VERSION = promptVersionFor(settings.provider); const policy = await loadPolicy(tx, userId);
      const [c] = await tx<{ photos: number; analysed: number; stale: number }[]>`
        SELECT count(*)::int AS photos,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_analyses a WHERE a.photo_version_id = p.current_version_id))::int AS analysed,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ai_analyses a WHERE a.photo_version_id = p.current_version_id) AND NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.photo_version_id = p.current_version_id AND a.prompt_version = ${PROMPT_VERSION}))::int AS stale
          FROM photos p WHERE p.deleted_at IS NULL AND NOT p.hidden`;
      const jobs = await tx<{ state: string; n: number }[]>`SELECT state, count(*)::int AS n FROM jobs WHERE kind = 'ai.analyze' GROUP BY state`;
      const [b] = await tx<{ live_enabled: boolean; lifetime_photo_cap: number; approved_at: Date | null }[]>`SELECT live_enabled, lifetime_photo_cap, approved_at FROM ai_budget WHERE user_id = ${userId}`;
      const [led] = await tx<{ n: number; usd: string | null }[]>`SELECT count(*)::int AS n, sum(est_cost_usd)::text AS usd FROM ai_usage_ledger`;
      return {
        settings, promptVersion: PROMPT_VERSION, photos: c!.photos, analysed: c!.analysed, stale: c!.stale, jobs: Object.fromEntries(jobs.map((j) => [j.state, j.n])),
        providers: [
          { id: 'local-image', label: 'Local image analysis', kind: 'local', available: true, note: 'Runs on this computer. Measures sharpness, exposure, contrast, colour and composition. Does not identify species or places.' },
          { id: 'ollama', label: `Local vision model via Ollama (${probe.visionModel})`, kind: 'local', available: probe.reachable && probe.visionReady, ready: probe.reachable && probe.visionReady && probe.embedReady, reason: probe.reason,
            note: probe.reachable && probe.visionReady ? 'Real inference on this computer through your Ollama installation: subjects, scenes, tags, descriptions, composition and quality opinions, and meaning-based search. Photographs never leave this computer. It is slow (about 20 s per photograph) and shares memory with your other applications.' : `Not available: ${probe.reason ?? 'Ollama is not reachable'}.` },
          { id: 'mock', label: 'Mock (for testing)', kind: 'mock', available: true, note: 'Deterministic fake answers, labelled [MOCK]. Useful for trying the interface.' },
          { id: 'hosted', label: 'Hosted vision model (species, behaviour, scenes)', kind: 'live', available: false, note: 'Off. Needs your approval, an API key and a spending cap. Nothing has been sent anywhere.' },
        ],
        live: { enabled: policy.liveEnabled && !!b?.approved_at, lifetimePhotoCap: policy.lifetimePhotoCap, spendRecords: led!.n, spentUsd: Number(led!.usd ?? 0) },
      };
    });
  }

  /** Queues analyses for the current version of the chosen photographs that have a preview and (unless `force`) no analysis from the current provider/prompt yet. */
  async enqueue(userId: string, target: AnalyzeTarget, force: boolean): Promise<{ queued: number; alreadyAnalysed: number; waitingForPreviews: number }> {
    return withUser(this.sql, userId, async (tx) => {
      const settings = await loadSettings(tx, userId); const provider = providerName(settings.provider); const PROMPT_VERSION = promptVersionFor(settings.provider);
      const scope = 'ids' in target
        ? tx`p.id = ANY(${target.ids}::uuid[]) AND p.deleted_at IS NULL`
        : tx`p.id IN (SELECT p.id FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${whereFor(tx, FiltersSchema.parse(target.query as Filters))} AND p.id <> ALL(${target.exclude}::uuid[]))`;
      const [cnt] = await tx<{ total: number; waiting: number; have: number }[]>`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE v.deriv_status <> 'READY')::int AS waiting,
               count(*) FILTER (WHERE v.deriv_status = 'READY' AND EXISTS (SELECT 1 FROM ai_analyses a WHERE a.photo_version_id = v.id AND a.provider = ${provider} AND a.prompt_version = ${PROMPT_VERSION}))::int AS have
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id WHERE ${scope}`;
      const stamp = force ? `:${Date.now()}` : '';
      const rows = await tx`
        INSERT INTO jobs (user_id, kind, payload, dedupe_key)
        SELECT ${userId}, 'ai.analyze', jsonb_build_object('photoId', p.id, 'versionId', v.id, 'force', ${force}::boolean), ${`ai:`} || v.id::text || ':' || ${PROMPT_VERSION} || ${stamp}
          FROM photos p JOIN photo_versions v ON v.id = p.current_version_id
         WHERE ${scope} AND v.deriv_status = 'READY'
           AND (${force}::boolean OR NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.photo_version_id = v.id AND a.provider = ${provider} AND a.prompt_version = ${PROMPT_VERSION}))
        ON CONFLICT DO NOTHING RETURNING 1`;
      return { queued: rows.length, alreadyAnalysed: force ? 0 : cnt!.have, waitingForPreviews: cnt!.waiting };
    });
  }

  async photo(userId: string, photoId: string) {
    return withUser(this.sql, userId, async (tx) => {
      const [p] = await tx<{ current_version_id: string }[]>`SELECT current_version_id FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL`;
      if (!p) return null;
      const analyses = await tx<Array<{ id: string; provider: string; model: string; mode: string; prompt_version: string; created_at: Date; primary_subject: string | null; description: string | null; tags: string[]; scores: Record<string, number | null>; overall_score: number | null; dominant_color_names: string[]; lighting: string | null; style: string | null; version_id: string }>>`
        SELECT a.id, a.provider, a.model, a.mode, a.prompt_version, a.created_at, a.primary_subject, a.description, a.tags, a.scores, a.overall_score, a.dominant_color_names, a.lighting, a.style, a.photo_version_id AS version_id
          FROM ai_analyses a JOIN photo_versions v ON v.id = a.photo_version_id WHERE v.photo_id = ${photoId}::uuid ORDER BY a.created_at DESC LIMIT 20`;
      const species = await tx<Array<{ id: string; name: string; scientific: string | null; confidence: number | null; status: string; source: string; behavior: string | null; habitat: string | null; count: number | null; analysis_id: string | null }>>`
        SELECT ps.id, s.common_name AS name, s.scientific_name AS scientific, ps.confidence, ps.status, ps.source, ps.behavior, ps.habitat, ps.subject_count AS count, ps.analysis_id
          FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.photo_id = ${photoId}::uuid ORDER BY (ps.status = 'REJECTED'), ps.confidence DESC NULLS LAST`;
      const corrections = await tx<Array<{ id: string; kind: string; before: unknown; after: unknown; at: Date }>>`SELECT id, kind, before, after, at FROM ai_corrections WHERE photo_id = ${photoId}::uuid ORDER BY at DESC, id DESC LIMIT 50`;
      const queued = await tx<{ state: string }[]>`SELECT state FROM jobs WHERE kind = 'ai.analyze' AND payload ->> 'photoId' = ${photoId} AND state IN ('QUEUED','RUNNING') LIMIT 1`;
      return {
        currentVersionId: p.current_version_id, queued: queued.length > 0,
        analyses: analyses.map((a) => ({ id: a.id, provider: a.provider, model: a.model, mode: a.mode, promptVersion: a.prompt_version, stale: a.prompt_version !== (a.provider === 'ollama' ? OLLAMA_PROMPT_VERSION : PROMPT_VERSION), createdAt: a.created_at.toISOString(), primarySubject: a.primary_subject, description: a.description, tags: a.tags, scores: a.scores, overall: a.overall_score, colours: a.dominant_color_names, lighting: a.lighting, style: a.style, current: a.version_id === p.current_version_id })),
        species: species.map((s) => ({ ...s })), corrections: corrections.map((c) => ({ id: c.id, kind: c.kind, before: c.before, after: c.after, at: c.at.toISOString() })),
      };
    });
  }

  /** confirm / reject an AI suggestion. A rejected suggestion is remembered and never proposed again. */
  async decideSpecies(userId: string, photoId: string, linkId: string, action: 'confirm' | 'reject'): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => {
      const [cur] = await tx<{ id: string; status: string; name: string; confidence: number | null; analysis_id: string | null }[]>`
        SELECT ps.id, ps.status, s.common_name AS name, ps.confidence, ps.analysis_id FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.id = ${linkId}::uuid AND ps.photo_id = ${photoId}::uuid FOR UPDATE OF ps`;
      if (!cur) return false;
      const next = action === 'confirm' ? 'CONFIRMED' : 'REJECTED';
      if (cur.status !== next) {
        await tx`UPDATE photo_species SET status = ${next} WHERE id = ${linkId}::uuid`;
        await tx`INSERT INTO ai_corrections (user_id, photo_id, analysis_id, kind, before, after) VALUES (${userId}, ${photoId}::uuid, ${cur.analysis_id}, ${action === 'confirm' ? 'SPECIES_CONFIRM' : 'SPECIES_REJECT'}, ${tx.json({ species: cur.name, status: cur.status, confidence: cur.confidence } as never)}, ${tx.json({ species: cur.name, status: next } as never)})`;
      }
      return true;
    });
  }

  /** Name the species yourself (optionally replacing a wrong suggestion). Stored as yours: CONFIRMED, source USER_DEFINED. */
  async addSpecies(userId: string, photoId: string, input: { commonName: string; scientificName?: string | null; replaces?: string }): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => {
      const [p] = await tx`SELECT 1 FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL`; if (!p) return false;
      let before: unknown = null; let analysisId: string | null = null;
      if (input.replaces) {
        const [old] = await tx<{ id: string; name: string; analysis_id: string | null; status: string }[]>`SELECT ps.id, s.common_name AS name, ps.analysis_id, ps.status FROM photo_species ps JOIN species s ON s.id = ps.species_id WHERE ps.id = ${input.replaces}::uuid AND ps.photo_id = ${photoId}::uuid FOR UPDATE OF ps`;
        if (!old) return false;
        await tx`UPDATE photo_species SET status = 'REJECTED' WHERE id = ${old.id}::uuid`; before = { species: old.name, status: old.status }; analysisId = old.analysis_id;
      }
      const [sp] = await tx<{ id: string }[]>`INSERT INTO species (user_id, common_name, scientific_name, taxon_rank) VALUES (${userId}, ${input.commonName}, ${input.scientificName ?? null}, 'species')
        ON CONFLICT (user_id, lower(common_name)) DO UPDATE SET scientific_name = coalesce(species.scientific_name, excluded.scientific_name) RETURNING id`;
      await tx`INSERT INTO photo_species (user_id, photo_id, species_id, source, status) VALUES (${userId}, ${photoId}::uuid, ${sp!.id}::uuid, 'USER_DEFINED', 'CONFIRMED')
               ON CONFLICT (photo_id, species_id) DO UPDATE SET status = 'CONFIRMED', source = 'USER_DEFINED', confidence = NULL`;
      await tx`INSERT INTO ai_corrections (user_id, photo_id, analysis_id, kind, before, after) VALUES (${userId}, ${photoId}::uuid, ${analysisId}, ${input.replaces ? 'SPECIES_CORRECT' : 'SPECIES_ADD'}, ${tx.json(before as never)}, ${tx.json({ species: input.commonName, scientific: input.scientificName ?? null, status: 'CONFIRMED' } as never)})`;
      return true;
    });
  }

  /** Use an AI description as the photograph's description (provenance AI_INFERRED, recorded in the edit history so it can be undone). */
  async acceptDescription(userId: string, photoId: string, analysisId: string): Promise<boolean> {
    return withUser(this.sql, userId, async (tx) => {
      const [a] = await tx<{ description: string | null }[]>`SELECT a.description FROM ai_analyses a JOIN photo_versions v ON v.id = a.photo_version_id WHERE a.id = ${analysisId}::uuid AND v.photo_id = ${photoId}::uuid`;
      const [p] = await tx<{ description: string | null; description_source: string | null }[]>`SELECT description, description_source FROM photos WHERE id = ${photoId}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!a?.description || !p) return false;
      await tx`UPDATE photos SET description = ${a.description}, description_source = 'AI_INFERRED' WHERE id = ${photoId}::uuid`;
      await tx`INSERT INTO photo_edits (user_id, photo_id, field, old_value, new_value, old_source, new_source, kind) VALUES (${userId}, ${photoId}::uuid, 'description', ${tx.json((p.description ?? null) as never)}, ${tx.json(a.description as never)}, ${p.description_source}, 'AI_INFERRED', 'EDIT')`;
      await tx`INSERT INTO ai_corrections (user_id, photo_id, analysis_id, kind, before, after) VALUES (${userId}, ${photoId}::uuid, ${analysisId}::uuid, 'DESCRIPTION_ACCEPT', ${tx.json({ description: p.description } as never)}, ${tx.json({ description: a.description } as never)})`;
      return true;
    });
  }
}
