/**
 * HTTP transport for ClientAgentCoordinator.
 * Uses real fetch() + SSE (via fetch ReadableStream) to communicate with the
 * Maggot Finance Agent server over the network.
 */
import {
  AgentEventSchema,
  type AgentEvent,
  type RunRequest,
  type FollowUpRequest,
  type FollowUpResponse,
} from '@maggot/contracts';
import type { ClientTransport, ServerCheckpointStatus } from './client.js';

export class HttpTransportError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface HttpTransportOptions {
  baseUrl: string;
  /** Initial session token; updated per runId after createRun */
  sessionToken?: string;
  /** Timeout for individual HTTP requests in ms (default: 30_000) */
  requestTimeoutMs?: number;
  /** Timeout for SSE connection in ms (default: 180_000) */
  sseTimeoutMs?: number;
  /** Optional custom fetch implementation (for testing or custom environments) */
  fetchImpl?: typeof fetch;
}

const TERMINAL_EVENT_TYPES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function combineSignals(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
}

async function parseErrorResponse(res: Response, fallbackPrefix: string): Promise<HttpTransportError> {
  const text = await res.text().catch(() => '');
  let code = `HTTP_${res.status}`;
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    if (parsed.error) code = parsed.error;
    if (parsed.message) detail = parsed.message;
  } catch {
    // Keep raw text
  }
  return new HttpTransportError(res.status, code, `${fallbackPrefix} HTTP ${res.status} (${code}): ${detail}`);
}

export class HttpClientTransport implements ClientTransport {
  private baseUrl: string;
  private defaultSessionToken: string | undefined;
  private tokensByRun = new Map<string, string>();
  private lastSequenceByRun = new Map<string, number>();
  private requestTimeoutMs: number;
  private sseTimeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.defaultSessionToken = options.sessionToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.sseTimeoutMs = options.sseTimeoutMs ?? 180_000;
    // Wrap globalThis.fetch to avoid "Illegal invocation" when invoked as a method in browsers
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  private authHeaders(runId: string): Record<string, string> {
    const token = this.tokensByRun.get(runId) ?? this.defaultSessionToken;
    if (token) {
      return { 'X-Session-Token': token };
    }
    return {};
  }

  /** R06: Rehydrate session token & cursor from encrypted local checkpoint after reload */
  registerRunSession(runId: string, sessionToken: string, lastSequenceNumber = 0): void {
    this.tokensByRun.set(runId, sessionToken);
    this.lastSequenceByRun.set(runId, Math.max(0, lastSequenceNumber));
  }

  clearTokens(): void {
    this.tokensByRun.clear();
    this.defaultSessionToken = undefined;
  }

  async createRun(
    request: RunRequest,
    options?: { signal?: AbortSignal }
  ): Promise<{ runId: string; status: string; sessionToken?: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (request.parentRunId) {
      const parentToken = this.tokensByRun.get(request.parentRunId) ?? this.defaultSessionToken;
      if (parentToken) {
        headers['X-Parent-Session-Token'] = parentToken;
      }
    }

    const res = await this.fetchImpl(`${this.baseUrl}/api/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: combineSignals(this.requestTimeoutMs, options?.signal),
    });

    if (!res.ok) {
      throw await parseErrorResponse(res, 'createRun failed');
    }

    const data = (await res.json()) as { runId: string; status: string; sessionToken?: string };
    if (data.sessionToken) {
      this.tokensByRun.set(data.runId, data.sessionToken);
    }
    return data;
  }

  async getCheckpoint(
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<ServerCheckpointStatus | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/runs/${runId}/checkpoint`, {
      method: 'GET',
      headers: {
        ...this.authHeaders(runId),
      },
      signal: combineSignals(this.requestTimeoutMs, options?.signal),
    });

    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw await parseErrorResponse(res, 'getCheckpoint failed');
    }

    return res.json() as Promise<ServerCheckpointStatus>;
  }

  async submitToolResult(
    runId: string,
    result: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<{ status: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/runs/${runId}/tool-results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(runId),
      },
      body: JSON.stringify(result),
      signal: combineSignals(this.requestTimeoutMs, options?.signal),
    });

    if (!res.ok) {
      throw await parseErrorResponse(res, 'submitToolResult failed');
    }

    return res.json() as Promise<{ status: string }>;
  }

  async cancelRun(runId: string, reason: string): Promise<{ status: string }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(runId),
      },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!res.ok) {
      throw await parseErrorResponse(res, 'cancelRun failed');
    }

    return res.json() as Promise<{ status: string }>;
  }

  async sendFollowUp(runId: string, request: FollowUpRequest): Promise<FollowUpResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/runs/${runId}/followup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(runId),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!res.ok) {
      throw await parseErrorResponse(res, 'sendFollowUp failed');
    }

    return res.json() as Promise<FollowUpResponse>;
  }

  /**
   * Fetches next batch of events for a run via authenticated SSE (X-Session-Token + Last-Event-ID).
   * Strictly validates every SSE event via AgentEventSchema (R04).
   */
  async fetchEvents(runId: string, options?: { signal?: AbortSignal }): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const lastSeq = this.lastSequenceByRun.get(runId) ?? 0;

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...this.authHeaders(runId),
    };
    if (lastSeq > 0) {
      headers['Last-Event-ID'] = String(lastSeq);
    }

    const res = await this.fetchImpl(`${this.baseUrl}/api/runs/${runId}/events`, {
      headers,
      signal: combineSignals(this.sseTimeoutMs, options?.signal),
    });

    if (!res.ok) {
      throw await parseErrorResponse(res, 'fetchEvents failed');
    }

    if (!res.body) {
      throw new Error('fetchEvents: response has no body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const parseSseFrame = (frame: string): AgentEvent | null => {
      const lines = frame.split('\n');
      let data: string | null = null;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          data = line.slice(6).trim();
        }
      }

      if (!data) return null;
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(data);
      } catch {
        return null;
      }
      const parsed = AgentEventSchema.safeParse(rawJson);
      if (!parsed.success) {
        throw new Error(`Invalid SSE AgentEvent schema: ${parsed.error.message}`);
      }
      if (parsed.data.runId !== runId) {
        throw new Error(`Cross-run SSE event rejected: expected ${runId}, got ${parsed.data.runId}`);
      }
      return parsed.data;
    };

    let shouldStop = false;
    try {
      while (!shouldStop) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const frame of parts) {
          const event = parseSseFrame(frame);
          if (!event) continue;

          if (event.sequenceNumber <= (this.lastSequenceByRun.get(runId) ?? 0)) {
            continue;
          }
          this.lastSequenceByRun.set(runId, event.sequenceNumber);
          events.push(event);

          if (event.type === 'tool_requested' || TERMINAL_EVENT_TYPES.has(event.type)) {
            shouldStop = true;
            break;
          }
        }
      }
    } finally {
      if (shouldStop) {
        await reader.cancel().catch(() => undefined);
      }
    }

    return events;
  }
}

/** Factory function for convenience */
export function createHttpTransport(
  baseUrl: string,
  options?: Omit<HttpTransportOptions, 'baseUrl'>
): HttpClientTransport {
  return new HttpClientTransport({ baseUrl, ...options });
}
