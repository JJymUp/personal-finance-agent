import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ConversationRequestSchema, ConversationResponseSchema, RunRequestSchema, SafeToolResultSchema, FollowUpRequestSchema } from '@maggot/contracts';
import { SessionStore, SessionStoreError } from './agent/store.js';
import type { ModelProvider } from './providers/types.js';
import { MockModelProvider } from './providers/mock.js';
import { validateSessionToken } from './security/session-token.js';
import { createRunLimiter, toolResultLimiter, RateLimiter } from './security/rate-limiter.js';
import { DisclosureGuard } from './security/disclosure-guard.js';

/** Allowed origins for CORS — override via ALLOWED_ORIGINS env var (comma-separated) */
const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
];

/** How often to run TTL cleanup (every 5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface AppOptions {
  provider?: ModelProvider;
  store?: SessionStore;
  providerInfo?: {
    providerMode: 'openai' | 'mock';
    model: string;
    baseUrlHost: string;
    hasApiKey: boolean;
  };
  /** Allowed CORS origins; defaults to localhost dev origins */
  allowedOrigins?: string[];
  /** Rate limiter for POST /api/runs (default: 10/min per IP) */
  createRunRateLimiter?: RateLimiter;
  /** Rate limiter for POST /api/runs/:runId/tool-results (default: 60/min per IP) */
  toolResultRateLimiter?: RateLimiter;
  /** Cross-session anti-probing disclosure guard (P-06) */
  disclosureGuard?: DisclosureGuard;
  /** Skip session token validation (for in-process testing) */
  skipTokenValidation?: boolean;
  /** Optional directory containing built H5 static assets (apps/web/dist-h5) */
  staticDistDir?: string | false;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function resolveDefaultStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../web/dist-h5'),
    path.resolve(process.cwd(), 'apps/web/dist-h5'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return fs.realpathSync(dir);
    }
  }
  return null;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false, // Disables default request/response body logging for privacy
  });

  const provider = options.provider ?? new MockModelProvider();
  const store = options.store ?? new SessionStore();
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
  const runLimiter = options.createRunRateLimiter ?? createRunLimiter();
  const toolLimiter = options.toolResultRateLimiter ?? toolResultLimiter();
  const disclosureGuard = options.disclosureGuard ?? new DisclosureGuard();
  const skipTokenValidation = options.skipTokenValidation ?? false;

  // Start periodic TTL cleanup
  const cleanupTimer = setInterval(() => {
    store.cleanup();
  }, CLEANUP_INTERVAL_MS);
  // Allow Node.js to exit cleanly even if the interval is still active
  cleanupTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
  });

  const isOriginAllowed = (origin: string): boolean => {
    if (options.allowedOrigins) {
      return options.allowedOrigins.includes(origin);
    }
    const isLocalLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
    return isLocalLoopback || allowedOrigins.includes(origin);
  };

  // R02: Explicitly reject disallowed cross-origin requests rather than silently omitting CORS headers
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === 'string' && !isOriginAllowed(origin)) {
      return reply.status(403).send({
        error: 'ORIGIN_NOT_ALLOWED',
        message: 'Cross-origin request denied by server policy',
      });
    }
  });

  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }
      cb(null, isOriginAllowed(origin));
    },
    credentials: true,
  });

  const requireSessionAuth = (
    runId: string,
    headers: Record<string, string | string[] | undefined>,
    bodyToken?: string
  ): { ok: true } | { ok: false; status: number; error: string; message: string } => {
    if (skipTokenValidation) {
      return store.getSession(runId)
        ? { ok: true }
        : { ok: false, status: 404, error: 'SESSION_NOT_FOUND', message: 'Run session not found' };
    }

    const headerToken =
      typeof headers['x-session-token'] === 'string' ? headers['x-session-token'] : undefined;
    const token = headerToken || bodyToken;
    if (!token) {
      return {
        ok: false,
        status: 403,
        error: 'INVALID_SESSION_TOKEN',
        message: 'Missing or invalid X-Session-Token header.',
      };
    }

    const session = store.getSession(runId);
    if (!session) {
      return { ok: false, status: 404, error: 'SESSION_NOT_FOUND', message: 'Run session not found' };
    }

    if (!validateSessionToken(runId, token, store)) {
      return {
        ok: false,
        status: 403,
        error: 'INVALID_SESSION_TOKEN',
        message: 'Missing or invalid X-Session-Token header.',
      };
    }

    return { ok: true };
  };

  // Health check (strictly non-secret operational metadata — H-04 / T1)
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'maggot-finance-server',
      provider: options.providerInfo?.model ?? provider.name,
      providerMode: options.providerInfo?.providerMode ?? 'mock',
    };
  });

  // Natural-language entry receives only browser-redacted text and coarse profile fields.
  const conversationLimiter = new RateLimiter({ maxRequests: 20, windowMs: 60_000 });
  app.post('/api/conversation', async (request, reply) => {
    if (!conversationLimiter.check(request.ip).allowed) return reply.status(429).send({error:'RATE_LIMIT_EXCEEDED'});
    const parsed=ConversationRequestSchema.safeParse(request.body);
    if(!parsed.success) return reply.status(400).send({error:'INVALID_CONVERSATION_REQUEST'});
    if(!provider.generateConversation) return reply.status(503).send({error:'CONVERSATION_UNAVAILABLE'});
    const controller=new AbortController();
    const onClose=() => { if(!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close',onClose);
    try { return reply.send(ConversationResponseSchema.parse(await provider.generateConversation(parsed.data,controller.signal))); }
    catch { return reply.status(502).send({error:'CONVERSATION_FAILED',message:'暂时没能完成这次回复，请稍后重试。'}); }
    finally { reply.raw.off('close',onClose); }
  });

  // POST /api/runs
  app.post('/api/runs', async (request, reply) => {
    // Rate limit by IP
    const ip = request.ip || '127.0.0.1';
    const rateCheck = runLimiter.check(ip);
    if (!rateCheck.allowed) {
      reply.header('Retry-After', String(Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000)));
      return reply.status(429).send({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many run creation requests. Please wait and retry.',
      });
    }

    // 1. Strict Zod Schema validation
    const parseResult = RunRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'INVALID_RUN_REQUEST',
        details: parseResult.error.format(),
      });
    }

    const runReq = parseResult.data;

    // 2. Server-side privacy validation: reject if any raw financial tokens or numbers in strings
    const serialized = JSON.stringify(runReq);
    if (/SENSITIVE_|BANK_|ACCOUNT_NO|PASSWORD/i.test(serialized)) {
      return reply.status(400).send({
        error: 'SECURITY_VIOLATION',
        message: 'Forbidden sensitive keywords found in request',
      });
    }

    // 2.5 P-06 Cross-session anti-probing disclosure guard (anchored by both client ID and IP)
    const clientHeader = request.headers['x-client-id'];
    const subjectKey =
      (typeof clientHeader === 'string' && clientHeader.trim()) || ip;
    const disclosureCheck = disclosureGuard.checkAndRecordRun(subjectKey, runReq, ip);
    if (!disclosureCheck.allowed) {
      return reply.status(429).send({
        error: 'DISCLOSURE_BUDGET_EXCEEDED',
        message: disclosureCheck.reason,
      });
    }

    // 3. Create session & start (verify parent run ownership when parentRunId is set)
    const parentTokenHeader = request.headers['x-parent-session-token'];
    const parentSessionToken =
      typeof parentTokenHeader === 'string' ? parentTokenHeader : undefined;

    let session;
    try {
      session = store.createSession(runReq, provider, {
        parentSessionToken,
        skipParentTokenCheck: skipTokenValidation,
      });
    } catch (err) {
      if (err instanceof SessionStoreError) {
        return reply.status(err.statusCode).send({
          error: err.code,
          message: err.message,
        });
      }
      return reply.status(400).send({
        error: 'SESSION_CREATE_ERROR',
        message: (err as Error).message,
      });
    }

    // Start session in background (it will transition to waiting_for_browser_tool or completed)
    session.start().catch((err) => {
      console.error('Session start error', err);
    });

    const sessionToken = store.getSessionToken(session.runId);

    return reply.status(201).send({
      runId: session.runId,
      status: session.getStatus(),
      sessionToken,
    });
  });

  // GET /api/runs/:runId/events (SSE — authenticated via X-Session-Token per R02)
  app.get('/api/runs/:runId/events', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const auth = requireSessionAuth(runId, request.headers as Record<string, string>);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    }
    const session = store.getSession(runId)!;

    const rawLastId = request.headers['last-event-id'];
    const lastEventId =
      typeof rawLastId === 'string' && /^\d+$/.test(rawLastId) ? parseInt(rawLastId, 10) : 0;

    // Preserve any headers set by plugins (e.g. CORS) before hijacking the raw response
    const existingHeaders = reply.getHeaders();
    reply.hijack();

    const rawHeaders: Record<string, string | string[] | number> = {};
    for (const [k, v] of Object.entries(existingHeaders)) {
      if (v !== undefined) rawHeaders[k] = v as string | string[] | number;
    }
    rawHeaders['Content-Type'] = 'text/event-stream';
    rawHeaders['Cache-Control'] = 'no-cache';
    rawHeaders['Connection'] = 'keep-alive';

    reply.raw.writeHead(200, rawHeaders);

    let lastSentSeq = lastEventId;

    const writeEvent = (evt: { sequenceNumber: number; type: string }) => {
      if (evt.sequenceNumber <= lastSentSeq) return;
      lastSentSeq = evt.sequenceNumber;
      if (!reply.raw.writableEnded) {
        reply.raw.write(`id: ${evt.sequenceNumber}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
    };

    // Subscribe before reading history so no intermediate event is missed
    const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'];
    let closed = false;
    const unsubscribe = session.addEventListener((evt) => {
      if (closed) return;
      writeEvent(evt);
      if (TERMINAL_STATUSES.includes(evt.type)) {
        closed = true;
        unsubscribe();
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    });

    // Flush already emitted events > lastEventId
    for (const evt of session.getEventHistory()) {
      writeEvent(evt);
    }

    // If session is already terminal, close stream
    if (TERMINAL_STATUSES.includes(session.getStatus())) {
      closed = true;
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
      return;
    }

    request.raw.on('close', () => {
      closed = true;
      unsubscribe();
    });
  });

  // POST /api/runs/:runId/tool-results
  app.post('/api/runs/:runId/tool-results', async (request, reply) => {
    const { runId } = request.params as { runId: string };

    // Rate limit by IP
    const ip = request.ip || '127.0.0.1';
    const rateCheck = toolLimiter.check(ip);
    if (!rateCheck.allowed) {
      reply.header('Retry-After', String(Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000)));
      return reply.status(429).send({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many tool result submissions. Please wait and retry.',
      });
    }

    const bodyToken = (request.body as Record<string, string> | null)?.sessionToken;
    const auth = requireSessionAuth(runId, request.headers as Record<string, string>, bodyToken);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    }
    const session = store.getSession(runId)!;

    const parseResult = SafeToolResultSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'INVALID_TOOL_RESULT',
        details: parseResult.error.format(),
      });
    }

    const toolResult = parseResult.data;

    try {
      await session.submitToolResult(toolResult, { waitStep: false });
      return reply.send({
        ok: true,
        status: session.getStatus(),
        runId,
      });
    } catch (err) {
      return reply.status(400).send({
        error: 'TOOL_SUBMISSION_ERROR',
        message: (err as Error).message,
      });
    }
  });

  // GET /api/runs/:runId/checkpoint (authenticated per R02)
  app.get('/api/runs/:runId/checkpoint', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const auth = requireSessionAuth(runId, request.headers as Record<string, string>);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    }
    const session = store.getSession(runId)!;
    return reply.send(session.getCheckpoint());
  });

  // POST /api/runs/:runId/cancel
  app.post('/api/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const bodyToken = (request.body as Record<string, string> | null)?.sessionToken;
    const auth = requireSessionAuth(runId, request.headers as Record<string, string>, bodyToken);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    }
    const session = store.getSession(runId)!;

    const body = (request.body as { reason?: string }) || {};
    session.cancel(body.reason || 'user_cancelled');

    return reply.send({
      status: session.getStatus(),
      runId,
    });
  });

  // POST /api/runs/:runId/followup (P-03 / R01 controlled structured follow-up)
  app.post('/api/runs/:runId/followup', async (request, reply) => {
    const { runId } = request.params as { runId: string };

    const ip = request.ip || '127.0.0.1';
    const rateCheck = toolLimiter.check(ip);
    if (!rateCheck.allowed) {
      reply.header('Retry-After', String(Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000)));
      return reply.status(429).send({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many follow-up requests. Please wait and retry.',
      });
    }

    const bodyToken = (request.body as Record<string, string> | null)?.sessionToken;
    const auth = requireSessionAuth(runId, request.headers as Record<string, string>, bodyToken);
    if (!auth.ok) {
      return reply.status(auth.status).send({ error: auth.error, message: auth.message });
    }
    const session = store.getSession(runId)!;

    const parseResult = FollowUpRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'INVALID_FOLLOWUP_REQUEST',
        details: parseResult.error.format(),
      });
    }

    const serialized = JSON.stringify(parseResult.data);
    if (/SENSITIVE_|BANK_|ACCOUNT_NO|PASSWORD|CONFIDENTIAL_|CARD_NO/i.test(serialized)) {
      return reply.status(400).send({
        error: 'SECURITY_VIOLATION',
        message: 'Forbidden sensitive keywords found in follow-up request',
      });
    }

    try {
      const response = await session.answerFollowUp(parseResult.data);
      return reply.send(response);
    } catch (err) {
      return reply.status(400).send({
        error: 'FOLLOWUP_ERROR',
        message: (err as Error).message,
      });
    }
  });

  // Safe allowlisted H5 static serving (never serves docs/, .env*, or files outside dist-h5)
  const staticRoot =
    options.staticDistDir === false
      ? null
      : options.staticDistDir
        ? fs.realpathSync(options.staticDistDir)
        : resolveDefaultStaticDir();

  if (staticRoot) {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') {
        return reply.status(404).send({ error: 'NOT_FOUND' });
      }

      const rawPath = request.url.split('?')[0];
      const relPath = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
      const candidate = path.resolve(staticRoot, relPath);

      let targetFile = path.join(staticRoot, 'index.html');
      if (candidate.startsWith(staticRoot + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const realTarget = fs.realpathSync(candidate);
        if (realTarget.startsWith(staticRoot + path.sep)) {
          targetFile = realTarget;
        }
      }

      const ext = path.extname(targetFile);
      const mime = MIME_TYPES[ext];
      if (!mime) {
        return reply.status(403).send({ error: 'FORBIDDEN_STATIC_EXTENSION' });
      }

      if (ext === '.html') {
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'"
        );
      }
      reply.type(mime);
      return reply.send(fs.readFileSync(targetFile));
    });
  }

  return app;
}
