// aicompany-template: pm2-start.cjs.tpl@ff64df0e3f191aa871b60a6888958957a30e73c2f470aef1546c2fd1d5c8f7ce
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

// Loopback only (v1.174.0, §9.1): without -H, `next start` binds every
// interface (`*:3000`, measured 2026-10-23 on four hosts). nginx is its
// only legitimate client (proxy_pass http://127.0.0.1:3000), and so are
// the watchdog, the deploy health gate and the poll below. The hostname also
// becomes Next's internal origin (http://127.0.0.1:3000), which is what
// the §5.6 tracking beacon's loopback self-fetch dials — the same address it
// listens on. xlant.ai has run `next start --hostname 127.0.0.1` since 2026-09-06.
const LISTEN_HOST = '127.0.0.1';

const child = spawn(
  process.execPath,
  ['node_modules/.bin/next', 'start', '-p', String(PORT), '-H', LISTEN_HOST],
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
  const req = http.get('http://' + LISTEN_HOST + ':' + PORT + '/api/health', (res) => {
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
