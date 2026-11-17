#!/usr/bin/env node
/**
 * Local full-stack development launcher (`pnpm dev`).
 * Starts Fastify API server (http://127.0.0.1:3000) and Vite H5 dev server (http://127.0.0.1:5173).
 */
import { spawn } from 'node:child_process';

const procs = [
  spawn('pnpm', ['--filter', '@maggot/server', 'dev'], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@maggot/web', 'dev'], { stdio: 'inherit' }),
];

function shutdown(code = 0) {
  for (const p of procs) {
    if (!p.killed) p.kill('SIGTERM');
  }
  process.exit(code);
}

for (const p of procs) {
  p.on('exit', (code) => {
    if (code && code !== 0) shutdown(code);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
