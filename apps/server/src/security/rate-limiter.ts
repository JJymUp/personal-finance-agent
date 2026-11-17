/**
 * Per-IP sliding-window rate limiter.
 * - Run creation: max 10 per minute per IP
 * - Tool results: max 60 per minute per IP
 */

interface WindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs?: number; maxRequests: number }) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests;
  }

  /**
   * Records a request from `key` (e.g. client IP) and returns whether it's allowed.
   * @returns `{ allowed: boolean; retryAfterMs?: number }`
   */
  check(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Prune expired timestamps
    const cutoff = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= this.maxRequests) {
      const oldest = entry.timestamps[0];
      const retryAfterMs = oldest + this.windowMs - now;
      return { allowed: false, retryAfterMs };
    }

    entry.timestamps.push(now);
    return { allowed: true };
  }

  /** Clears state for a key (useful in tests) */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /** Clears all state */
  clear(): void {
    this.windows.clear();
  }
}

/** Singleton limiters for the application */
export const createRunLimiter = (): RateLimiter =>
  new RateLimiter({ windowMs: 60_000, maxRequests: 10 });

export const toolResultLimiter = (): RateLimiter =>
  new RateLimiter({ windowMs: 60_000, maxRequests: 60 });
