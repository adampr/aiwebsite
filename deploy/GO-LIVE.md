# ai.xl.net — Go-Live Runbook

Architecture (same model as itsupportchicago):

```
caller ──► Twilio ──► https://ai.xl.net/brain/twilio/*  ─┐
visitor ─► https://ai.xl.net ────────────────────────────┤
                                                Cloudflare edge (TLS)
                                                         │
                                             cloudflared tunnel "aiwebsite"
                                                         │
                                          nginx 127.0.0.1:80 (loopback only)
                                             │                      │
                                   Next.js :3000          brain-api :3211 (/twilio/ only)
                                             │                      │
                                             └── loopback, no key ──┘
                                       (brain runs from packages/brain submodule
                                        via PM2: brain-api + skills-host)
```

Brain integration is **not API-key based**: the brain runs locally from the
`packages/brain` git submodule (PM2 apps `brain-api` on :3211 and `skills-host`
on :3213), the site calls it over loopback in open-gate mode (no
`BRAIN_API_KEYS` set). The only publicly exposed brain surface is
`/brain/twilio/` (Twilio webhooks + media-stream WebSocket), and those routes
validate `X-Twilio-Signature` themselves.

## Already done (automated)

- ✅ Cloudflare tunnel **`aiwebsite`** created
  (id `8dbfd62e-eb42-4589-8b76-d1edc77cd018`); credentials saved at
  `~/.cloudflared/aiwebsite-tunnel.json` on the dev box (deploy.sh ships them
  to the VM at `/etc/cloudflared/aiwebsite-tunnel.json`).
- ✅ Twilio number **+1 (872) 350-4325** purchased
  (SID `PN9435882fd720d7ec79108d195f4c9e39`, friendly name
  "Tron Netter - XL.net AI"). No 312/773 stock was available; 872 is the
  Chicago overlay and is the brain SDK's own fallback area code.
  Voice webhooks already point at:
  - voice: `https://ai.xl.net/brain/twilio/voice/inbound`
  - fallback: `https://ai.xl.net/brain/twilio/voice/fallback`
  - status: `https://ai.xl.net/brain/twilio/voice/status`
- ✅ Production `.env` assembled at the repo root (gitignored): DB, brain
  (postgres backend, `BRAIN_PUBLIC_URL=https://ai.xl.net/brain`,
  `BRAIN_AUDIO_MODE=xai_realtime`), OpenAI/xAI/Anthropic/Deepgram/Tavily/AA
  keys, Twilio creds + new number, Tron Netter inbound-call persona, fresh
  `SESSION_COOKIE_SECRET` / `AUTOMATION_SECRET`.
  ⚠ Provider keys were copied from `~/xldev/.env` (shared across projects).
  Consider issuing per-project keys later for billing separation.
- ✅ Site code no longer uses `BRAIN_API_KEY`; nginx config exposes only
  `/brain/twilio/` publicly; PM2 config fixed to use the brain's own `tsx`;
  drizzle migrations generated; `npm run build` verified green.

## Human steps (in order)

### 1. Add the DNS record (Cloudflare dashboard, ~1 minute)

The dev box's cloudflared cert is scoped to the **itsupportchicago.net** zone,
so `cloudflared tunnel route dns` cannot write into the xl.net zone. In the
Cloudflare dashboard:

1. **xl.net zone → DNS → Add record**:
   - Type: `CNAME`, Name: `ai`
   - Target: `8dbfd62e-eb42-4589-8b76-d1edc77cd018.cfargotunnel.com`
   - Proxy status: **Proxied** (orange cloud)
2. Cleanup: **itsupportchicago.net zone → DNS** — delete the stray CNAME
   `ai.xl.net.itsupportchicago.net` (created by a mis-zoned
   `tunnel route dns` attempt; harmless but noise).

### 2. Deploy to the VM (one command, dev box)

```bash
cd ~/aiwebsite && bash deploy/deploy.sh
```

This rsyncs the repo + submodule + `.env` + tunnel credentials to
`xladmin@52.237.160.75:/var/www/aiwebsite` and runs `deploy/setup-vm.sh`
there, which installs: build tools (for better-sqlite3/pg-native), Node 22,
PM2, Postgres (+ `aiwebsite` DB/user), nginx (loopback-only), site deps,
`packages/brain` deps, drizzle migrations, Next build, PM2 apps
(`aiwebsite`, `brain-api`, `skills-host`), and the cloudflared systemd
service using the pre-provisioned credentials — no browser login needed.

### 3. Verify

```bash
# On the VM (or via deploy.sh output):
curl -fsS http://127.0.0.1:3000/api/health   # site
curl -fsS http://127.0.0.1:3211/health       # brain
pm2 ls                                        # aiwebsite, brain-api, skills-host online
journalctl -u cloudflared -n 20               # tunnel connected

# From anywhere (DNS may take a minute):
curl -fsS https://ai.xl.net/api/health
```

- Open https://ai.xl.net and send a message to the Tron Netter chat widget.
- Call **+1 (872) 350-4325** — Tron Netter should answer with the XL.net
  greeting (voice path: Twilio → tunnel → nginx → brain-api `/twilio/ws`
  media stream → xAI realtime).

### 4. Afterwards

- Commit the pending changes (repo already stages `.gitmodules` +
  `packages/brain`; new/changed: `src/`, `deploy/`, configs).
- Optional hardening: per-project API keys; move the VM SSH password out of
  `.env` to SSH keys; `pm2 install pm2-logrotate`.

## Troubleshooting

- **Calls connect then drop** — check `pm2 logs brain-api` for
  `XAI_API_KEY` / websocket errors; confirm nginx `/brain/twilio/` block has
  the `Upgrade`/`Connection` headers (WebSocket).
- **Twilio 403 "Invalid signature"** — `BRAIN_PUBLIC_URL` must be exactly
  `https://ai.xl.net/brain` (signature is computed over
  `BRAIN_PUBLIC_URL + /twilio/...`).
- **Brain 503 / chat down** — `OPENAI_API_KEY` missing or brain-api
  restarting; `pm2 logs brain-api`, then `curl 127.0.0.1:3211/health`.
- **Tunnel up but 502** — nginx not listening on 127.0.0.1:80 or PM2 apps
  down.
