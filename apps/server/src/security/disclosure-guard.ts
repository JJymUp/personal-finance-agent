/**
 * P-06 Cross-Session Anti-Probing / Disclosure Guard.
 * Prevents iterative threshold-probing attacks (e.g., opening many sessions with
 * slightly varied goals to binary-search a user's exact cash balance).
 */
import type { RunRequest } from '@maggot/contracts';

interface DisclosureEntry {
  timestamp: number;
  probeSignature: string;
}

export interface DisclosureGuardOptions {
  windowMs?: number;
  /** Max total run creations allowed per subject within windowMs */
  maxRunsPerWindow?: number;
  /** Max distinct (snapshot/goal/bucket) probing signatures allowed per subject within windowMs */
  maxDistinctProbesPerWindow?: number;
}

export class DisclosureGuard {
  private entries = new Map<string, DisclosureEntry[]>();
  private readonly windowMs: number;
  private readonly maxRunsPerWindow: number;
  private readonly maxDistinctProbesPerWindow: number;

  constructor(options: DisclosureGuardOptions = {}) {
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.maxRunsPerWindow = options.maxRunsPerWindow ?? 30;
    this.maxDistinctProbesPerWindow = options.maxDistinctProbesPerWindow ?? 12;
  }

  /**
   * Computes a coarse, non-secret probing signature from RunRequest buckets.
   */
  private buildSignature(req: RunRequest): string {
    return [
      req.snapshotVersion,
      req.goalVersion,
      req.safeGoalSummary.task_type,
      req.safeGoalSummary.horizon,
      req.safeGoalSummary.cost_in_monthly_surplus,
    ].join('|');
  }

  /**
   * Records and validates a new planning run against cross-session disclosure limits.
   * Accepts an optional secondary anchor (e.g. client IP) so rotating X-Client-Id cannot bypass probing limits (P-06).
   */
  checkAndRecordRun(
    subjectKey: string,
    request: RunRequest,
    secondaryKey?: string
  ): { allowed: boolean; reason?: string; stats: { runCount: number; distinctProbes: number } } {
    const keys =
      secondaryKey && secondaryKey !== subjectKey
        ? [subjectKey, `ip:${secondaryKey}`]
        : [subjectKey];

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const signature = this.buildSignature(request);

    // Phase 1: Check limits across ALL keys before recording
    let primaryStats = { runCount: 0, distinctProbes: 0 };
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const prev = (this.entries.get(key) ?? []).filter((e) => e.timestamp > cutoff);
      this.entries.set(key, prev);

      const distinctBefore = new Set(prev.map((e) => e.probeSignature));
      if (i === 0) {
        primaryStats = { runCount: prev.length, distinctProbes: distinctBefore.size };
      }

      if (prev.length >= this.maxRunsPerWindow) {
        return {
          allowed: false,
          reason: `Exceeded cross-session run disclosure limit (${this.maxRunsPerWindow} runs per window)`,
          stats: { runCount: prev.length, distinctProbes: distinctBefore.size },
        };
      }

      const willAddDistinct = !distinctBefore.has(signature);
      if (willAddDistinct && distinctBefore.size >= this.maxDistinctProbesPerWindow) {
        return {
          allowed: false,
          reason: `Detected rapid cross-session threshold probing (${distinctBefore.size} distinct probes)`,
          stats: { runCount: prev.length, distinctProbes: distinctBefore.size },
        };
      }
    }

    // Phase 2: Record across all keys
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const prev = this.entries.get(key) ?? [];
      prev.push({ timestamp: now, probeSignature: signature });
      this.entries.set(key, prev);
      if (i === 0) {
        primaryStats = {
          runCount: prev.length,
          distinctProbes: new Set(prev.map((e) => e.probeSignature)).size,
        };
      }
    }

    return {
      allowed: true,
      stats: primaryStats,
    };
  }

  getStats(subjectKey: string): { runCount: number; distinctProbes: number } {
    const cutoff = Date.now() - this.windowMs;
    const active = (this.entries.get(subjectKey) ?? []).filter((e) => e.timestamp > cutoff);
    return {
      runCount: active.length,
      distinctProbes: new Set(active.map((e) => e.probeSignature)).size,
    };
  }

  clear(): void {
    this.entries.clear();
  }
}
