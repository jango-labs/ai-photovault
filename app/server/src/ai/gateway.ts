import type {
  AiAnalysis, Clock, EmbeddingService, ImageRef, VisionAnalysisService,
} from '@photovault/shared';
import { systemClock } from '@photovault/shared';

export class BudgetError extends Error {
  constructor(public readonly reason: 'KILL_SWITCH' | 'MONTHLY_CAP' | 'RUN_CAP' | 'PHOTO_CAP', message: string) {
    super(message);
  }
}

export interface BudgetPolicy {
  /** false (default) => only the mock provider is ever used. No paid call can happen. */
  liveEnabled: boolean;
  monthlyCapUsd: number;
  perRunCapUsd: number;
  /** Initial testing cap: distinct photo versions that may ever be sent to a live provider. */
  lifetimePhotoCap: number;
}

export const DEFAULT_POLICY: BudgetPolicy = {
  liveEnabled: false,
  monthlyCapUsd: 0,
  perRunCapUsd: 0,
  lifetimePhotoCap: 200,
};

export interface LedgerEntry {
  at: Date; provider: string; model: string; purpose: string;
  estCostUsd: number; photoVersionId?: string; runId?: string;
}
/** Append-only usage ledger. Backed by `ai_usage_ledger` in Postgres from Phase 2. */
export interface Ledger {
  monthSpendUsd(now: Date): Promise<number>;
  runSpendUsd(runId: string): Promise<number>;
  distinctLivePhotos(): Promise<number>;
  hasLivePhoto(photoVersionId: string): Promise<boolean>;
  record(entry: LedgerEntry): Promise<void>;
}

export class MemoryLedger implements Ledger {
  readonly entries: LedgerEntry[] = [];
  async monthSpendUsd(now: Date) {
    return this.entries
      .filter((e) => e.at.getUTCFullYear() === now.getUTCFullYear() && e.at.getUTCMonth() === now.getUTCMonth())
      .reduce((s, e) => s + e.estCostUsd, 0);
  }
  async runSpendUsd(runId: string) {
    return this.entries.filter((e) => e.runId === runId).reduce((s, e) => s + e.estCostUsd, 0);
  }
  async distinctLivePhotos() {
    return new Set(this.entries.map((e) => e.photoVersionId).filter(Boolean)).size;
  }
  async hasLivePhoto(id: string) {
    return this.entries.some((e) => e.photoVersionId === id);
  }
  async record(entry: LedgerEntry) {
    this.entries.push(entry);
  }
}

export interface ProviderSet {
  name: string;
  model: string;
  vision: VisionAnalysisService;
  embedding: EmbeddingService;
  /** Conservative USD estimates used for pre-checks. */
  estimate: { visionUsd: number; embeddingUsd: number };
}

export interface CallMeta { purpose: string; runId?: string; /** offline provider to use when live AI is off */ prefer?: 'local' | 'ollama' | 'mock' }
export interface Provenance { provider: string; model: string; mode: 'mock' | 'local' | 'live' }

/**
 * The only way the server reaches an AI provider. Mock unless `liveEnabled`; refuses (never degrades silently)
 * when a cap would be exceeded. Costs are written to the ledger before the live call is made.
 */
export class AiGateway {
  constructor(
    private readonly deps: {
      mock: ProviderSet; /** offline, measured analysis on this machine (no data leaves, no cost) */ local?: ProviderSet; /** real inference through the Ollama installation on this computer (loopback only, no cost) */ ollama?: ProviderSet; live?: ProviderSet; policy: () => Promise<BudgetPolicy> | BudgetPolicy;
      ledger: Ledger; clock?: Clock;
    },
  ) {}

  private get clock() { return this.deps.clock ?? systemClock; }

  private async pick(photoVersionId: string | undefined, estimate: number, meta: CallMeta): Promise<ProviderSet> {
    const policy = await this.deps.policy();
    const live = this.deps.live;
    if (!policy.liveEnabled || !live) return meta.prefer === 'ollama' && this.deps.ollama ? this.deps.ollama : meta.prefer === 'local' && this.deps.local ? this.deps.local : this.deps.mock;
    const now = this.clock.now();
    if ((await this.deps.ledger.monthSpendUsd(now)) + estimate > policy.monthlyCapUsd)
      throw new BudgetError('MONTHLY_CAP', 'Monthly AI spending cap would be exceeded.');
    if (meta.runId && (await this.deps.ledger.runSpendUsd(meta.runId)) + estimate > policy.perRunCapUsd)
      throw new BudgetError('RUN_CAP', 'Per-run AI spending cap would be exceeded.');
    if (photoVersionId && !(await this.deps.ledger.hasLivePhoto(photoVersionId))
      && (await this.deps.ledger.distinctLivePhotos()) >= policy.lifetimePhotoCap)
      throw new BudgetError('PHOTO_CAP', `Lifetime live-AI photo cap (${policy.lifetimePhotoCap}) reached.`);
    await this.deps.ledger.record({
      at: now, provider: live.name, model: live.model, purpose: meta.purpose,
      estCostUsd: estimate, ...(photoVersionId ? { photoVersionId } : {}), ...(meta.runId ? { runId: meta.runId } : {}),
    });
    return live;
  }

  async analyze(image: ImageRef, context: { folderLocation?: string; year?: number }, meta: CallMeta): Promise<AiAnalysis> {
    const p = await this.pick(image.photoVersionId, (this.deps.live ?? this.deps.mock).estimate.visionUsd, meta);
    return p.vision.analyze(image, context);
  }
  /** Like analyze(), but also says who produced the answer (stored with every analysis). */
  async analyzeWithProvenance(image: ImageRef, context: { folderLocation?: string; year?: number }, meta: CallMeta): Promise<{ analysis: AiAnalysis; provenance: Provenance }> {
    const p = await this.pick(image.photoVersionId, (this.deps.live ?? this.deps.mock).estimate.visionUsd, meta);
    const mode = p === this.deps.live ? 'live' : p === this.deps.local || p === this.deps.ollama ? 'local' : 'mock';
    return { analysis: await p.vision.analyze(image, context), provenance: { provider: p.name, model: p.model, mode } };
  }
  async embedImage(image: ImageRef, meta: CallMeta): Promise<Float32Array> {
    const p = await this.pick(image.photoVersionId, (this.deps.live ?? this.deps.mock).estimate.embeddingUsd, meta);
    return p.embedding.embedImage(image);
  }
  async embedText(text: string, meta: CallMeta): Promise<Float32Array> {
    const p = await this.pick(undefined, (this.deps.live ?? this.deps.mock).estimate.embeddingUsd / 10, meta);
    return p.embedding.embedText(text);
  }
}
