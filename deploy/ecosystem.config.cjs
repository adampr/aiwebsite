// aicompany-template: ecosystem.config.cjs.tpl@dd4f3b681b4a5de35b9ab89c09bc6fa5f87d6d83ac3de93e1ea31b099a409217
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

// Interpreter pins (v1.4.0): empty for standard hosts (the spread renders
// inert — pm2 resolves `node` from PATH as before). Node-split hosts pin the
// site app to their toolchain node and the brain apps to the system node
// whose ABI their native deps were built against.
const SITE_INTERPRETER = '';
const BRAIN_INTERPRETER = '';

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
      },
      instances: 1,
      autorestart: true,
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
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
      watch: false
    }
  ]
};
