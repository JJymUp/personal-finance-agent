import { buildApp } from './app.js';
import { loadServerEnv, getSafeEnvSummary } from './config/env.js';
import { OpenAIModelProvider } from './providers/openai.js';
import { MockModelProvider } from './providers/mock.js';

const env = loadServerEnv();
const providerInfo = getSafeEnvSummary(env);

const provider =
  env.providerMode === 'openai' && env.openaiApiKey
    ? new OpenAIModelProvider({
        apiKey: env.openaiApiKey,
        model: env.openaiModel,
        baseUrl: env.openaiBaseUrl,
        timeoutMs: env.openaiTimeoutMs,
        maxRetries: env.openaiMaxRetries,
      })
    : new MockModelProvider();

const app = buildApp({ provider, providerInfo });

async function start() {
  try {
    await app.listen({ port: env.port, host: env.host });
    console.warn(
      `Maggot Finance Agent server listening on http://${env.host}:${env.port} (${providerInfo.providerMode}: ${providerInfo.model})`
    );
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
