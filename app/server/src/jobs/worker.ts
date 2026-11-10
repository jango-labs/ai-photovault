import type { Sql } from 'postgres';

/**
 * Lease-based job worker over the `jobs` table (claim_jobs uses FOR UPDATE SKIP LOCKED; an expired lease re-queues the job,
 * so a crashed worker loses nothing). Retries use exponential backoff; a job that fails `max_attempts` times becomes DEAD;
 * a handler may throw `PermanentJobError` to fail a job without retrying. Concurrency is bounded.
 */
export class PermanentJobError extends Error {}

export interface Job { id: string; user_id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }
export type Handler = (job: Job) => Promise<void>;
export interface WorkerOptions { /** Kinds of work that are heavy on memory or the GPU (local AI). At most `heavyConcurrency` of them run at once, and none are started while `pressure` returns a reason. */ heavyKinds?: string[]; heavyConcurrency?: number; pressure?: () => Promise<string | null>; /** called when the resource hold changes (reason, or null) */ onPressure?: (reason: string | null) => void; /** Returns a reason while the worker must not work (for example the photo drive is unplugged), otherwise null. While it returns a reason NO job is claimed; a job already running that fails while it does is put back WITHOUT using up an attempt. */ gate?: () => Promise<string | null>; /** called whenever the paused state changes (reason, or null when work resumes) */ onPause?: (reason: string | null) => void; /** called once a job will not be retried (permanent error, or attempts exhausted) */ onDead?: (job: Job, error: string) => Promise<void>; workerId?: string; leaseSeconds?: number; concurrency?: number; backoffBaseSeconds?: number; now?: () => Date }

export const backoffSeconds = (attempt: number, base = 30): number => Math.min(3600, base * 2 ** Math.max(0, attempt - 1));

export class JobWorker {
  private stopped = false;
  private readonly id: string; private readonly lease: number; private readonly conc: number; private readonly base: number;
  private readonly onDead?: WorkerOptions['onDead']; private readonly gate?: WorkerOptions['gate']; private readonly onPause?: WorkerOptions['onPause']; private paused: string | null = null;
  private readonly heavy: Set<string>; private readonly heavyLimit: number; private readonly pressure?: WorkerOptions['pressure']; private readonly onPressure?: WorkerOptions['onPressure']; private held: string | null = null; private heavyRunning = 0;
  constructor(private readonly sql: Sql, private readonly handlers: Record<string, Handler>, o: WorkerOptions = {}) {
    this.onDead = o.onDead; this.gate = o.gate; this.onPause = o.onPause;
    this.heavy = new Set(o.heavyKinds ?? []); this.heavyLimit = Math.max(1, o.heavyConcurrency ?? 1); this.pressure = o.pressure; this.onPressure = o.onPressure;
    this.id = o.workerId ?? `worker-${process.pid}`; this.lease = o.leaseSeconds ?? 300; this.conc = Math.max(1, Math.min(o.concurrency ?? 2, 8)); this.base = o.backoffBaseSeconds ?? 30;
  }

  /** Claims up to `concurrency` jobs and runs them; returns how many were processed. */
  async runOnce(): Promise<number> {
    if (this.gate) {
      const reason = await this.gate().catch((e: unknown) => `storage check failed: ${e instanceof Error ? e.message : String(e)}`);
      if (reason !== this.paused) { this.paused = reason; this.onPause?.(reason); }
      if (reason) return 0;                                   // not claiming anything: nothing is attempted, nothing fails
    }
    const all = Object.keys(this.handlers); const light = all.filter((k) => !this.heavy.has(k)); let heavyKinds = all.filter((k) => this.heavy.has(k));
    if (heavyKinds.length) {                                  // local AI is heavy: at most `heavyLimit` per round, and none while this computer is short of memory or disk
      const held = this.pressure ? await this.pressure().catch(() => null) : null;
      if (held !== this.held) { this.held = held; this.onPressure?.(held); }
      if (held) heavyKinds = [];
    }
    const claim = (kinds: string[], n: number) => this.sql<Job[]>`SELECT id, user_id, kind, payload, attempts, max_attempts FROM claim_jobs(${this.id}, ${kinds}::text[], ${n}, ${`${this.lease} seconds`}::interval)`;
    const jobs = [...(light.length ? await claim(light, this.conc) : []), ...(heavyKinds.length ? await claim(heavyKinds, this.heavyLimit) : [])];
    await Promise.all(jobs.map((j) => this.process(j)));
    return jobs.length;
  }

  private async process(job: Job): Promise<void> {
    const isHeavy = this.heavy.has(job.kind); if (isHeavy) this.heavyRunning++;
    try { await this.processInner(job); } finally { if (isHeavy) this.heavyRunning--; }
  }

  private async processInner(job: Job): Promise<void> {
    const [att] = await this.sql<{ id: string }[]>`INSERT INTO job_attempts (user_id, job_id, worker) VALUES (${job.user_id}, ${job.id}, ${this.id}) RETURNING id`;
    try {
      await this.handlers[job.kind]!(job);
      await this.sql`UPDATE jobs SET state = 'SUCCEEDED', finished_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL WHERE id = ${job.id} AND locked_by = ${this.id}`;
      await this.sql`UPDATE job_attempts SET finished_at = now(), outcome = 'OK' WHERE id = ${att!.id}`;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const away = this.gate ? await this.gate().catch(() => 'unknown') : null;
      if (away) {                                             // the drive went away under a running job: try again later, for free
        await this.sql`UPDATE jobs SET state = 'QUEUED', attempts = greatest(attempts - 1, 0), last_error = ${`storage unavailable: ${away}`}, locked_by = NULL, locked_until = NULL,
                         run_after = now() + interval '30 seconds' WHERE id = ${job.id} AND locked_by = ${this.id}`;
        await this.sql`UPDATE job_attempts SET finished_at = now(), outcome = 'ERROR', error = ${`storage unavailable: ${away}`} WHERE id = ${att!.id}`;
        return;
      }
      const permanent = e instanceof PermanentJobError;
      const dead = permanent || job.attempts >= job.max_attempts;
      await this.sql`UPDATE jobs SET state = ${permanent ? 'FAILED' : dead ? 'DEAD' : 'QUEUED'}, last_error = ${msg}, locked_by = NULL, locked_until = NULL,
                       run_after = now() + ${`${backoffSeconds(job.attempts, this.base)} seconds`}::interval, finished_at = ${dead ? new Date() : null}
                     WHERE id = ${job.id} AND locked_by = ${this.id}`;
      await this.sql`UPDATE job_attempts SET finished_at = now(), outcome = 'ERROR', error = ${msg} WHERE id = ${att!.id}`;
      if (dead && this.onDead) await this.onDead(job, msg).catch(() => undefined);
    }
  }

  /** Runs until nothing is claimable (or `maxMs` elapses). Jobs waiting for a backoff are not claimable yet and are left alone. */
  async drain(maxMs = 120_000): Promise<number> {
    const t0 = Date.now(); let total = 0;
    while (!this.stopped && Date.now() - t0 < maxMs) { const n = await this.runOnce(); if (n === 0) break; total += n; }
    return total;
  }

  /** Long-running loop for the worker process. */
  async run(pollMs = 2000): Promise<void> {
    while (!this.stopped) { const n = await this.runOnce().catch(() => 0); if (n === 0) await new Promise((r) => setTimeout(r, this.paused ? Math.max(pollMs, 5000) : pollMs)); }
  }
  stop(): void { this.stopped = true; }
  /** why the worker is currently paused, or null */
  get pausedReason(): string | null { return this.paused; }
}
