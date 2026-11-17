import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerEnvConfig {
  port: number;
  host: string;
  providerMode: 'openai' | 'mock';
  openaiApiKey?: string;
  openaiModel: string;
  openaiBaseUrl: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
}

/**
 * Resolves the workspace root directory cleanly from compiled or source location.
 */
function findEnvFiles(): string[] {
  const candidates = new Set<string>();
  const cwd = process.cwd();
  const here = path.dirname(fileURLToPath(import.meta.url));

  for (const base of [cwd, path.resolve(cwd, '../..'), path.resolve(here, '../../../..')]) {
    candidates.add(path.join(base, '.env.local'));
    candidates.add(path.join(base, '.env'));
  }

  return [...candidates].filter((p) => fs.existsSync(p));
}

function parseEnvContent(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val.length > 0) {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Loads environment variables on the server ONLY (.env.local > .env; never overrides existing process.env).
 */
export function loadServerEnv(forceReload = false): ServerEnvConfig {
  const fileValues: Record<string, string> = {};
  const files = findEnvFiles();
  // Read .env first, then .env.local overrides .env
  const ordered = [
    ...files.filter((f) => f.endsWith('.env')),
    ...files.filter((f) => f.endsWith('.env.local')),
  ];

  for (const file of ordered) {
    const parsed = parseEnvContent(fs.readFileSync(file, 'utf8'));
    Object.assign(fileValues, parsed);
  }

  const getVal = (key: string): string | undefined => {
    if (!forceReload && process.env[key] && process.env[key]!.trim().length > 0) {
      return process.env[key]!.trim();
    }
    return fileValues[key] ?? process.env[key]?.trim();
  };

  const forceMock = getVal('FORCE_MOCK') === 'true' || getVal('FORCE_MOCK') === '1';
  const apiKey = forceMock ? undefined : getVal('OPENAI_API_KEY');
  const model = getVal('OPENAI_MODEL') || 'gpt-4o-mini';
  const baseUrl = (getVal('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/+$/, '');

  const rawTimeout = Number(getVal('OPENAI_API_TIMEOUT') || '30000');
  const openaiTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30000;

  const rawRetries = Number(getVal('OPENAI_API_MAX_RETRIES') ?? '2');
  const openaiMaxRetries =
    Number.isFinite(rawRetries) && rawRetries >= 0 && rawRetries <= 5 ? Math.floor(rawRetries) : 2;

  const portNum = Number(getVal('PORT') || '3000');
  const port = Number.isFinite(portNum) && portNum > 0 ? portNum : 3000;

  return {
    port,
    host: '127.0.0.1',
    providerMode: apiKey ? 'openai' : 'mock',
    openaiApiKey: apiKey,
    openaiModel: model,
    openaiBaseUrl: baseUrl,
    openaiTimeoutMs,
    openaiMaxRetries,
  };
}

/**
 * Safe non-secret summary for health checks and startup logs (H-04 / P-01).
 */
export function getSafeEnvSummary(config: ServerEnvConfig) {
  let baseUrlHost = 'none';
  try {
    baseUrlHost = new URL(config.openaiBaseUrl).host;
  } catch {
    baseUrlHost = 'invalid';
  }
  return {
    providerMode: config.providerMode,
    model: config.providerMode === 'openai' ? config.openaiModel : 'mock_provider',
    baseUrlHost: config.providerMode === 'openai' ? baseUrlHost : 'local',
    hasApiKey: Boolean(config.openaiApiKey),
  };
}
