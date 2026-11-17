/**
 * Unique outbound network entry point for apps/web.
 * NEVER imports UserProfile, exact amounts, nicknames, or Vault secrets.
 * All requests go through same-origin /api/... (proxied in Vite dev, served by Fastify in prod).
 */
import { createHttpTransport, type HttpClientTransport } from '../agent-client/http-transport';

export interface ServerHealthInfo {
  status: string;
  service: string;
  provider: string;
  providerMode: 'openai' | 'mock';
}

export async function fetchServerHealth(): Promise<ServerHealthInfo> {
  const res = await fetch('/api/health', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Health check failed HTTP ${res.status}`);
  }
  return (await res.json()) as ServerHealthInfo;
}

export function createBrowserAgentTransport(): HttpClientTransport {
  // Empty baseUrl routes requests via same-origin `/api/...`
  return createHttpTransport('');
}
