/**
 * Thin wrapper around `next start` that sends PM2 the "ready" signal
 * once the HTTP server is actually listening.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 3000;
const POLL_MS = 500;
const MAX_WAIT_MS = 30000;

const child = spawn(
  process.execPath,
  ['node_modules/.bin/next', 'start', '-p', String(PORT)],
  { stdio: 'inherit', cwd: process.env.PM2_CWD || process.cwd() }
);

child.on('exit', (code) => process.exit(code ?? 1));

let elapsed = 0;
const timer = setInterval(() => {
  elapsed += POLL_MS;
  if (elapsed > MAX_WAIT_MS) {
    clearInterval(timer);
    return;
  }
  const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
    if (res.statusCode === 200 && typeof process.send === 'function') {
      process.send('ready');
    }
    clearInterval(timer);
    res.resume();
  });
  req.on('error', () => {});
  req.setTimeout(400, () => req.destroy());
}, POLL_MS);

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
