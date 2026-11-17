import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let report: { passCount: number; totalExecuted: number; privacyEvidence?: { browserRequestCount: number }; results: Array<{ expectVerdictMatch?: string; privacyAuditPassed?: boolean }> };
beforeAll(() => {
  // This exercises the executable script against fresh production artifacts, not stale dist files.
  const build = spawnSync('pnpm', ['build'], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  if (build.status !== 0) throw new Error('Evaluation prerequisite build failed');
  const run = spawnSync(process.execPath, ['scripts/batch-cloud-eval.mjs', '--provider', 'mock', '--runs', '1', '--transport', 'inject'],
    { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, FORCE_MOCK: 'true' }, timeout: 20000 });
  const match = `${run.stdout}\n${run.stderr}`.match(/\[batch-eval\]\s+Report:\s+([^\n]+)/);
  if (!match) throw new Error('Mock evaluation did not produce a report');
  report = JSON.parse(readFileSync(match[1].trim(), 'utf8'));
}, 60000);

describe('FIX-09 meaningful evaluation evidence', () => {
  it('has an explicit accepted verdict for every business case, never an any wildcard', () => {
    expect(report.results).toHaveLength(12);
    expect(report.results.every(row => row.expectVerdictMatch !== 'any')).toBe(true);
  });
  it('records the actual outbound payload boundary instead of only inspecting event history', () => {
    expect(report.privacyEvidence?.browserRequestCount).toBeGreaterThan(0);
  });
  it('passes the independent mock business expectations after complete dates are supplied', () => {
    expect(report.passCount).toBe(report.totalExecuted);
  });
});
