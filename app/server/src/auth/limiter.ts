/** Small in-memory sliding-window limiter for request floods (the database-backed login lockout is separate). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  /** Returns seconds to wait, or 0 if the request is allowed (and counted). */
  take(key: string): number {
    const t = this.now(), from = t - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((x) => x > from);
    if (arr.length >= this.max) { this.hits.set(key, arr); return Math.max(1, Math.ceil((arr[0]! + this.windowMs - t) / 1000)); }
    arr.push(t); this.hits.set(key, arr);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => x > from)) this.hits.delete(k);
    return 0;
  }
}
