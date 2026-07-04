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

module.exports = {
  apps: [
    {
      name: 'aiwebsite',
      script: 'deploy/pm2-start.cjs',
      cwd: APP_ROOT,
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
      script: '/var/www/aiwebsite/packages/brain/node_modules/.bin/tsx',
      args: 'apps/brain-api/src/server.ts',
      cwd: '/var/www/aiwebsite/packages/brain',
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3211,
        BRAIN_DB_BACKEND: 'postgres',
        BRAIN_DB_TABLE_PREFIX: 'brain_',
        SOFTWARE_BRAIN_ENV_PATH: '/var/www/aiwebsite/.env',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '768M',
      watch: false
    },
    {
      name: 'skills-host',
      script: '/var/www/aiwebsite/packages/brain/node_modules/.bin/tsx',
      args: 'apps/skills-host/src/server.ts',
      cwd: '/var/www/aiwebsite/packages/brain',
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3213,
        SOFTWARE_BRAIN_ENV_PATH: '/var/www/aiwebsite/.env',
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
