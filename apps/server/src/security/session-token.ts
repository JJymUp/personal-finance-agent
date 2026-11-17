/**
 * Session token management — per-run opaque token for client authentication.
 * Tokens are issued on run creation and must be presented on all subsequent
 * mutation calls (tool-results, cancel).
 */
import crypto from 'node:crypto';
import type { SessionStore } from '../agent/store.js';

/** Opaque token: 32 random bytes hex-encoded (256 bits) */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

const HEX_TOKEN_RE = /^[0-9a-f]{64}$/i;

/**
 * Validates that the token matches the one bound to this runId.
 * Rejects malformed/non-hex tokens safely without throwing RangeError (R02).
 */
export function validateSessionToken(
  runId: string,
  token: string | undefined,
  store: SessionStore
): boolean {
  if (!token || !HEX_TOKEN_RE.test(token)) return false;
  const expected = store.getSessionToken(runId);
  if (!expected || !HEX_TOKEN_RE.test(expected)) return false;

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(token, 'hex');
  if (expectedBuf.length === 0 || expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
