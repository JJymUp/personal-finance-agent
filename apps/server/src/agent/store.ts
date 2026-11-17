import type { RunRequest } from '@maggot/contracts';
import { AgentSession, type InheritedSessionUsage } from './session.js';
import type { ModelProvider } from '../providers/types.js';
import { generateSessionToken, validateSessionToken } from '../security/session-token.js';

/** Sessions expire after 30 minutes of last activity */
const SESSION_TTL_MS = 30 * 60 * 1000;
const RESUMABLE_PARENT_STATUSES = new Set([
  'waiting_for_browser_tool',
  'interrupted',
  'cancelled',
]);

interface SessionRecord {
  session: AgentSession;
  token: string;
  lastActivityAt: number;
}

export class SessionStoreError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SessionStore {
  private records = new Map<string, SessionRecord>();

  createSession(
    request: RunRequest,
    provider: ModelProvider,
    options?: {
      parentSessionToken?: string;
      skipParentTokenCheck?: boolean;
      maxDurationMs?: number;
    }
  ): AgentSession {
    let inheritedUsage: InheritedSessionUsage | undefined = undefined;

    // Continuation run: must bind to an existing, authorized parent session (R02 / R06)
    if (request.parentRunId) {
      const parentRecord = this.records.get(request.parentRunId);
      if (!parentRecord) {
        throw new SessionStoreError(
          'PARENT_SESSION_NOT_FOUND',
          `Parent session "${request.parentRunId}" does not exist or expired; cannot silently reset budget`,
          409
        );
      }

      if (!options?.skipParentTokenCheck) {
        if (!validateSessionToken(request.parentRunId, options?.parentSessionToken, this)) {
          throw new SessionStoreError(
            'FORBIDDEN_PARENT_RUN',
            'Missing or invalid X-Parent-Session-Token for parentRunId continuation',
            403
          );
        }
      }

      const parentStatus = parentRecord.session.getStatus();
      if (!RESUMABLE_PARENT_STATUSES.has(parentStatus)) {
        throw new SessionStoreError(
          'PARENT_SESSION_NOT_RESUMABLE',
          `Parent session "${request.parentRunId}" is in non-resumable state "${parentStatus}"`,
          409
        );
      }

      const parentUsage = parentRecord.session.getUsage();
      const parentTokens = parentRecord.session.getTokenUsage();
      inheritedUsage = {
        stepCount: parentUsage.stepCount,
        toolCallCount: parentUsage.toolCallCount,
        modelRequestCount: parentUsage.modelRequestCount,
        promptTokens: parentTokens.promptTokens,
        completionTokens: parentTokens.completionTokens,
        activeElapsedMs: parentUsage.activeElapsedMs,
      };

      // Verify originalClarificationCallId if provided
      if (request.originalClarificationCallId) {
        const parentHistory = parentRecord.session.getToolHistory();
        const clarificationExists = parentHistory.some(
          (item) =>
            item.request.callId === request.originalClarificationCallId &&
            item.request.toolName === 'request_clarification'
        );
        if (!clarificationExists) {
          throw new SessionStoreError(
            'INVALID_CLARIFICATION_CALL_ID',
            'Invalid originalClarificationCallId: not found in parent session tool history',
            400
          );
        }
      }
    }

    const session = new AgentSession(request, provider, inheritedUsage, options?.maxDurationMs);
    if (this.records.has(session.runId)) {
      throw new SessionStoreError('RUN_ID_COLLISION', 'Generated runId collided', 500);
    }

    const token = generateSessionToken();

    this.records.set(session.runId, {
      session,
      token,
      lastActivityAt: Date.now(),
    });

    return session;
  }

  getSession(runId: string): AgentSession | undefined {
    const record = this.records.get(runId);
    if (!record) return undefined;
    record.lastActivityAt = Date.now();
    return record.session;
  }

  /** Returns the opaque session token bound to this runId */
  getSessionToken(runId: string): string | undefined {
    return this.records.get(runId)?.token;
  }

  deleteSession(runId: string): boolean {
    return this.records.delete(runId);
  }

  clear(): void {
    this.records.clear();
  }

  /**
   * Removes sessions that have been inactive for longer than SESSION_TTL_MS.
   * Should be called on a periodic interval.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [runId, record] of this.records) {
      if (now - record.lastActivityAt > SESSION_TTL_MS) {
        // Interrupt still-active sessions so SSE subscribers get a terminal event
        const status = record.session.getStatus();
        if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
          record.session.interrupt('session_ttl_expired');
        }
        this.records.delete(runId);
        removed++;
      }
    }
    return removed;
  }
}
