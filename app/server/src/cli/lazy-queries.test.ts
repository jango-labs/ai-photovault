import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * postgres.js queries are LAZY — a tagged template runs only when it is awaited or given .then(). `void query()` therefore does nothing, which is how the
 * worker's heartbeat once stopped after its first beat. The long-running command-line services must never fire a query without a handler.
 */
describe('long-running services', () => {
  it('never fire-and-forget a SQL query with `void`', () => {
    const dir = path.resolve(__dirname);
    for (const f of ['worker.ts', 'publisher.ts', 'delivery.ts'].filter((n) => fs.existsSync(path.join(dir, n)))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/void\s+(beat|enqueueRefresh|heartbeat)\s*\(/);
    }
  });
  it('the worker attaches a handler to its periodic queries', () => {
    const src = fs.readFileSync(path.join(__dirname, 'worker.ts'), 'utf8');
    expect(src).toMatch(/const fire = /); expect(src).toMatch(/fire\(beat\(\)\)/); expect(src).toMatch(/fire\(enqueueRefresh\(\)\)/);
  });
});
