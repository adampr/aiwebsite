// aicompany-template: ecosystem.config.cjs.tpl@5787173c26ad9252d543f3c0a339e08c459ad17b4823107149866a2e6ee11369
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const APP_ROOT = '/var/www/aiwebsite';
const dotenvFile = path.join(APP_ROOT, '.env');
const envFromFile = {};
try {
  fs.readFileSync(dotenvFile, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envFromFile[key] = val;
  });
} catch { /* .env missing on dev machines — harmless */ }

// CLOSED SET (v1.78.0): 'aiwebsite', 'brain-api', 'skills-host' are the ONLY
// pm2 apps a module host may run. NEVER add a build or maintenance app here —
// a pm2-managed `npm run build` in the live cwd rewrites .next mid-serve and
// strands the tree without BUILD_ID, and `pm2 save` makes any RUNNING stray
// boot-persistent via the resurrect dump (the hand-created `itsc-build` app,
// 2026-08-08 outage). On DEPLOY_BUILD_MODE=local-artifact hosts setup-vm.sh
// enforces this structurally: non-ecosystem apps are deleted before pm2 save.

// Interpreter pins (v1.4.0): empty for standard hosts (the spread renders
// inert — pm2 resolves `node` from PATH as before). Node-split hosts pin the
// site app to their toolchain node and the brain apps to the system node
// whose ABI their native deps were built against.
const SITE_INTERPRETER = '';
const BRAIN_INTERPRETER = '';

// Loopback-only listeners (v1.174.0, §9.1). The site binds 127.0.0.1 through
// `next start -H 127.0.0.1` (deploy/pm2-start.cjs). brain-api and skills-host
// take no host from the SDK, so this preload pins their no-host listen() to
// 127.0.0.1. NODE_OPTIONS, not node_args: the pm2 script is tsx's CLI, which
// re-spawns the server as a child node process, and only the environment
// reaches the child. The path is the ROOT-OWNED copy setup-vm installs from
// deploy/listen-loopback.cjs BEFORE the cutover, not the tree file: pm2 keeps
// an env key the ecosystem later drops (decision 17 item 3), so after a module
// rollback (whose rsync --delete removes the tree file) a tree path would make
// node refuse to start the brain. Quoted for node's NODE_OPTIONS parser.
const LOOPBACK_PRELOAD = '--require ' + JSON.stringify('/usr/local/lib/aiwebsite/listen-loopback.cjs');

module.exports = {
  apps: [
    {
      name: 'aiwebsite',
      script: 'deploy/pm2-start.cjs',
      cwd: APP_ROOT,
      ...(SITE_INTERPRETER ? { interpreter: SITE_INTERPRETER } : {}),
      // fork, explicitly: a stale cluster-mode registration makes the
      // next-start wrapper die silently under pm2's cluster bootstrap
      exec_mode: 'fork',
      env: { NODE_ENV: 'production', PORT: 3000, ...envFromFile },
      instances: 1,
      autorestart: true,
      // Bounded churn if a restart lands inside a deploy flip gap (v1.13.0)
      exp_backoff_restart_delay: 500,
      max_memory_restart: '1G',
      wait_ready: true,
      listen_timeout: 30000
    },
    {
      name: 'brain-api',
      // tsx lives in the brain workspace's own node_modules (the submodule is
      // a self-contained monorepo installed via `npm ci` inside packages/brain)
      script: APP_ROOT + '/packages/brain/node_modules/.bin/tsx',
      args: 'apps/brain-api/src/server.ts',
      cwd: APP_ROOT + '/packages/brain',
      ...(BRAIN_INTERPRETER ? { interpreter: BRAIN_INTERPRETER } : {}),
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3211,
        BRAIN_DB_BACKEND: 'postgres',
        BRAIN_DB_TABLE_PREFIX: 'brain_',
        SOFTWARE_BRAIN_ENV_PATH: APP_ROOT + '/.env',
        NODE_OPTIONS: LOOPBACK_PRELOAD,
      },
      instances: 1,
      autorestart: true,
      // Bounded churn if a restart lands inside a deploy flip gap (v1.13.0)
      exp_backoff_restart_delay: 500,
      // Host-tuned (site-deploy.env): one article-sized brain turn holds
      // ~2.4GB RSS on the multi-pass provider (measured on v1.92 and v1.93;
      // upstream reduction tracked in the brain repo), so hosts that drive
      // article generation need far more than the old 768M default — a
      // too-low cap makes pm2 kill brain-api MID-TURN and every in-flight
      // caller sees "fetch failed" (itsc incident 2026-07-11).
      max_memory_restart: '2600M',
      watch: false
    },
    {
      name: 'skills-host',
      script: APP_ROOT + '/packages/brain/node_modules/.bin/tsx',
      args: 'apps/skills-host/src/server.ts',
      cwd: APP_ROOT + '/packages/brain',
      ...(BRAIN_INTERPRETER ? { interpreter: BRAIN_INTERPRETER } : {}),
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3213,
        SOFTWARE_BRAIN_ENV_PATH: APP_ROOT + '/.env',
        AUTOMATION_SECRET: envFromFile.AUTOMATION_SECRET || '',
        NEXTJS_BASE_URL: 'http://127.0.0.1:3000',
        NODE_OPTIONS: LOOPBACK_PRELOAD,
      },
      instances: 1,
      autorestart: true,
      // Bounded churn if a restart lands inside a deploy flip gap (v1.13.0)
      exp_backoff_restart_delay: 500,
      max_memory_restart: '256M',
      watch: false
    }
  ]
};
