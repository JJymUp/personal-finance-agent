import { ConversationResponseSchema, type ConversationRequest } from '@maggot/contracts';
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

export async function sendConversation(request: ConversationRequest, signal?: AbortSignal) {
  const response = await fetch('/api/conversation', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(request),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(75000)]):AbortSignal.timeout(75000)});
  if(!response.ok) throw new Error(response.status===429?'消息发送得有点快，请稍后再试。':'这次回复没有完成，请稍后重试。');
  return ConversationResponseSchema.parse(await response.json());
}
