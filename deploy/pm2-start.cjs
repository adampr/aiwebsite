// aicompany-template: pm2-start.cjs.tpl@7d41524203ae3bfc846fe18e2a0fd1e4afd54d1ef8c1dda29216aa7967ba9e81
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

// Artifact preflight (v1.13.0): a restart landing inside a deploy's ms-wide
// rename gap — or on a broken build — must fail with ONE explicit line and a
// clean exit for pm2's backoff, not the 59-restart opaque crash loop of the
// 2026-07-22 itsc outage. Resolve against the SAME base the spawn uses.
const fs = require('fs');
const path = require('path');
const base = process.env.PM2_CWD || process.cwd();
const nextBin = path.join(base, 'node_modules', '.bin', 'next');
const buildId = path.join(base, '.next', 'BUILD_ID');
if (!fs.existsSync(nextBin) || !fs.existsSync(buildId)) {
  console.error('[pm2-start] build artifacts missing (' + nextBin + ' / ' + buildId + ') — deploy flip in progress or broken build; exiting for pm2 backoff');
  process.exit(1);
}

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
  const req = http.get('http://127.0.0.1:' + PORT + '/api/health', (res) => {
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
