#!/usr/bin/env node
// "Hi" speed gate (fleet QA phase, 2026-07-24 — after the itsc 5-7s and
// ai.xl.net 36s greeting incidents). Sends a real "Hi" envelope to this
// repo's brain endpoint, measures TTFT + total, and enforces a hard
// threshold (default 5000ms). On breach or failure it:
//   1. appends a dated entry to docs/OPEN_ISSUES.md (created if missing),
//   2. emails the operator via Resend when RESEND_API_KEY is configured,
//   3. exits non-zero so any pipeline/QA runner goes loud.
// Zero dependencies; Node >= 18. Canonical copy: xldev scripts/qa/ —
// consumer repos (itsupportchicago, aiwebsite, roleplay, leonetter) carry
// verbatim copies; sync from canonical when changing.
//
// Usage: node scripts/qa/hi_speed_test.mjs [--label mysite] [--url http://...]
//        [--env /path/to/.env] [--threshold-ms 5000] [--open-issues docs/OPEN_ISSUES.md]

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);

function parseEnvFile(p) {
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env — process env only */ }
  return out;
}

const envPath = args.env || process.env.HI_SPEED_ENV_PATH || path.join(process.cwd(), '.env');
const env = { ...parseEnvFile(envPath), ...process.env };

const label = args.label || env.HI_SPEED_LABEL || path.basename(process.cwd());
const baseUrl = (args.url || env.HI_SPEED_BRAIN_URL || env.BRAIN_BASE_URL || 'http://127.0.0.1:3211').replace(/\/$/, '');
const thresholdMs = Number(args['threshold-ms'] || env.HI_SPEED_THRESHOLD_MS || 5000);
const openIssuesPath = args['open-issues'] || env.HI_SPEED_OPEN_ISSUES || path.join(process.cwd(), 'docs', 'OPEN_ISSUES.md');
const bearer =
  env.HI_SPEED_BRAIN_KEY ||
  env.BRAIN_API_KEY ||
  env.LEONETTER_BRAIN_API_KEY ||
  (env.BRAIN_API_KEYS || '').split(',')[0]?.trim() ||
  '';

const now = new Date();
const sessionId = `qa_hi_${now.getTime().toString(36)}_speedgate`;
const promptId = `qa_hi_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

async function measure() {
  const t0 = performance.now();
  let ttftMs = null;
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ sessionId, promptId, messages: [{ role: 'user', content: 'Hi' }] }),
    signal: AbortSignal.timeout(Math.max(thresholdMs * 6, 30_000)),
  });
  if (!res.ok) throw new Error(`brain returned HTTP ${res.status}`);
  if ((res.headers.get('content-type') || '').includes('ndjson') && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if ((ev.type === 'token' || ev.type === 'answer') && ttftMs === null) ttftMs = performance.now() - t0;
        if (ev.type === 'result' || ev.type === 'done' || ev.type === 'error') {
          if (ev.type === 'error') throw new Error('brain streamed an error event');
        }
      }
    }
  } else {
    await res.json();
  }
  return { totalMs: performance.now() - t0, ttftMs };
}

function appendOpenIssue(detail) {
  const header = `# Open issues — ${label}\n\nAuto-tracked operational issues (hi-speed gate & friends). An entry is\nappended on every breach; RESOLVE by investigating, fixing, and moving the\nentry to a "Resolved" section with the fix reference.\n\n`;
  fs.mkdirSync(path.dirname(openIssuesPath), { recursive: true });
  if (!fs.existsSync(openIssuesPath)) fs.writeFileSync(openIssuesPath, header);
  const entry = `## OPEN ${now.toISOString()} — "Hi" speed gate breach (${label})\n\n${detail}\n- Threshold: ${thresholdMs}ms. Endpoint: ${baseUrl}/v1/chat/completions.\n- Reproduce: \`node scripts/qa/hi_speed_test.mjs --label ${label}\`\n- Triage hints: brain phase_timing for this window (search_planning wall-time,\n  first_pass model), embedding-cache state (~/software-brain-data/hf-cache),\n  VM memory/earlyoom, and whether a deploy just wiped node_modules.\n\n`;
  fs.appendFileSync(openIssuesPath, entry);
}

async function reportByEmail(subject, text) {
  const key = env.RESEND_API_KEY;
  if (!key) return 'no RESEND_API_KEY — email skipped (exit code + OPEN_ISSUES.md are the report)';
  try {
    const from = env.HI_SPEED_ALERT_FROM || env.RESEND_FROM || env.ALERT_FROM_EMAIL || 'alerts@xl.net';
    const to = env.HI_SPEED_ALERT_TO || 'adam@xl.net';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? `emailed ${to}` : `email send failed: HTTP ${r.status}`;
  } catch (err) {
    return `email send failed: ${err instanceof Error ? err.message : err}`;
  }
}

try {
  const { totalMs, ttftMs } = await measure();
  const summary = `total ${Math.round(totalMs)}ms, ttft ${ttftMs === null ? 'n/a (buffered)' : Math.round(ttftMs) + 'ms'}`;
  if (totalMs <= thresholdMs) {
    console.log(`HI-SPEED PASS [${label}]: ${summary} (threshold ${thresholdMs}ms)`);
    process.exit(0);
  }
  const detail = `- Measured: ${summary} — over the ${thresholdMs}ms threshold.`;
  appendOpenIssue(detail);
  const mail = await reportByEmail(
    `[${label}] HI-SPEED BREACH: "Hi" took ${Math.round(totalMs)}ms`,
    `${detail}\nEndpoint: ${baseUrl}\nLogged to: ${openIssuesPath}\nTime: ${now.toISOString()}`,
  );
  console.error(`HI-SPEED BREACH [${label}]: ${summary} (threshold ${thresholdMs}ms)`);
  console.error(`  open-issue appended: ${openIssuesPath}`);
  console.error(`  operator report: ${mail}`);
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  appendOpenIssue(`- Probe FAILED outright: ${msg} (brain unreachable or erroring — worse than slow).`);
  const mail = await reportByEmail(`[${label}] HI-SPEED PROBE FAILED: ${msg}`, `Probe failed: ${msg}\nEndpoint: ${baseUrl}\nTime: ${now.toISOString()}`);
  console.error(`HI-SPEED PROBE FAILED [${label}]: ${msg}`);
  console.error(`  open-issue appended: ${openIssuesPath}`);
  console.error(`  operator report: ${mail}`);
  process.exit(1);
}
